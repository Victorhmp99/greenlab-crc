import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
} from '@whiskeysockets/baileys'
import qrcode from 'qrcode'
import pino from 'pino'
import path from 'path'
import fs from 'fs'
import { spawnSync } from 'child_process'
import os from 'os'
import { createRequire } from 'module'
import { SESSIONS_DIR, MEDIA_DIR } from '../config.js'

const _require = createRequire(import.meta.url)

// Resolve o caminho do ffmpeg: prioriza o do sistema (apt no Railway), depois ffmpeg-static
function resolveFfmpeg() {
  // 1. ffmpeg do sistema (instalado via apt no Railway/Linux)
  for (const sysPath of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    try { if (fs.existsSync(sysPath)) return sysPath } catch (_) {}
  }
  // 2. ffmpeg-static (Windows local / fallback)
  try {
    const staticPath = _require('ffmpeg-static')
    if (staticPath && fs.existsSync(staticPath)) return staticPath
  } catch (_) {}
  // 3. assume que está no PATH
  return 'ffmpeg'
}
const ffmpegPath = resolveFfmpeg()
console.log('[ffmpeg] usando:', ffmpegPath)

// Converte via arquivos temporários — evita problemas de pipe no Windows
function runFfmpeg(inputBuffer, outExt, ffArgs, label) {
  const id     = `${Date.now()}_${Math.random().toString(36).slice(2)}`
  const tmpIn  = path.join(os.tmpdir(), `crc_in_${id}`)
  const tmpOut = path.join(os.tmpdir(), `crc_out_${id}.${outExt}`)

  try {
    fs.writeFileSync(tmpIn, inputBuffer)

    const result = spawnSync(ffmpegPath, ['-y', '-i', tmpIn, ...ffArgs, tmpOut], {
      timeout:   60_000,
      maxBuffer: 100 * 1024 * 1024,
    })

    const errLog = result.stderr?.toString().trim()
    if (errLog) console.log(`[${label}]`, errLog.split('\n').slice(-2).join(' '))

    if (result.status !== 0) throw new Error(`ffmpeg exit ${result.status}`)

    const out = fs.readFileSync(tmpOut)
    if (out.length < 200) throw new Error(`saída muito pequena: ${out.length}B`)
    console.log(`[${label}] ok — ${out.length}B`)
    return out
  } finally {
    try { fs.unlinkSync(tmpIn)  } catch (_) {}
    try { fs.unlinkSync(tmpOut) } catch (_) {}
  }
}

// Wrappers async para não bloquear o event loop do Node durante conversão
function convertToOggOpus(buffer) {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try { resolve(runFfmpeg(buffer, 'ogg', [
        '-vn', '-c:a', 'libopus', '-b:a', '64k',
        '-ar', '48000', '-ac', '1', '-application', 'voip',
      ], 'ffmpeg/ogg')) }
      catch (e) { reject(e) }
    })
  })
}

// Converte qualquer áudio para MP3 (formato universal aceito pelo WhatsApp)
function convertToMp3(buffer) {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      const id     = `${Date.now()}_${Math.random().toString(36).slice(2)}`
      const tmpIn  = path.join(os.tmpdir(), `crc_min_${id}`)
      const tmpOut = path.join(os.tmpdir(), `crc_mout_${id}.mp3`)
      try {
        fs.writeFileSync(tmpIn, buffer)
        const r = spawnSync(ffmpegPath, [
          '-y', '-fflags', '+genpts', '-i', tmpIn,
          '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', '-ac', '1',
          tmpOut,
        ], { timeout: 60_000, maxBuffer: 100 * 1024 * 1024 })

        const err = r.stderr?.toString() || ''
        if (r.status !== 0) throw new Error(`ffmpeg exit ${r.status}: ${err.split('\n').slice(-2).join(' ')}`)
        if (!fs.existsSync(tmpOut) || fs.statSync(tmpOut).size < 200) throw new Error('saída vazia')

        let seconds = 0
        const times = [...err.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)]
        if (times.length) { const t = times[times.length-1]; seconds = +t[1]*3600 + +t[2]*60 + +t[3] }
        if (seconds < 0.5) seconds = Math.max(1, fs.statSync(tmpOut).size / 16000)
        seconds = Math.round(seconds)

        console.log(`[audio] MP3 ok — ${fs.statSync(tmpOut).size}B, ${seconds}s`)
        resolve({ path: tmpOut, seconds })
      } catch (e) {
        try { fs.unlinkSync(tmpOut) } catch (_) {}
        reject(e)
      } finally {
        try { fs.unlinkSync(tmpIn) } catch (_) {}
      }
    })
  })
}

