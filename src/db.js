/**
 * db.js — SQLite database layer (sql.js — pure JS, no native deps)
 *
 * Tables:
 *   accounts        – stored AliExpress sessions (cookies encrypted)
 *   collection_logs – per-run results
 *   settings        – per-user schedule config
 *
 * Data is persisted to disk on every write via saveToDisk().
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'bot.db');

let db = null;
let saveTimer = null;
let dirty = false;

/**
 * Save in-memory DB to disk — debounced: consecutive writes within the same
 * second are batched into a single export instead of serializing the whole
 * database on every single write.
 */
function saveToDisk() {
  if (!db || saveTimer) return; // already scheduled
  dirty = true;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!db || !dirty) return;
    try {
      const data = db.export();
      fs.writeFileSync(DB_PATH, Buffer.from(data));
    } catch (err) {
      console.error('[db] save failed:', err.message);
    } finally {
      dirty = false;
    }
  }, 1000);
}

/** Force a synchronous save now (used on shutdown). */
function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!db || !dirty) return;
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } finally {
    dirty = false;
  }
}

/** Initialise DB and create tables if needed */
async function init() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON;');

  db.run(`
    CREATE TABLE IF NOT EXISTS accounts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id      TEXT    NOT NULL,
      alias        TEXT    DEFAULT '',
      cookies_enc  TEXT    NOT NULL,
      created_at   TEXT    DEFAULT (datetime('now')),
      last_status  TEXT    DEFAULT 'new',
      last_run     TEXT,
      last_coins   INTEGER DEFAULT 0
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS collection_logs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id      INTEGER NOT NULL,
      timestamp       TEXT    DEFAULT (datetime('now')),
      coins_earned    INTEGER DEFAULT 0,
      tasks_completed TEXT    DEFAULT '[]',
      error           TEXT,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      chat_id       TEXT PRIMARY KEY,
      schedule_time TEXT DEFAULT '08:00',
      timezone      TEXT DEFAULT 'UTC'
    );
  `);

  saveToDisk();
  return db;
}

/** Get the raw db handle */
function getDb() {
  if (!db) throw new Error('Database not initialized. Call init() first.');
  return db;
}

// ─── Helper: run a SELECT and return array of objects ───
function queryAll(sql, params = []) {
  const stmt = getDb().prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length ? rows[0] : null;
}

function runSql(sql, params = []) {
  getDb().run(sql, params);
  saveToDisk();
  const changes = getDb().getRowsModified();
  return { changes };
}

// ─── Accounts ──────────────────────────────────────────

function addAccount(chatId, cookiesEnc, alias = '') {
  return runSql(
    'INSERT INTO accounts (chat_id, cookies_enc, alias) VALUES (?, ?, ?)',
    [chatId, cookiesEnc, alias]
  );
}

function removeAccount(id, chatId) {
  return runSql('DELETE FROM accounts WHERE id = ? AND chat_id = ?', [id, chatId]);
}

function getAccount(id) {
  return queryOne('SELECT * FROM accounts WHERE id = ?', [id]);
}

function getAccountsByChat(chatId) {
  return queryAll('SELECT * FROM accounts WHERE chat_id = ? ORDER BY id', [chatId]);
}

function getAllAccounts() {
  return queryAll('SELECT * FROM accounts ORDER BY id');
}

function updateAccountStatus(id, status, coins = 0) {
  return runSql(
    "UPDATE accounts SET last_status = ?, last_coins = ?, last_run = datetime('now') WHERE id = ?",
    [status, coins, id]
  );
}

// ─── Collection Logs ───────────────────────────────────

function addLog(accountId, coinsEarned, tasksCompleted, error = null) {
  return runSql(
    'INSERT INTO collection_logs (account_id, coins_earned, tasks_completed, error) VALUES (?, ?, ?, ?)',
    [accountId, coinsEarned, JSON.stringify(tasksCompleted), error]
  );
}

function getTodayLogs(chatId) {
  return queryAll(
    `SELECT cl.* FROM collection_logs cl
     JOIN accounts a ON cl.account_id = a.id
     WHERE a.chat_id = ?
       AND date(cl.timestamp) = date('now')
     ORDER BY cl.timestamp DESC`,
    [chatId]
  );
}

function getRecentLogs(accountId, limit = 10) {
  return queryAll(
    'SELECT * FROM collection_logs WHERE account_id = ? ORDER BY timestamp DESC LIMIT ?',
    [accountId, limit]
  );
}

/** True if this account already earned coins today (per our own logs). */
function wasClaimedToday(accountId) {
  const row = queryOne(
    `SELECT id FROM collection_logs
     WHERE account_id = ?
       AND coins_earned > 0
       AND date(timestamp) = date('now')
     ORDER BY timestamp DESC LIMIT 1`,
    [accountId]
  );
  return !!row;
}

/** True if ANY collection run was logged today. Used for missed-run catch-up. */
function hasLogsToday() {
  const row = queryOne(
    "SELECT id FROM collection_logs WHERE date(timestamp) = date('now') LIMIT 1"
  );
  return !!row;
}

// ─── Settings ──────────────────────────────────────────

function getSettings(chatId) {
  let row = queryOne('SELECT * FROM settings WHERE chat_id = ?', [chatId]);
  if (!row) {
    runSql(
      "INSERT INTO settings (chat_id, schedule_time, timezone) VALUES (?, '08:00', ?)",
      [chatId, process.env.TZ || 'UTC']
    );
    row = queryOne('SELECT * FROM settings WHERE chat_id = ?', [chatId]);
  }
  return row;
}

function updateSettings(chatId, scheduleTime, timezone) {
  // sql.js doesn't support ON CONFLICT with UPDATE SET well, so use replace
  runSql('DELETE FROM settings WHERE chat_id = ?', [chatId]);
  return runSql(
    'INSERT INTO settings (chat_id, schedule_time, timezone) VALUES (?, ?, ?)',
    [chatId, scheduleTime, timezone]
  );
}

// ─── Cleanup ───────────────────────────────────────────

function close() {
  if (db) {
    flush();
    db.close();
    db = null;
  }
}

module.exports = {
  init,
  getDb,
  flush,
  addAccount,
  removeAccount,
  getAccount,
  getAccountsByChat,
  getAllAccounts,
  updateAccountStatus,
  addLog,
  getTodayLogs,
  getRecentLogs,
  wasClaimedToday,
  hasLogsToday,
  getSettings,
  updateSettings,
  close,
};
