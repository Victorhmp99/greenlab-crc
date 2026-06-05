import { DatabaseSync } from 'node:sqlite'
import path from 'path'
import { DATA_DIR } from '../config.js'

export function initDB() {
  const db = new DatabaseSync(path.join(DATA_DIR, 'crc.db'))

  db.exec(`PRAGMA journal_mode = WAL`)
  db.exec(`PRAGMA foreign_keys = ON`)

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      phone      TEXT,
      status     TEXT DEFAULT 'disconnected',
      tenant_id  TEXT DEFAULT 'default',
      created_by TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id              TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      name            TEXT,
      phone           TEXT,
      last_message    TEXT,
      last_message_at TEXT,
      unread_count    INTEGER DEFAULT 0,
      profile_pic     TEXT,
      PRIMARY KEY (id, session_id),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      from_me         INTEGER DEFAULT 0,
      body            TEXT,
      media_type      TEXT,
      media_url       TEXT,
      timestamp       TEXT,
      status          TEXT DEFAULT 'sent',
      PRIMARY KEY (id, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_msg_conv
      ON messages(conversation_id, session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_conv_session
      ON conversations(session_id, last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_msg_timestamp
      ON messages(timestamp);
  `)

  for (const col of [
    `ALTER TABLE conversations ADD COLUMN profile_pic TEXT`,
    `ALTER TABLE messages ADD COLUMN media_url TEXT`,
    `ALTER TABLE sessions ADD COLUMN tenant_id TEXT DEFAULT 'default'`,
    `ALTER TABLE sessions ADD COLUMN created_by TEXT DEFAULT ''`,
  ]) {
    try { db.exec(col) } catch (_) { /* coluna já existe */ }
  }

  return db
}