// Gera uma waveform "fake" plausível de 64 bytes (0-100) para o WhatsApp exibir
function makeWaveform(len = 64) {
  const wf = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    // onda suave com variação — parece um áudio real
    wf[i] = Math.floor(30 + 40 * Math.abs(Math.sin(i / 4)) + Math.random() * 20)
  }
  return wf
}

// Converte para OGG/Opus. O WebM do navegador NÃO tem duração nos metadados,
// então re-encodamos forçando a escrita da duração e medimos pelo "time=" final.
function convertToOggFile(buffer) {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      const id     = `${Date.now()}_${Math.random().toString(36).slice(2)}`
      const tmpIn  = path.join(os.tmpdir(), `crc_ain_${id}`)
      const tmpOut = path.join(os.tmpdir(), `crc_aout_${id}.ogg`)
      try {
        fs.writeFileSync(tmpIn, buffer)
        // -fflags +genpts e re-timestamp resolvem o WebM sem duração
        const r = spawnSync(ffmpegPath, [
          '-y',
          '-fflags', '+genpts',
          '-i', tmpIn,
          '-vn',
          '-c:a', 'libopus', '-b:a', '64k',
          '-ar', '48000', '-ac', '1',
          '-application', 'voip',
          tmpOut,
        ], { timeout: 60_000, maxBuffer: 100 * 1024 * 1024 })

        const err = r.stderr?.toString() || ''
        if (r.status !== 0) throw new Error(`ffmpeg exit ${r.status}: ${err.split('\n').slice(-2).join(' ')}`)
        if (!fs.existsSync(tmpOut) || fs.statSync(tmpOut).size < 200) throw new Error('saída vazia')

        // Duração: pega o ÚLTIMO "time=HH:MM:SS.ss" do log (posição final do encode)
        let seconds = 0
        const times = [...err.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)]
        if (times.length) {
          const t = times[times.length - 1]
          seconds = +t[1]*3600 + +t[2]*60 + +t[3]
        }
        // Fallback: estima pelo tamanho (64kbps ≈ 8000 bytes/s)
        if (seconds < 0.5) seconds = Math.max(1, fs.statSync(tmpOut).size / 8000)
        seconds = Math.round(seconds)

        console.log(`[audio] OGG ok — ${fs.statSync(tmpOut).size}B, ${seconds}s`)
        resolve({ path: tmpOut, seconds })
      } catch (e) {
        try { fs.unlinkSync(tmpOut) } catch (_) {}
        reject(e)
      } finally {
        try { fs.unlinkSync(tmpIn) } catch (_) {}
      }
    })
  })
}

function convertToMp4Aac(buffer) {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try { resolve(runFfmpeg(buffer, 'm4a', [
        '-vn', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '1',
      ], 'ffmpeg/m4a')) }
      catch (e) { reject(e) }
    })
  })
}

const logger = pino({ level: 'silent' })

// Diagnóstico do último envio de áudio (exposto via /debug-audio)
export const lastAudio = { steps: [], error: null, at: null }
export const lastMsgKey = { key: null, at: null }  // estrutura da última msg recebida
function logAudio(step) {
  lastAudio.steps.push(`${new Date().toISOString().slice(11,19)} ${step}`)
  if (lastAudio.steps.length > 20) lastAudio.steps.shift()
  console.log('[audio]', step)
}

/* ── Helpers ─────────────────────────────────────────── */

const EXT_MAP = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/3gpp': '3gp',
  'audio/ogg; codecs=opus': 'ogg', 'audio/ogg': 'ogg',
  'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/webm': 'webm',
  'application/pdf': 'pdf',
}
function getExt(mime = '') {
  if (EXT_MAP[mime]) return EXT_MAP[mime]
  const base = mime.split(';')[0].split('/')[1]
  return base || 'bin'
}

