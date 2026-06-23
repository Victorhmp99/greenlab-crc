/* ── Silencia o ruído verboso do libsignal ──
   O libsignal (criptografia do WhatsApp) escreve direto no console, ignorando
   o logger do Baileys. Isso inundava o stdout com dumps de SessionEntry e
   travava o event loop (health levava 16s, leads não carregavam).
   Filtramos só essas linhas de ruído — logs próprios do app passam normal. */
const _log = console.log.bind(console)
const _err = console.error.bind(console)
const NOISE = /Closing session|Closing open session|in favor of incoming|prekey bundle|SessionEntry|Removing old closed session|^\s*(_chains|registrationId|currentRatchet|indexInfo|pubKey|privKey|rootKey|baseKey|chainKey|ephemeralKeyPair)/
function isNoise(args) {
  for (const a of args) {
    if (typeof a === 'string' && NOISE.test(a)) return true
    // dumps de objeto de sessão do libsignal
    if (a && typeof a === 'object' && (a._chains || a.currentRatchet || a.indexInfo)) return true
  }
  return false
}
console.log   = (...a) => { if (!isNoise(a)) _log(...a) }
console.error = (...a) => { if (!isNoise(a)) _err(...a) }

process.on('uncaughtException',  err => _err('[crash] uncaughtException:', err.message))
process.on('unhandledRejection', err => _err('[crash] unhandledRejection:', err?.message ?? err))

import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import { fileURLToPath } from 'url'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { initDB } from './database/db.js'
import { SessionManager } from './whatsapp/sessionManager.js'
import { PORT, SECRET, ORIGIN, IS_PROD, MEDIA_DIR } from './config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

if (IS_PROD && !SECRET) {
  console.warn('AVISO: CRC_SECRET não definido — API rodando sem autenticação!')
}

const app        = express()
const httpServer = createServer(app)
const io         = new Server(httpServer, {
  cors: { origin: IS_PROD ? ORIGIN : '*', credentials: true },
})

app.disable('x-powered-by')   // não revela o stack (Express)

// Cabeçalhos básicos de segurança
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('Referrer-Policy', 'no-referrer')
  next()
})

app.use(express.json({ limit: '1mb' }))
// index:false → não serve index.html automático, deixa o catch-all injetar o secret
app.use(express.static(path.join(__dirname, 'public'), { index: false }))
app.use('/media', express.static(MEDIA_DIR, { maxAge: '7d' }))

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 64 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /^(image|video|audio|application)\//
    cb(null, allowed.test(file.mimetype))
  },
})

const db = initDB()
const sm = new SessionManager(db, io)
sm.restoreAll().catch(console.error)
sm.startCleanupSchedule()   // limpeza periódica de mídia/mensagens antigas

/* ── Socket.io: salas por empresa (escopo dos eventos) ──
   Cada navegador entra nas salas das empresas a que tem acesso.
   Assim QR/mensagens de uma empresa NÃO vazam para outras. */
io.on('connection', (socket) => {
  socket.on('join', (payload) => {
    // valida o secret em produção antes de entrar nas salas
    if (IS_PROD && SECRET && payload?.secret !== SECRET) return
    const ids = String(payload?.tenants || '')
      .split(',').map((s) => s.trim()).filter(Boolean)
    for (const id of ids) socket.join(`tenant:${id}`)
  })
})

/* ── Autenticação ──────────────────────────────────────────── */

// Em produção, todo request precisa do cabeçalho x-crc-secret
function requireAuth(req, res, next) {
  if (!IS_PROD || !SECRET) return next()
  if (req.headers['x-crc-secret'] !== SECRET) {
    return res.status(401).json({ error: 'Não autorizado' })
  }
  next()
}

app.use('/api', requireAuth)

/* ── Helpers de tenant ─────────────────────────────────────── */

function getTenants(req) {
  const raw = req.headers['x-tenant-id'] || req.query.tenant_id || 'none'
  if (raw === 'none') return []
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}

