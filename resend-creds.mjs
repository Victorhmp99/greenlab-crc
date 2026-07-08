/* Reenvia credenciais já pareadas (pasta pair_tmp_*) pra produção.
   Uso: node resend-creds.mjs <pasta> "<nome>" */
import fs from 'fs'
import path from 'path'

const PROD_URL  = process.env.CRC_URL    || 'https://greenlab-crc-production.up.railway.app'
const SECRET    = process.env.CRC_SECRET || 'f9bf1847495f262c9cba37d06b08ff0fbb7ff4e2b74e9fad347bedf1707e587a'
const TENANT_ID = process.env.CRC_TENANT || '8320459c-6a66-4b35-8e98-a237209ade7b'
const USER_ID   = process.env.CRC_USER   || '08282ed4-a085-47e5-9a97-295e7123b6e6'

const dir  = process.argv[2]
const nome = process.argv[3] || 'Novo numero'
if (!dir || !fs.existsSync(dir)) { console.log('pasta não encontrada:', dir); process.exit(1) }

const files = {}
for (const f of fs.readdirSync(dir)) {
  if (f.endsWith('.json')) files[f] = fs.readFileSync(path.join(dir, f)).toString('base64')
}
console.log(`Enviando ${Object.keys(files).length} arquivos...`)

const res = await fetch(`${PROD_URL}/api/sessions/import`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-crc-secret': SECRET, 'x-tenant-id': TENANT_ID, 'x-user-id': USER_ID },
  body: JSON.stringify({ name: nome, tenant_id: TENANT_ID, files }),
})
const out = await res.json().catch(() => ({}))
if (!res.ok) { console.log('❌ Falha:', out.error || res.status); process.exit(1) }
console.log(`🎉 PRONTO! "${nome}" conectado na nuvem (${out.id})`)
fs.rmSync(dir, { recursive: true, force: true })