function extractBody(msg) {
  const m = msg.message
  if (!m) return null
  if (m.conversation)             return m.conversation
  if (m.extendedTextMessage?.text)return m.extendedTextMessage.text
  if (m.imageMessage)             return m.imageMessage.caption || '[Imagem]'
  if (m.videoMessage)             return m.videoMessage.caption || '[Vídeo]'
  if (m.audioMessage)             return '[Áudio]'
  if (m.stickerMessage)           return '[Figurinha]'
  if (m.documentMessage)          return m.documentMessage.fileName || '[Documento]'
  if (m.locationMessage)          return '[Localização]'
  if (m.contactMessage)           return `[Contato: ${m.contactMessage.displayName}]`
  if (m.reactionMessage)          return null
  return null
}

function detectMediaType(msg) {
  const m = msg.message
  if (!m) return null
  if (m.imageMessage)    return { type: 'image',    mime: m.imageMessage.mimetype }
  if (m.videoMessage)    return { type: 'video',    mime: m.videoMessage.mimetype }
  if (m.audioMessage)    return { type: 'audio',    mime: m.audioMessage.mimetype || 'audio/ogg; codecs=opus' }
  if (m.stickerMessage)  return { type: 'sticker',  mime: m.stickerMessage.mimetype }
  if (m.documentMessage) return { type: 'document', mime: m.documentMessage.mimetype }
  return null
}

/* ── SessionManager ──────────────────────────────────── */

export class SessionManager {
  constructor(db, io) {
    this.db     = db
    this.io     = io
    this.sockets = new Map()
    this.timers  = new Map()
  }

  /* ── Restore ── */
  async restoreAll() {
    for (const s of this.db.prepare('SELECT * FROM sessions').all()) {
      if (fs.existsSync(path.join(SESSIONS_DIR, s.id))) {
        this.db.prepare("UPDATE sessions SET status='connecting' WHERE id=?").run(s.id)
        await this.connect(s.id, s.name)
      } else {
        this.db.prepare("UPDATE sessions SET status='disconnected' WHERE id=?").run(s.id)
      }
    }
  }

