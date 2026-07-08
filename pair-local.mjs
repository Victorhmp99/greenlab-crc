/* ═══════════════════════════════════════════════════════════
   PAREAMENTO LOCAL POR CÓDIGO — roda no SEU PC, não na nuvem.

   Por quê: o WhatsApp rejeita pareamento por código vindo de IP
   de datacenter (Railway). De IP residencial funciona. Este script
   pareia aqui e envia as credenciais pra produção, que só mantém
   a conexão (isso a nuvem faz sem problema).

   Uso:  node pair-local.mjs <numero> "<nome>"
   Ex.:  node pair-local.mjs 5561981793632 "Recepcao"
   ═══════════════════════════════════════════════════════════ */
import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, DisconnectReason } from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'fs'
import path from 'path'

const PROD_URL   = process.env.CRC_URL    || 'https://greenlab-crc-production.up.railway.app'
const SECRET     = process.env.CRC_SECRET || 'f9bf1847495f262c9cba37d06b08ff0fbb7ff4e2b74e9fad347bedf1707e587a'
const TENANT_ID  = process.env.CRC_TENANT || '8320459c-6a66-4b35-8e98-a237209ade7b'   // Green Hub
const USER_ID    = process.env.CRC_USER   || '08282ed4-a085-47e5-9a97-295e7123b6e6'

const numero = (process.argv[2] || '').replace(/\D/g, '')
const nome   = process.argv[3] || 'Novo numero'
if (numero.length < 10) {
  console.log('Uso: node pair-local.mjs <numero com DDI+DDD> "<nome>"')
  console.log('Ex.: node pair-local.mjs 5561981793632 "Recepcao"')
  process.exit(1)
}

const logger = pino({ level: 'silent' })
const dir = './pair_tmp_' + Date.now()
fs.mkdirSync(dir, { recursive: true })

console.log(`\n📱 Pareando ${numero} (${nome})...\n`)

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(dir)
  const { version } = await fetchLatestBaileysVersion()
  const sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
  })
  sock.ev.on('creds.update', saveCreds)

  let requested = false
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && !requested && !sock.authState.creds.registered) {
      requested = true
      try {
        const code = await sock.requestPairingCode(numero)
        console.log('══════════════════════════════════════')
        console.log(`   CÓDIGO:  ${code.match(/.{1,4}/g).join('-')}`)
        console.log('══════════════════════════════════════')
        console.log('\nNo celular do número: WhatsApp → ⋮ → Dispositivos conectados')
        console.log('→ Conectar dispositivo → "Conectar com número de telefone" → digite o código\n')
        console.log('Aguardando (até 5 min)...\n')
      } catch (e) {
        console.log('❌ Erro ao gerar código:', e.message)
        process.exit(1)
      }
    }

    if (connection === 'open') {
      console.log('✅ Pareado! Enviando credenciais pra produção...')
      await new Promise(r => setTimeout(r, 3000))   // deixa as chaves terminarem de salvar
      try { sock.end?.(undefined) } catch (_) {}
      await new Promise(r => setTimeout(r, 1500))

      const files = {}
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.json')) files[f] = fs.readFileSync(path.join(dir, f)).toString('base64')
      }
      const res = await fetch(`${PROD_URL}/api/sessions/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-crc-secret': SECRET, 'x-tenant-id': TENANT_ID, 'x-user-id': USER_ID },
        body: JSON.stringify({ name: nome, tenant_id: TENANT_ID, files }),
      })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) {
        console.log('❌ Falha ao importar na produção:', out.error || res.status)
        console.log(`   (credenciais preservadas em ${dir} — dá pra reenviar)`)
        process.exit(1)
      }
      console.log(`\n🎉 PRONTO! "${nome}" conectado na nuvem (${out.id})`)
      console.log('   O número já aparece no CRC. Pode fechar esta janela.\n')
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) {}
      process.exit(0)
    }

    if (connection === 'close') {
      const c = lastDisconnect?.error?.output?.statusCode
      if (c === DisconnectReason.restartRequired) {
        // Passo normal após o celular aceitar o código — reconecta pra concluir
        connect()
      } else if (c === DisconnectReason.loggedOut) {
        console.log('❌ Deslogado pelo celular. Rode de novo.')
        process.exit(1)
      } else {
        console.log(`(conexão caiu [${c}] — tentando de novo...)`)
        setTimeout(connect, 2000)
      }
    }
  })
}

connect()
setTimeout(() => { console.log('⏱️  Tempo esgotado (5 min). Rode de novo.'); process.exit(1) }, 300000)
