const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_DIR = process.env.DATA_DIR || 
  (fs.existsSync("/var/data") ? "/var/data" : 
  (fs.existsSync("/app/data") ? "/app/data" : path.join(__dirname, "data")));
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const DB_PATH = path.join(DB_DIR, 'scheduler.db');
const db = new sqlite3.Database(DB_PATH);

// Enable WAL mode for high concurrency and fast writes
db.serialize(() => {
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA synchronous = NORMAL');

  // Schedules table (user_id scoped)
  db.run(`
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      recipient TEXT NOT NULL,
      jid TEXT,
      text TEXT,
      attachments TEXT,
      scheduled_at INTEGER NOT NULL,
      status TEXT DEFAULT 'scheduled',
      attempts INTEGER DEFAULT 0,
      error TEXT,
      created_at INTEGER NOT NULL,
      sent_at INTEGER
    )
  `);
  try { db.run("ALTER TABLE schedules ADD COLUMN user_id TEXT", () => {}); } catch (_) {}

  // Contacts cache table (user_id scoped)
  db.run(`
    CREATE TABLE IF NOT EXISTS contacts (
      user_id TEXT,
      jid TEXT,
      name TEXT,
      phone TEXT,
      is_group INTEGER DEFAULT 0,
      source TEXT DEFAULT 'whatsapp',
      name_source TEXT DEFAULT 'whatsapp',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, jid)
    )
  `);

  // Key-value settings table (user_id scoped)
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      user_id TEXT,
      key TEXT,
      value TEXT,
      PRIMARY KEY (user_id, key)
    )
  `);

  // Migrate legacy single-column PK contacts table to composite (user_id, jid) PK
  db.all("PRAGMA table_info(contacts)", (err, rows) => {
    if (rows && rows.length > 0) {
      const pkCount = rows.filter(r => r.pk > 0).length;
      const jidPkOnly = rows.find(r => r.name === 'jid' && r.pk === 1 && pkCount === 1);
      if (jidPkOnly) {
        db.serialize(() => {
          db.run(`
            CREATE TABLE IF NOT EXISTS contacts_v2 (
              user_id TEXT,
              jid TEXT,
              name TEXT,
              phone TEXT,
              is_group INTEGER DEFAULT 0,
              source TEXT DEFAULT 'whatsapp',
              name_source TEXT DEFAULT 'whatsapp',
              updated_at INTEGER NOT NULL,
              PRIMARY KEY (user_id, jid)
            )
          `);
          db.run(`
            INSERT OR IGNORE INTO contacts_v2 (user_id, jid, name, phone, is_group, source, name_source, updated_at)
            SELECT coalesce(user_id, ''), jid, name, phone, is_group, coalesce(source, 'whatsapp'), coalesce(name_source, 'whatsapp'), updated_at FROM contacts
          `);
          db.run(`DROP TABLE contacts`);
          db.run(`ALTER TABLE contacts_v2 RENAME TO contacts`);
        });
      }
    }
  });

  // Migrate legacy single-column PK settings table to composite (user_id, key) PK
  db.all("PRAGMA table_info(settings)", (err, rows) => {
    if (rows && rows.length > 0) {
      const pkCount = rows.filter(r => r.pk > 0).length;
      const keyPkOnly = rows.find(r => r.name === 'key' && r.pk === 1 && pkCount === 1);
      if (keyPkOnly) {
        db.serialize(() => {
          db.run(`
            CREATE TABLE IF NOT EXISTS settings_v2 (
              user_id TEXT,
              key TEXT,
              value TEXT,
              PRIMARY KEY (user_id, key)
            )
          `);
          db.run(`
            INSERT OR IGNORE INTO settings_v2 (user_id, key, value)
            SELECT coalesce(user_id, ''), key, value FROM settings
          `);
          db.run(`DROP TABLE settings`);
          db.run(`ALTER TABLE settings_v2 RENAME TO settings`);
        });
      }
    }
  });

  // Application Users & Auth Sessions tables
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      created_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Performance & Multi-Tenant Indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_token_expires ON sessions(token, expires_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_contacts_user_phone ON contacts(user_id, phone)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_contacts_user_name ON contacts(user_id, name)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_contacts_user_updated ON contacts(user_id, updated_at DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_schedules_user_status_time ON schedules(user_id, status, scheduled_at ASC)`);

  // Clean up any internal @lid entries from contacts
  db.run(`DELETE FROM contacts WHERE jid LIKE '%@lid' OR (jid NOT LIKE '%@s.whatsapp.net' AND jid NOT LIKE '%@g.us')`, () => {});
});

