import 'dotenv/config'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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
export const SECRET       = process.env.CRC_SECRET || ''
export const ORIGIN       = process.env.ALLOWED_ORIGIN || '*'
export const IS_PROD      = process.env.NODE_ENV === 'production'
