import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Carrega o .env relativo a ESTA pasta (crc-service), não ao cwd de quem
// iniciou o processo — 'dotenv/config' padrão depende do cwd e falha
// silenciosamente se o servidor for iniciado de outro diretório.
dotenv.config({ path: path.join(__dirname, '.env') })

// DATA_DIR: onde ficam banco, sessões e mídia
// Prioridade:
//   1. process.env.DATA_DIR (se definido)
//   2. /data se existir (volume Railway/VPS montado) — detecção automática
//   3. pasta do projeto (desenvolvimento local)
function resolveDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR
  // Detecta volume persistente montado em /data
  try {
    if (fs.existsSync('/data')) {
      // Testa se é gravável
      fs.accessSync('/data', fs.constants.W_OK)
      return '/data'
    }
  } catch (_) { /* não gravável, cai no fallback */ }
  return __dirname
}

export const DATA_DIR = resolveDataDir()
console.log('[config] DATA_DIR =', DATA_DIR)

// Garante que os subdiretórios existem
for (const dir of ['sessions', 'media']) {
  fs.mkdirSync(path.join(DATA_DIR, dir), { recursive: true })
}

export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions')
export const MEDIA_DIR    = path.join(DATA_DIR, 'media')
export const PORT         = parseInt(process.env.PORT || '3001', 10)
export const ORIGIN       = process.env.ALLOWED_ORIGIN || '*'
export const IS_PROD      = process.env.NODE_ENV === 'production'

// Mesmo projeto Supabase do CRM — login do CRC usa a mesma conta/senha,
// e o acesso a cada empresa vem de user_memberships (RLS), não de header.
export const SUPABASE_URL      = process.env.SUPABASE_URL || ''
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || ''
