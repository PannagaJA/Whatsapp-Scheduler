const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const DB_PATH = path.join(DB_DIR, 'scheduler.db');
const db = new sqlite3.Database(DB_PATH);

// Enable WAL mode for high concurrency and fast writes
db.serialize(() => {
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA synchronous = NORMAL');

  // Schedules table
  db.run(`
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
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

  // Contacts cache table
  db.run(`
    CREATE TABLE IF NOT EXISTS contacts (
      jid TEXT PRIMARY KEY,
      name TEXT,
      phone TEXT,
      is_group INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL
    )
  `);

  // Performance Indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_contacts_updated ON contacts(updated_at DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_schedules_status_time ON schedules(status, scheduled_at ASC)`);

  // Clean up any internal @lid entries from contacts
  db.run(`DELETE FROM contacts WHERE jid LIKE '%@lid' OR (jid NOT LIKE '%@s.whatsapp.net' AND jid NOT LIKE '%@g.us')`, () => {});

  // Key-value settings table
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);
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

// Ultra-fast Bulk Transaction Upsert for Contacts (processes 1,000s in <20ms)
function batchUpsertContacts(contactList) {
  return new Promise((resolve, reject) => {
    if (!contactList || contactList.length === 0) return resolve(0);

    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      const stmt = db.prepare(`
        INSERT INTO contacts (jid, name, phone, is_group, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(jid) DO UPDATE SET
          name = CASE
            WHEN nullif(excluded.name, '') IS NOT NULL THEN excluded.name
            WHEN contacts.name LIKE '%@%' OR contacts.name = contacts.phone THEN ''
            ELSE contacts.name
          END,
          phone = coalesce(nullif(excluded.phone, ''), contacts.phone),
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

        stmt.run([c.jid, name, phone, isGrp ? 1 : 0, now], (err) => {
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

module.exports = {
  db,
  run,
  get,
  all,
  batchUpsertContacts,
  DB_DIR
};
