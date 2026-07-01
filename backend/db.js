const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "matchpredictor.db");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    email                 TEXT    NOT NULL UNIQUE,
    address               TEXT    NOT NULL UNIQUE,
    encrypted_private_key TEXT,
    is_up                 INTEGER NOT NULL DEFAULT 0,
    created_at            INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS magic_links (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT    NOT NULL,
    token      TEXT    NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT    NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS transfer_requests (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_address TEXT    NOT NULL,
    token_ids      TEXT    NOT NULL,
    status         TEXT    NOT NULL DEFAULT 'pending',
    notes          TEXT,
    created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_magic_links_token   ON magic_links(token);
  CREATE INDEX IF NOT EXISTS idx_magic_links_email   ON magic_links(email);
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_transfer_requests_status ON transfer_requests(status);
`);

module.exports = db;
