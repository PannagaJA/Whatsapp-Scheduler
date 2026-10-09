const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const DB_PATH = path.join(DB_DIR, 'scheduler.db');
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
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

module.exports = {
  db,
  run,
  get,
  all,
  DB_DIR
};
