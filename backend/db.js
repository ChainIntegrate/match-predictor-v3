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
    display_name          TEXT,
    terms_accepted        INTEGER NOT NULL DEFAULT 0,
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

  -- Gruppi/campionati privati tra amici.
  -- Ogni utente può creare max 3 gruppi e partecipare a max 5.
  -- Il link di invito è un codice univoco casuale (6 caratteri uppercase).
  CREATE TABLE IF NOT EXISTS groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    description TEXT,
    created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invite_code TEXT    NOT NULL UNIQUE,
    max_members INTEGER NOT NULL DEFAULT 50,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- Membri di un gruppo (include anche il creatore).
  CREATE TABLE IF NOT EXISTS group_members (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(group_id, user_id)
  );

  -- Partite escluse dalla classifica di un gruppo specifico.
  -- Se assente, il gruppo usa tutte le partite della piattaforma.
  CREATE TABLE IF NOT EXISTS group_excluded_matches (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id          INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    contract_match_id INTEGER NOT NULL,
    UNIQUE(group_id, contract_match_id)
  );

  CREATE INDEX IF NOT EXISTS idx_magic_links_token        ON magic_links(token);
  CREATE INDEX IF NOT EXISTS idx_magic_links_email        ON magic_links(email);
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user      ON refresh_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_transfer_requests_status ON transfer_requests(status);
  CREATE INDEX IF NOT EXISTS idx_group_members_user       ON group_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_group_members_group      ON group_members(group_id);
`);

module.exports = db;