  /* ── Connect ── */
  async connect(sessionId, name) {
    const dir = path.join(SESSIONS_DIR, sessionId)
    fs.mkdirSync(dir, { recursive: true })

    const { state, saveCreds } = await useMultiFileAuthState(dir)
    const { version }          = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      printQRInTerminal: false,
      logger,
      browser: ['CRC Green Lab', 'Chrome', '120.0.0'],
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    })

    this.sockets.set(sessionId, sock)
    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        const img = await qrcode.toDataURL(qr)
        this.io.emit('qr', { sessionId, qr: img })
        this.db.prepare("UPDATE sessions SET status='connecting' WHERE id=?").run(sessionId)
        this.io.emit('session:update', { sessionId, status: 'connecting' })
      }
      if (connection === 'open') {
        const phone = '+' + (sock.user?.id?.split(':')[0] || '')
        this.db.prepare('UPDATE sessions SET status=?,phone=? WHERE id=?').run('connected', phone, sessionId)
        this.io.emit('session:update', { sessionId, status: 'connected', phone })
        console.log(`✅ [${name}] Conectado: ${phone}`)
      }
      if (connection === 'close') {
        const code  = lastDisconnect?.error?.output?.statusCode
        const retry = code !== DisconnectReason.loggedOut
        this.sockets.delete(sessionId)
        if (retry) {
          this.db.prepare("UPDATE sessions SET status='connecting' WHERE id=?").run(sessionId)
          this.io.emit('session:update', { sessionId, status: 'connecting' })
          this.timers.set(sessionId, setTimeout(() => this.connect(sessionId, name), 4000))
        } else {
          this.db.prepare("UPDATE sessions SET status='disconnected' WHERE id=?").run(sessionId)
          this.io.emit('session:update', { sessionId, status: 'disconnected' })
        }
      }
    })

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return
      for (const msg of messages) {
        const jid = msg.key.remoteJid
        if (!jid || jid === 'status@broadcast' || jid.endsWith('@g.us')) continue
        // Captura estrutura da chave para diagnóstico de @lid
        if (!msg.key.fromMe) {
          lastMsgKey.key = msg.key
          lastMsgKey.at  = new Date().toISOString()
        }
        this._handleMessage(sessionId, msg, sock).catch(e =>
          console.error('[msg] erro no handler:', e.message)
        )
      }
    })

    sock.ev.on('contacts.upsert', contacts => {
      for (const c of contacts) {
        if (c.name && c.id)
          this.db.prepare('UPDATE conversations SET name=? WHERE id=? AND name=phone').run(c.name, c.id)
      }
    })

    // ── Status das mensagens enviadas (enviado/entregue/lido) ──
    sock.ev.on('messages.update', updates => {
      for (const u of updates) {
        const status = u.update?.status
        if (status === undefined) continue
        // 2=enviado(servidor), 3=entregue, 4=lido, 5=reproduzido
        const map = { 2: 'sent', 3: 'delivered', 4: 'read', 5: 'read' }
        const st  = map[status]
        if (!st) continue
        const jid   = u.key.remoteJid
        const msgId = u.key.id
        this.db.prepare('UPDATE messages SET status=? WHERE id=? AND session_id=?').run(st, msgId, sessionId)
        this.io.emit('message:status', { sessionId, convId: jid, msgId, status: st })
      }
    })

    // ── Presença: digitando / gravando / online ──
    sock.ev.on('presence.update', ({ id, presences }) => {
      if (!id || !presences) return
      // Pega a presença do contato (não de grupo)
      const p = Object.values(presences)[0]
      const lastKnown = p?.lastKnownPresence  // 'composing'|'recording'|'available'|'unavailable'|'paused'
      this.io.emit('presence:update', { sessionId, convId: id, presence: lastKnown })
    })

    return sock
  }

  /* ── Handle incoming message ── */
  async _handleMessage(sessionId, msg, sock) {
    const jid    = msg.key.remoteJid
    const body   = extractBody(msg)
    if (!body) return

    const fromMe = !!msg.key.fromMe
    const ts     = new Date((msg.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString()
    const msgId  = msg.key.id
    const name   = msg.pushName || jid.split('@')[0]
    const phone  = jid.split('@')[0]
    const media  = detectMediaType(msg)

    // 1. Salva/atualiza conversa imediatamente
    const exists = this.db.prepare('SELECT id FROM conversations WHERE id=? AND session_id=?').get(jid, sessionId)
    if (exists) {
      this.db.prepare(`
        UPDATE conversations SET last_message=?,last_message_at=?,unread_count=unread_count+?
        WHERE id=? AND session_id=?
      `).run(body, ts, fromMe ? 0 : 1, jid, sessionId)
    } else {
      this.db.prepare(`
        INSERT OR IGNORE INTO conversations(id,session_id,name,phone,last_message,last_message_at,unread_count)
        VALUES(?,?,?,?,?,?,?)
      `).run(jid, sessionId, name, phone, body, ts, fromMe ? 0 : 1)
    }

    // 2. Salva mensagem imediatamente (sem media_url ainda)
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO messages(id,conversation_id,session_id,from_me,body,media_type,timestamp)
        VALUES(?,?,?,?,?,?,?)
      `).run(msgId, jid, sessionId, fromMe ? 1 : 0, body, media?.type ?? null, ts)
    } catch (_) { /* duplicata */ }

    // 3. Emite para o frontend AGORA — UI não trava
    const conversation = this._getConversation(jid, sessionId)
    this.io.emit('message:new', {
      conversation,
      message: { id: msgId, conversation_id: jid, session_id: sessionId,
                 from_me: fromMe ? 1 : 0, body, media_type: media?.type ?? null,
                 media_url: null, timestamp: ts },
    })

    // 4. Baixa mídia em background — não bloqueia nada
    if (media) {
      this._downloadMediaBg(msg, sessionId, msgId, jid, media, sock)
    }
  }

  /* ── Download de mídia em background ── */
  async _downloadMediaBg(msg, sessionId, msgId, jid, media, sock) {
    try {
      const dir = path.join(MEDIA_DIR, sessionId)
      fs.mkdirSync(dir, { recursive: true })

      // Timeout de 45s para não ficar preso
      const buffer = await Promise.race([
        downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 45_000)),
      ])

      const filename = `${msgId}.${getExt(media.mime)}`
      fs.writeFileSync(path.join(dir, filename), buffer)
      const mediaUrl = `/media/${sessionId}/${filename}`

      // Atualiza DB
      this.db.prepare('UPDATE messages SET media_url=? WHERE id=? AND session_id=?')
        .run(mediaUrl, msgId, sessionId)

      // Notifica o frontend para atualizar o balão específico
      this.io.emit('message:media', { msgId, sessionId, convId: jid, mediaType: media.type, mediaUrl })
    } catch (e) {
      console.error(`[media] download falhou (${msgId}):`, e.message)
    }
  }

  /* ── Enviar texto ── */
  async sendMessage(sessionId, jid, text) {
    const sock = this._requireSock(sessionId)
    const result = await sock.sendMessage(jid, { text })

    const msgId = result?.key?.id || `out_${Date.now()}`
    const ts    = new Date().toISOString()

    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO messages(id,conversation_id,session_id,from_me,body,timestamp)
        VALUES(?,?,?,1,?,?)
      `).run(msgId, jid, sessionId, text, ts)
      this.db.prepare('UPDATE conversations SET last_message=?,last_message_at=? WHERE id=? AND session_id=?')
        .run(text, ts, jid, sessionId)
    } catch (_) {}

    const conversation = this._getConversation(jid, sessionId)
    this.io.emit('message:new', {
      conversation,
      message: { id: msgId, conversation_id: jid, session_id: sessionId,
                 from_me: 1, body: text, media_type: null, media_url: null, timestamp: ts },
    })
    return result
  }

  /* ── Enviar mídia ── */
  async sendMedia(sessionId, jid, file, caption = '') {
    const sock = this._requireSock(sessionId)
    const { buffer, originalname } = file
    // Usa o mimetype real do arquivo — sem forçar OGG quando é WebM
    const mime = file.mimetype

    let msgContent, mediaType, body
    let audioTmpFile = null  // arquivo OGG temporário, limpo após o envio

    if (mime.startsWith('image/')) {
      msgContent = { image: buffer, caption, mimetype: mime }
      mediaType  = 'image'
      body       = caption || '[Imagem]'
    } else if (mime.startsWith('video/')) {
      msgContent = { video: buffer, caption, mimetype: mime }
      mediaType  = 'video'
      body       = caption || '[Vídeo]'
    } else if (mime.startsWith('audio/')) {
      mediaType = 'audio'
      body      = '[Áudio 🎵]'
      lastAudio.steps = []; lastAudio.error = null; lastAudio.at = new Date().toISOString()
      logAudio(`recebido mime=${mime} size=${buffer.length}B ffmpeg=${ffmpegPath}`)
      try {
        // Converte para MP3 — formato de áudio mais aceito universalmente pelo WhatsApp
        const mp3 = await convertToMp3(buffer)
        const mp3Buffer = fs.readFileSync(mp3.path)
        audioTmpFile = mp3.path
        logAudio(`convertido MP3 ${mp3Buffer.length}B ${mp3.seconds}s`)
        msgContent = {
          audio:    mp3Buffer,
          mimetype: 'audio/mpeg',
          ptt:      false,
          seconds:  mp3.seconds,
        }
      } catch (e1) {
        lastAudio.error = 'conversao: ' + e1.message
        logAudio('CONVERSAO FALHOU: ' + e1.message)
        msgContent = { document: buffer, mimetype: mime, fileName: originalname || `audio.${getExt(mime)}` }
      }
    } else {
      msgContent = { document: buffer, mimetype: mime, fileName: originalname }
      mediaType  = 'document'
      body       = originalname || '[Documento]'
    }

    let result
    const isAudio = mediaType === 'audio'
    try {
      if (isAudio) logAudio(`enviando Baileys tipo=${Object.keys(msgContent)[0]} ptt=${msgContent.ptt}`)
      result = await sock.sendMessage(jid, msgContent)
      if (isAudio) logAudio(`ENVIADO ok msgId=${result?.key?.id}`)
    } catch (sendErr) {
      if (isAudio) { lastAudio.error = 'envio: ' + sendErr.message; logAudio('ENVIO FALHOU: ' + sendErr.message) }
      console.error('[sendMedia] ERRO sock.sendMessage:', sendErr.message)
      const fallback = { document: buffer, mimetype: mime, fileName: originalname || `arquivo.${getExt(mime)}` }
      result = await sock.sendMessage(jid, fallback)
    }
    const msgId  = result?.key?.id || `out_${Date.now()}`
    const ts     = new Date().toISOString()

    // Salva o arquivo localmente para o chat mostrar
    const dir = path.join(MEDIA_DIR, sessionId)
    fs.mkdirSync(dir, { recursive: true })
    // Para áudio convertido, salva o arquivo convertido (mp3); senão o buffer original
    const isConvAudio = mediaType === 'audio' && audioTmpFile
    const filename    = `${msgId}.${isConvAudio ? 'mp3' : getExt(mime)}`
    if (isConvAudio) {
      try { fs.copyFileSync(audioTmpFile, path.join(dir, filename)) }
      catch (_) { fs.writeFileSync(path.join(dir, filename), buffer) }
    } else {
      fs.writeFileSync(path.join(dir, filename), buffer)
    }
    const mediaUrl = `/media/${sessionId}/${filename}`
    // Limpa o arquivo temporário de conversão
    if (audioTmpFile) { try { fs.unlinkSync(audioTmpFile) } catch (_) {} }

    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO messages(id,conversation_id,session_id,from_me,body,media_type,media_url,timestamp)
        VALUES(?,?,?,1,?,?,?,?)
      `).run(msgId, jid, sessionId, body, mediaType, mediaUrl, ts)
      this.db.prepare('UPDATE conversations SET last_message=?,last_message_at=? WHERE id=? AND session_id=?')
        .run(body, ts, jid, sessionId)
    } catch (_) {}

    const conversation = this._getConversation(jid, sessionId)
    this.io.emit('message:new', {
      conversation,
      message: { id: msgId, conversation_id: jid, session_id: sessionId,
                 from_me: 1, body, media_type: mediaType, media_url: mediaUrl, timestamp: ts },
    })
    return result
  }

  /* ── Foto de perfil ── */
  async getProfilePicture(sessionId, jid) {
    const sock = this.sockets.get(sessionId)
    if (!sock) return null
    try { return await sock.profilePictureUrl(jid, 'image') } catch (_) {
      try { return await sock.profilePictureUrl(jid, 'preview') } catch (_) { return null }
    }
  }

  /* ── Disconnect ── */
  async disconnect(sessionId) {
    clearTimeout(this.timers.get(sessionId))
    this.timers.delete(sessionId)
    const sock = this.sockets.get(sessionId)
    if (sock) {
      try { await sock.logout() } catch (_) {}
      this.sockets.delete(sessionId)
    }
    try { fs.rmSync(path.join(SESSIONS_DIR, sessionId), { recursive: true, force: true }) } catch (_) {}
  }

  /* ── Marcar conversa como lida + assinar presença ── */
  async openChat(sessionId, jid) {
    const sock = this.sockets.get(sessionId)
    if (!sock) return
    try {
      // Assina updates de presença (digitando) deste contato
      await sock.presenceSubscribe(jid)
    } catch (_) {}
    try {
      // Marca as mensagens recebidas como lidas (✓✓ azul para o contato)
      const msgs = this.db.prepare(
        'SELECT id FROM messages WHERE conversation_id=? AND session_id=? AND from_me=0 ORDER BY timestamp DESC LIMIT 20'
      ).all(jid, sessionId)
      if (msgs.length) {
        const keys = msgs.map(m => ({ remoteJid: jid, id: m.id, fromMe: false }))
        await sock.readMessages(keys)
      }
    } catch (_) {}
  }

  /* ── Internos ── */
  _requireSock(sessionId) {
    const sock = this.sockets.get(sessionId)
    if (!sock) throw new Error('Sessão não conectada. Verifique o QR Code.')
    return sock
  }

  _getConversation(jid, sessionId) {
    return this.db.prepare(`
      SELECT c.*,s.name as session_name,s.phone as session_phone
      FROM conversations c JOIN sessions s ON c.session_id=s.id
      WHERE c.id=? AND c.session_id=?
    `).get(jid, sessionId)
  }
}