// Promisified DB Helpers
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Multi-Tenant Bulk Transaction Upsert for Contacts
function batchUpsertContacts(userId, contactList, source = "whatsapp") {
  return new Promise((resolve, reject) => {
    if (!userId || !contactList || contactList.length === 0) return resolve(0);

    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      const stmt = db.prepare(`
        INSERT INTO contacts (user_id, jid, name, phone, is_group, source, name_source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, jid) DO UPDATE SET
          name = CASE
            WHEN excluded.source = 'phonebook' AND nullif(excluded.name, '') IS NOT NULL THEN excluded.name
            WHEN nullif(excluded.name, '') IS NOT NULL AND (contacts.name_source != 'phonebook' OR contacts.name IS NULL OR contacts.name = '') THEN excluded.name
            WHEN contacts.name LIKE '%@%' OR contacts.name = contacts.phone THEN ''
            ELSE contacts.name
          END,
          name_source = CASE
            WHEN excluded.source = 'phonebook' AND nullif(excluded.name, '') IS NOT NULL THEN 'phonebook'
            WHEN nullif(excluded.name, '') IS NOT NULL AND (contacts.name_source != 'phonebook' OR contacts.name IS NULL OR contacts.name = '') THEN excluded.name_source
            WHEN contacts.name LIKE '%@%' OR contacts.name = contacts.phone THEN 'whatsapp'
            ELSE contacts.name_source
          END,
          phone = coalesce(nullif(excluded.phone, ''), contacts.phone),
          source = CASE WHEN excluded.source = 'phonebook' THEN 'phonebook' ELSE contacts.source END,
          updated_at = excluded.updated_at
      `);

      let count = 0;
      const now = Date.now();
      for (const c of contactList) {
        if (!c.jid || c.jid.endsWith('@lid') || c.jid === 'status@broadcast') continue;
        if (!c.jid.endsWith('@s.whatsapp.net') && !c.jid.endsWith('@g.us')) continue;

        let name = (c.name || '').trim();
        const isGrp = c.is_group || (c.jid.endsWith('@g.us') ? 1 : 0);
        let phone = c.phone || (isGrp ? '' : c.jid.split('@')[0].replace(/\D/g, ''));
        if (name.includes('@') || name === phone) name = '';

        const contactSource = c.source || source;
        const nameSource = contactSource === "phonebook" && name ? "phonebook" : "whatsapp";
        stmt.run([userId, c.jid, name, phone, isGrp ? 1 : 0, contactSource, nameSource, now], (err) => {
          if (!err) count++;
        });
      }

      stmt.finalize();

      db.run('COMMIT', (err) => {
        if (err) {
          db.run('ROLLBACK');
          reject(err);
        } else {
          resolve(count);
        }
      });
    });
  });
}

// Safe Migration for Legacy Unscoped Data -> Primary Admin Account
async function migrateLegacyData(adminUserId) {
  if (!adminUserId) return;
  try {
    await run("UPDATE schedules SET user_id = ? WHERE user_id IS NULL OR user_id = ''", [adminUserId]);
    await run("UPDATE contacts SET user_id = ? WHERE user_id IS NULL OR user_id = ''", [adminUserId]);
    await run("UPDATE settings SET user_id = ? WHERE user_id IS NULL OR user_id = ''", [adminUserId]);
  } catch (err) {
    console.error("[Migration] Error migrating legacy data:", err.message);
  }
}

module.exports = {
  db,
  run,
  get,
  all,
  batchUpsertContacts,
  migrateLegacyData,
  DB_DIR
};