function buildTenantFilter(tenants, params, col = 'tenant_id') {
  if (!tenants.length) return ' AND 1=0'
  if (tenants.length === 1) { params.push(tenants[0]); return ` AND ${col} = ?` }
  params.push(...tenants)
  return ` AND ${col} IN (${tenants.map(() => '?').join(',')})`
}

function getUserId(req) {
  return (req.headers['x-user-id'] || req.query.user_id || '').trim()
}

// Verifica se o usuário é dono da sessão
function assertOwner(sessionId, userId, res) {
  if (!userId) { res.status(401).json({ error: 'user_id obrigatório' }); return false }
  const s = db.prepare('SELECT created_by FROM sessions WHERE id = ?').get(sessionId)
  if (!s) { res.status(404).json({ error: 'Sessão não encontrada' }); return false }
  if (s.created_by && s.created_by !== userId) {
    res.status(403).json({ error: 'Sem permissão para esta sessão' }); return false
  }
  return true
}

/* ── Sessions ─────────────────────────────────────────────── */

app.get('/api/sessions', (req, res) => {
  const tenants = getTenants(req)
  const params  = []
  const filter  = buildTenantFilter(tenants, params, 'tenant_id')
  res.json(db.prepare(`SELECT * FROM sessions WHERE 1=1${filter} ORDER BY tenant_id, created_at`).all(...params))
})

app.post('/api/sessions', async (req, res) => {
  const { name, tenant_id: bodyTenant } = req.body
  const tenants    = getTenants(req)
  const tenant     = bodyTenant || (tenants.length ? tenants[0] : 'default')
  const created_by = getUserId(req)
  if (!name?.trim()) return res.status(400).json({ error: 'Nome obrigatório' })

  // Valida que o tenant pertence ao usuário
  if (tenant !== 'default' && tenants.length && !tenants.includes(tenant)) {
    return res.status(403).json({ error: 'Tenant não autorizado' })
  }

  // Limite de números por empresa (anti-abuso de recursos)
  const MAX_SESSIONS_PER_TENANT = 10
  const count = db.prepare('SELECT COUNT(*) as n FROM sessions WHERE tenant_id = ?').get(tenant).n
  if (count >= MAX_SESSIONS_PER_TENANT) {
    return res.status(429).json({ error: `Limite de ${MAX_SESSIONS_PER_TENANT} números por empresa atingido` })
  }

  const id = `session_${Date.now()}`
  db.prepare("INSERT INTO sessions (id, name, status, tenant_id, created_by) VALUES (?, ?, 'connecting', ?, ?)").run(id, name.trim(), tenant, created_by)
  sm.connect(id, name.trim()).catch(console.error)
  res.json({ id, name: name.trim(), status: 'connecting', tenant_id: tenant, created_by })
})

// Reconecta uma sessão existente (após QR expirar / cair)
app.post('/api/sessions/:id/reconnect', async (req, res) => {
  const userId = getUserId(req)
  if (!assertOwner(req.params.id, userId, res)) return
  const s = db.prepare('SELECT name FROM sessions WHERE id = ?').get(req.params.id)
  if (!s) return res.status(404).json({ error: 'Sessão não encontrada' })
  sm.reconnect(req.params.id, s.name).catch(console.error)
  res.json({ ok: true })
})

