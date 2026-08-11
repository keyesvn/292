"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { decryptLegacyXor, encryptText } = require("./security");

function openDatabase(filename = ":memory:") {
  if (filename !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY,
      plan TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','locked')),
      activated_at TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT
    );
    CREATE TABLE IF NOT EXISTS account_keys (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
      key_hash TEXT NOT NULL UNIQUE,
      key_hint TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
      uid TEXT NOT NULL UNIQUE,
      last_seen_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      last_sequence INTEGER NOT NULL DEFAULT 0,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS commands (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('lock','force_logout')),
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      acked_at TEXT,
      generation INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id INTEGER PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      csrf_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY,
      event TEXT NOT NULL,
      account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
      proton_account_id INTEGER,
      uid_hint TEXT,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id, revoked_at);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit(created_at DESC);
  `);

  const addColumn = (table, definition) => {
    const name = definition.split(/\s+/, 1)[0];
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    }
  };

  // Rebuild is required because SQLite cannot drop the table-level UNIQUE
  // constraints on account_id/uid. Keep IDs unchanged so session FKs remain valid.
  const deviceColumns = db.prepare("PRAGMA table_info(devices)").all();
  const hasReleasedAt = deviceColumns.some((column) => column.name === "released_at");
  const hasLegacyUnique = db.prepare("PRAGMA index_list(devices)").all().some((index) => {
    if (!index.unique || index.partial) return false;
    const columns = db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all().map((column) => column.name);
    return columns.length === 1 && (columns[0] === "account_id" || columns[0] === "uid");
  });
  if (!hasReleasedAt || hasLegacyUnique) {
    db.exec("PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON; BEGIN IMMEDIATE;");
    try {
      db.exec(`
        ALTER TABLE devices RENAME TO devices_legacy;
        CREATE TABLE devices (
          id INTEGER PRIMARY KEY,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          uid TEXT NOT NULL,
          last_seen_at TEXT,
          created_at TEXT NOT NULL,
          released_at TEXT
        );
        INSERT INTO devices(id,account_id,uid,last_seen_at,created_at,released_at)
          SELECT id,account_id,uid,last_seen_at,created_at,${hasReleasedAt ? "released_at" : "NULL"} FROM devices_legacy;
        DROP TABLE devices_legacy;
        CREATE UNIQUE INDEX ux_devices_current_uid ON devices(uid) WHERE released_at IS NULL;
        CREATE UNIQUE INDEX ux_devices_current_account ON devices(account_id) WHERE released_at IS NULL;
        COMMIT;
      `);
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    } finally {
      db.exec("PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON;");
    }
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_devices_current_uid ON devices(uid) WHERE released_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_devices_current_account ON devices(account_id) WHERE released_at IS NULL;
    CREATE TRIGGER IF NOT EXISTS prevent_account_delete
      BEFORE DELETE ON accounts BEGIN
        SELECT RAISE(ABORT, 'issued accounts cannot be deleted');
      END;
    CREATE TRIGGER IF NOT EXISTS prevent_account_key_delete
      BEFORE DELETE ON account_keys BEGIN
        SELECT RAISE(ABORT, 'issued keys cannot be deleted');
      END;
    CREATE TRIGGER IF NOT EXISTS prevent_account_key_replacement
      BEFORE UPDATE OF account_id, key_hash ON account_keys
      WHEN NEW.account_id <> OLD.account_id OR NEW.key_hash <> OLD.key_hash BEGIN
        SELECT RAISE(ABORT, 'issued keys cannot be replaced');
      END;
  `);
  const foreignKeyErrors = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyErrors.length) throw new Error("Migration devices làm hỏng foreign key.");

  addColumn("accounts", "generation INTEGER NOT NULL DEFAULT 0");
  addColumn("accounts", "archived_at TEXT");
  addColumn("accounts", "name TEXT NOT NULL DEFAULT ''");
  addColumn("accounts", "enabled INTEGER NOT NULL DEFAULT 1");
  addColumn("account_keys", "full_key TEXT");
  // Trước đây full_key được gán = key_hint (một chuỗi bị rút gọn, KHÔNG phải key
  // thật) nên "copy key" trả về giá trị vô dụng. Dọn các giá trị đó, và chuyển
  // các key XOR cũ sang AES-GCM nếu KEY_ENCRYPTION_SECRET đã được cấu hình.
  try { db.prepare("UPDATE account_keys SET full_key=NULL WHERE full_key IS NOT NULL AND full_key NOT LIKE 'gcm:%' AND full_key NOT LIKE 'enc:%'").run(); } catch {}
  try {
    for (const row of db.prepare("SELECT id, full_key FROM account_keys WHERE full_key LIKE 'enc:%'").all()) {
      const plaintext = decryptLegacyXor(row.full_key);
      const migrated = plaintext ? encryptText(plaintext) : "";
      db.prepare("UPDATE account_keys SET full_key=? WHERE id=?").run(migrated || null, row.id);
    }
  } catch {}
  addColumn("sessions", "generation INTEGER NOT NULL DEFAULT 0");
  addColumn("commands", "acked_at TEXT");
  addColumn("commands", "generation INTEGER NOT NULL DEFAULT 0");
  addColumn("audit", "proton_account_id INTEGER");
  db.exec(`
    CREATE TABLE IF NOT EXISTS proton_accounts (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      cookie_encrypted TEXT NOT NULL,
      uid TEXT NOT NULL UNIQUE,
      password_encrypted TEXT NOT NULL DEFAULT '',
      app_version TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proton_rentals (
      session_uid TEXT PRIMARY KEY,
      account_id INTEGER REFERENCES proton_accounts(id) ON DELETE RESTRICT,
      customer TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_proton_rentals_account ON proton_rentals(account_id);
    CREATE INDEX IF NOT EXISTS idx_proton_rentals_expiry ON proton_rentals(expires_at);
    CREATE TABLE IF NOT EXISTS gpm_sub_license_terms (
      sub_license_uuid TEXT PRIMARY KEY,
      license_uuid TEXT NOT NULL,
      starts_at TEXT,
      expires_at TEXT,
      term_days INTEGER NOT NULL CHECK(term_days > 0),
      auto_exchange INTEGER NOT NULL DEFAULT 1 CHECK(auto_exchange IN (0,1)),
      last_exchange_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gpm_terms_expiry ON gpm_sub_license_terms(expires_at);
    CREATE INDEX IF NOT EXISTS idx_gpm_terms_auto_expiry ON gpm_sub_license_terms(auto_exchange, expires_at);
  `);
  addColumn("proton_accounts", "email TEXT NOT NULL DEFAULT ''");
  addColumn("gpm_sub_license_terms", "display_name TEXT NOT NULL DEFAULT ''");
  db.exec("CREATE INDEX IF NOT EXISTS idx_commands_pending ON commands(account_id, generation, acked_at, id)");
  const finalForeignKeyErrors = db.prepare("PRAGMA foreign_key_check").all();
  if (finalForeignKeyErrors.length) throw new Error("Migration Proton làm hỏng foreign key.");
  return db;
}

module.exports = { openDatabase };
