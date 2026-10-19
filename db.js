// ---------------------------------------------------------------
// SQLite persistence: users, sessions, append-only ledger, bets
// Balance is a derived value; every change goes through a ledger
// INSERT + atomic UPDATE inside a transaction.
// ---------------------------------------------------------------
const Database = require('better-sqlite3');
const path = require('path');
const { newServerSeed, newClientSeed } = require('./fair');

const db = new Database(path.join(__dirname, 'casino.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'player',      -- player | admin
  balance_cents INTEGER NOT NULL DEFAULT 0, -- play money (cents)
  locked INTEGER NOT NULL DEFAULT 0,        -- account locked by admin
  age_verified INTEGER NOT NULL DEFAULT 0,  -- 18+ self-declaration
  client_seed TEXT NOT NULL,
  server_seed TEXT NOT NULL,
  server_seed_next TEXT,
  server_seed_revealed_at TEXT,
  nonce INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,      -- deposit|withdraw|bet|payout|bonus|adjust
  amount_cents INTEGER NOT NULL,  -- signed: +credit / -debit
  balance_after_cents INTEGER NOT NULL,
  ref TEXT,                -- free-text reference (bet id, psp tx id)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS bets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  game TEXT NOT NULL,
  wager_cents INTEGER NOT NULL,
  multiplier REAL NOT NULL DEFAULT 0,
  payout_cents INTEGER NOT NULL DEFAULT 0,
  nonce INTEGER NOT NULL,
  client_seed TEXT NOT NULL,
  server_seed_hash TEXT NOT NULL,
  outcome TEXT NOT NULL,      -- JSON game result
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS psp_deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,        -- pending|succeeded|failed
  psp_ref TEXT,                -- mock/Stripe test-mode reference
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS psp_withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,        -- pending|paid|rejected
  psp_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, id);
CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id, id);
`);

const insLedger = db.prepare(
  'INSERT INTO ledger (user_id, type, amount_cents, balance_after_cents, ref) VALUES (?,?,?,?,?)'
);

// Atomic wallet mutation. EVERY balance change must go through here.
function applyWallet(userId, type, amountCents, ref) {
  const tx = db.transaction((uid, t, amt, r) => {
    const row = db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(uid);
    if (!row) throw new Error('User not found');
    const after = row.balance_cents + amt;
    if (after < 0) throw new Error('Insufficient balance');
    db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(after, uid);
    insLedger.run(uid, t, amt, after, r || null);
    return after;
  });
  return tx(userId, type, amountCents, ref);
}

function ensureSeeds(user) {
  if (!user.client_seed) db.prepare('UPDATE users SET client_seed=? WHERE id=?').run(newClientSeed(), user.id);
  if (!user.server_seed) db.prepare('UPDATE users SET server_seed=? WHERE id=?').run(newServerSeed(), user.id);
}

module.exports = { db, applyWallet, insLedger, ensureSeeds };
