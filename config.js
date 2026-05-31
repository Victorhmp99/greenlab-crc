import 'dotenv/config'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// DATA_DIR: onde ficam banco, sessões e mídia
// Em produção (Railway/VPS), aponta para o volume persistente montado em /data
// Em desenvolvimento, usa a própria pasta do projeto
export const DATA_DIR = process.env.DATA_DIR || __dirname

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