app.delete('/api/sessions/:id', async (req, res) => {
  const userId = getUserId(req)
  if (!assertOwner(req.params.id, userId, res)) return
  await sm.disconnect(req.params.id)
  db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

app.delete('/api/sessions/:id/conversations', (req, res) => {
  const userId = getUserId(req)
  if (!assertOwner(req.params.id, userId, res)) return
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(req.params.id)
  db.prepare('DELETE FROM conversations WHERE session_id = ?').run(req.params.id)
  res.json({ ok: true })
})

app.post('/api/sessions/:id/claim', (req, res) => {
  const userId  = getUserId(req)
  if (!userId) return res.status(400).json({ error: 'user_id obrigatório' })
  const session = db.prepare('SELECT created_by, tenant_id FROM sessions WHERE id = ?').get(req.params.id)
  if (!session) return res.status(404).json({ error: 'Sessão não encontrada' })

  // Verifica que o tenant da sessão pertence ao usuário
  const tenants = getTenants(req)
  if (tenants.length && !tenants.includes(session.tenant_id)) {
    return res.status(403).json({ error: 'Sem permissão' })
  }

  if (!session.created_by) {
    db.prepare('UPDATE sessions SET created_by = ? WHERE id = ?').run(userId, req.params.id)
  }
  res.json({ ok: true, created_by: session.created_by || userId })
})

/* ── Conversations ────────────────────────────────────────── */

app.get('/api/conversations', (req, res) => {
  const { session_id, search } = req.query
  const tenants = getTenants(req)
  const params  = []
  let sql = `
    SELECT c.*, s.name as session_name, s.phone as session_phone, s.status as session_status, s.tenant_id
    FROM conversations c JOIN sessions s ON c.session_id = s.id WHERE 1=1
  `
  sql += buildTenantFilter(tenants, params, 's.tenant_id')
  if (session_id) { sql += ' AND c.session_id = ?'; params.push(session_id) }
  if (search)     { sql += ' AND (c.name LIKE ? OR c.phone LIKE ?)'; params.push(`%${search}%`, `%${search}%`) }
  sql += ' ORDER BY c.last_message_at DESC LIMIT 150'
  res.json(db.prepare(sql).all(...params))
})

// Apaga UMA conversa do CRC (não afeta o WhatsApp) — conversa + mensagens locais
app.delete('/api/conversations/:jid', (req, res) => {
  const { session_id } = req.query
  if (!session_id) return res.status(400).json({ error: 'session_id obrigatório' })
  const tenants = getTenants(req)
  if (tenants.length) {
    const s = db.prepare('SELECT tenant_id FROM sessions WHERE id = ?').get(session_id)
    if (!s || !tenants.includes(s.tenant_id)) return res.status(403).json({ error: 'Sem permissão' })
  }
  db.prepare('DELETE FROM messages WHERE conversation_id = ? AND session_id = ?').run(req.params.jid, session_id)
  db.prepare('DELETE FROM conversations WHERE id = ? AND session_id = ?').run(req.params.jid, session_id)
  res.json({ ok: true })
})

// Apaga TODAS as conversas do CRC das empresas do usuário (ou de uma sessão, se session_id) — não afeta o WhatsApp
app.delete('/api/conversations', (req, res) => {
  const { session_id } = req.query
  const tenants = getTenants(req)

  if (session_id) {
    if (tenants.length) {
      const s = db.prepare('SELECT tenant_id FROM sessions WHERE id = ?').get(session_id)
      if (!s || !tenants.includes(s.tenant_id)) return res.status(403).json({ error: 'Sem permissão' })
    }
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(session_id)
    db.prepare('DELETE FROM conversations WHERE session_id = ?').run(session_id)
    return res.json({ ok: true })
  }

  // Sem session_id → apaga de todas as sessões das empresas do usuário
  if (!tenants.length) return res.status(400).json({ error: 'sem empresas' })
  const sessIds = db.prepare(
    `SELECT id FROM sessions WHERE tenant_id IN (${tenants.map(() => '?').join(',')})`
  ).all(...tenants).map(r => r.id)
  for (const sid of sessIds) {
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(sid)
    db.prepare('DELETE FROM conversations WHERE session_id = ?').run(sid)
  }
  res.json({ ok: true, sessions: sessIds.length })
})

/* ── Foto de perfil ────────────────────────────────────────── */

app.get('/api/conversations/:jid/profile-picture', async (req, res) => {
  const { session_id } = req.query
  if (!session_id) return res.status(400).json({ error: 'session_id obrigatório' })

  // Verifica que a sessão pertence a um dos tenants do usuário
  const tenants = getTenants(req)
  if (tenants.length) {
    const s = db.prepare('SELECT tenant_id FROM sessions WHERE id = ?').get(session_id)
    if (!s || !tenants.includes(s.tenant_id)) return res.json({ url: null })
  }

  const url = await sm.getProfilePicture(session_id, req.params.jid)
  res.json({ url: url ?? null })
})

/* ── Messages ─────────────────────────────────────────────── */

app.get('/api/conversations/:jid/messages', (req, res) => {
  const { session_id } = req.query
  if (!session_id) return res.status(400).json({ error: 'session_id obrigatório' })

  // Verifica que a sessão pertence a um dos tenants do usuário
  const tenants = getTenants(req)
  if (tenants.length) {
    const s = db.prepare('SELECT tenant_id FROM sessions WHERE id = ?').get(session_id)
    if (!s || !tenants.includes(s.tenant_id)) return res.json([])
  }

  const msgs = db.prepare(`
    SELECT * FROM messages WHERE conversation_id = ? AND session_id = ?
    ORDER BY timestamp ASC LIMIT 300
  `).all(req.params.jid, session_id)
  db.prepare('UPDATE conversations SET unread_count = 0 WHERE id = ? AND session_id = ?').run(req.params.jid, session_id)
  // Marca como lido no WhatsApp e assina presença (digitando) — não bloqueia
  sm.openChat(session_id, req.params.jid).catch(() => {})
  res.json(msgs)
})

app.post('/api/conversations/:jid/messages', async (req, res) => {
  const { body, session_id } = req.body
  if (!body?.trim() || !session_id) return res.status(400).json({ error: 'body e session_id obrigatórios' })
  // Limite de tamanho (WhatsApp ~65k; cap defensivo)
  if (body.length > 10000) return res.status(400).json({ error: 'Mensagem muito longa (máx. 10.000 caracteres)' })

  const tenants = getTenants(req)
  if (tenants.length) {
    const s = db.prepare('SELECT tenant_id FROM sessions WHERE id = ?').get(session_id)
    if (!s || !tenants.includes(s.tenant_id)) return res.status(403).json({ error: 'Sem permissão' })
  }

  try {
    await sm.sendMessage(session_id, req.params.jid, body.trim())
    res.json({ ok: true })
  } catch (e) {
    console.error('[sendMessage] ERRO:', e.message)
    res.status(500).json({ error: e.message })
  }
})

/* ── Envio de mídia ────────────────────────────────────────── */

app.post('/api/conversations/:jid/media', upload.single('file'), async (req, res) => {
  const { session_id, caption } = req.body
  if (!req.file)   return res.status(400).json({ error: 'Arquivo não recebido' })
  if (!session_id) return res.status(400).json({ error: 'session_id obrigatório' })

  const tenants = getTenants(req)
  if (tenants.length) {
    const s = db.prepare('SELECT tenant_id FROM sessions WHERE id = ?').get(session_id)
    if (!s || !tenants.includes(s.tenant_id)) return res.status(403).json({ error: 'Sem permissão' })
  }

  console.log('[media] jid:', req.params.jid, '| session:', session_id, '| mime:', req.file.mimetype, '| size:', req.file.size)
  try {
    await sm.sendMedia(session_id, req.params.jid, {
      buffer: req.file.buffer, mimetype: req.file.mimetype, originalname: req.file.originalname || 'arquivo',
    }, caption || '')
    res.json({ ok: true })
  } catch (e) {
    console.error('[media] erro:', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.get('/health', (_req, res) => res.json({ ok: true }))

app.get('*', (_req, res) => {
  // Injeta o secret na meta tag para autenticação do frontend
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
  const injected = html.replace(
    '<meta charset="UTF-8" />',
    `<meta charset="UTF-8" />\n  <meta name="crc-secret" content="${SECRET}" />`
  )
  res.setHeader('Content-Type', 'text/html')
  res.send(injected)
})

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🟢  CRC Green Lab rodando na porta ${PORT}  [${IS_PROD ? 'PRODUÇÃO' : 'desenvolvimento'}]\n`)
})
