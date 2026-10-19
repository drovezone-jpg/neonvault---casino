// ---------------------------------------------------------------
// NeonVault Casino - Express server
// ⚠️ PLAY-MONEY DEMO. Deposits/withdrawals use a MOCK payment
// adapter (test-mode style). Real-money gambling requires a
// gaming license + KYC/AML + age & geo verification.
// ---------------------------------------------------------------
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

const C = require('./config');
const { db, applyWallet } = require('./db');
const fair = require('./fair');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const now = () => new Date().toISOString();
const todayStr = () => new Date().toISOString().slice(0, 10);
const bad = (res, code, msg) => res.status(code).json({ error: msg });

/* ------------------------- Sessions / Auth ------------------------- */
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const exp = new Date(Date.now() + C.SESSION_TTL_HOURS * 3600e3).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(token, userId, exp);
  return token;
}
function currentUser(req) {
  const token = req.cookies.sid;
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?`).get(token, now());
  return row || null;
}
const requireAuth = (req, res, next) => {
  const u = currentUser(req);
  if (!u) return bad(res, 401, 'Not logged in');
  if (u.locked) return bad(res, 403, 'Account locked. Contact support.');
  req.user = u;
  next();
};
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') return bad(res, 403, 'Admin only');
  next();
};

app.post('/api/auth/register', (req, res) => {
  const { username, email, password, ageConfirmed } = req.body || {};
  if (!ageConfirmed) return bad(res, 400, 'You must confirm you are 18+ (this demo still requires it).');
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || '')) return bad(res, 400, 'Username: 3-20 letters/digits/underscore');
  if (!/^\S+@\S+\.\S+$/.test(email || '')) return bad(res, 400, 'Invalid email');
  if (!password || password.length < 6) return bad(res, 400, 'Password must be 6+ characters');
  const hash = bcrypt.hashSync(password, 10);
  try {
    const info = db.prepare(`
      INSERT INTO users (username, email, pass_hash, balance_cents, age_verified, client_seed, server_seed)
      VALUES (?,?,?,?,1,?,?)`)
      .run(username, email.toLowerCase(), hash, C.SIGNUP_BONUS * 100, fair.newClientSeed(), fair.newServerSeed());
    applyWallet(info.lastInsertRowid, 'bonus', C.SIGNUP_BONUS * 100, 'signup-bonus');
    res.json({ ok: true, userId: info.lastInsertRowid });
  } catch (e) {
    bad(res, 409, e.message.includes('UNIQUE') ? 'Username or email already taken' : e.message);
  }
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, (username || '').toLowerCase());
  if (!u || !bcrypt.compareSync(password || '', u.pass_hash)) return bad(res, 401, 'Invalid credentials');
  if (u.locked) return bad(res, 403, 'Account locked');
  res.cookie('sid', createSession(u.id), { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.cookies.sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.cookies.sid);
  res.clearCookie('sid').json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  const { pass_hash, server_seed, server_seed_next, ...safe } = req.user;
  res.json({ user: safe, serverSeedHash: fair.sha256(server_seed) });
});

/* ------------------------- Wallet (MOCK PSP) ------------------------- */
// Real deployments: replace with Stripe test-mode / licensed PSP + KYC.
app.post('/api/wallet/deposit', requireAuth, (req, res) => {
  const amt = Math.round(Number(req.body.amount) * 100);
  if (!Number.isFinite(amt) || amt < C.MIN_DEPOSIT * 100) return bad(res, 400, `Minimum deposit is ${C.MIN_DEPOSIT} ${C.CURRENCY}`);
  const ref = 'MOCK-PSP-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  db.prepare('INSERT INTO psp_deposits (user_id, amount_cents, status, psp_ref) VALUES (?,?,?,?)')
    .run(req.user.id, amt, 'succeeded', ref); // test-mode: instantly "succeeds"
  const balance = applyWallet(req.user.id, 'deposit', amt, ref);
  res.json({ ok: true, balance: balance / 100, pspRef: ref });
});

app.post('/api/wallet/withdraw', requireAuth, (req, res) => {
  const amt = Math.round(Number(req.body.amount) * 100);
  if (!Number.isFinite(amt) || amt < C.MIN_WITHDRAW * 100) return bad(res, 400, `Minimum withdrawal is ${C.MIN_WITHDRAW} ${C.CURRENCY}`);
  const dayStart = todayStr() + ' 00:00:00';
  const paid = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) s FROM ledger WHERE user_id=? AND type='withdraw' AND created_at >= ?`)
    .get(req.user.id, dayStart).s;
  if (paid + amt > C.MAX_WITHDRAW_DAILY * 100) return bad(res, 400, 'Daily withdrawal limit exceeded');
  const ref = 'MOCK-PSP-W-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  const balance = applyWallet(req.user.id, 'withdraw', -amt, ref); // debits first
  db.prepare('INSERT INTO psp_withdrawals (user_id, amount_cents, status, psp_ref) VALUES (?,?,?,?)')
    .run(req.user.id, amt, 'paid', ref); // test-mode: instantly "paid"
  res.json({ ok: true, balance: balance / 100, pspRef: ref });
});

app.get('/api/wallet/transactions', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT type, amount_cents, balance_after_cents, ref, created_at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 100')
    .all(req.user.id);
  res.json({ transactions: rows.map(r => ({ ...r, amount: r.amount_cents / 100, balanceAfter: r.balance_after_cents / 100 })) });
});

/* ------------------------- Provably fair ------------------------- */
app.post('/api/fair/rotate-seed', requireAuth, (req, res) => {
  const u = req.user;
  if (!u.server_seed_next) return bad(res, 400, 'No pending seed');
  db.prepare(`UPDATE users SET server_seed = server_seed_next, server_seed_next = NULL,
              server_seed_revealed_at = ?, nonce = 0 WHERE id = ?`).run(now(), u.id);
  res.json({ revealedSeed: u.server_seed_next, hashOfRevealed: fair.sha256(u.server_seed_next) });
});
app.post('/api/fair/set-client-seed', requireAuth, (req, res) => {
  const s = String(req.body.clientSeed || '').slice(0, 64);
  if (!s) return bad(res, 400, 'clientSeed required');
  db.prepare('UPDATE users SET client_seed = ? WHERE id = ?').run(s, req.user.id);
  res.json({ ok: true });
});
app.get('/api/fair/verify/:betId', requireAuth, (req, res) => {
  const bet = db.prepare('SELECT * FROM bets WHERE id = ? AND user_id = ?').get(req.params.betId, req.user.id);
  if (!bet) return bad(res, 404, 'Bet not found');
  const seed = db.prepare('SELECT server_seed FROM users WHERE id = ?').get(req.user.id).server_seed;
  res.json({ bet, serverSeedNow: seed, hashMatches: fair.sha256(seed) === bet.server_seed_hash });
});

/* ------------------------- Betting core ------------------------- */
function placeBet(req, res, game, run) {
  const wager = Math.round(Number(req.body.wager) * 100);
  if (!Number.isFinite(wager) || wager <= 0) return bad(res, 400, 'Invalid wager');
  const u = req.user;

  // Responsible gambling: max bet
  const maxBet = loadLimit(u.id, 'max_bet') ?? C.DEFAULT_MAX_BET;
  if (wager > maxBet * 100) return bad(res, 400, `Max bet limit is ${maxBet} ${C.CURRENCY}`);

  // Responsible gambling: daily loss limit
  const lossLimit = loadLimit(u.id, 'daily_loss_limit');
  if (lossLimit != null) {
    const dayStart = todayStr();
    const net = db.prepare(`SELECT COALESCE(SUM(payout_cents - wager_cents),0) n FROM bets
                            WHERE user_id=? AND date(created_at)=?`).get(u.id, dayStart).n;
    if (net - wager * 0 < -lossLimit * 100) return bad(res, 400, `Daily loss limit (${lossLimit} ${C.CURRENCY}) reached. Take a break.`);
  }

  // Atomic: debit wager + increment nonce together
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT nonce FROM users WHERE id = ?').get(u.id);
    db.prepare('UPDATE users SET nonce = nonce + 1 WHERE id = ?').run(u.id);
    const bal = applyWallet(u.id, 'bet', -wager, `${game}`);
    return { nonce: row.nonce, balance: bal };
  });
  let ctx;
  try { ctx = tx(); } catch (e) { return bad(res, 400, e.message); }

  const outcome = run(ctx.nonce);
  const payoutC = Math.round(wager * (outcome.multiplier || 0));
  if (payoutC > 0) applyWallet(u.id, 'payout', payoutC, `${game}-win`);

  const info = db.prepare(`INSERT INTO bets (user_id, game, wager_cents, multiplier, payout_cents, nonce,
    client_seed, server_seed_hash, outcome) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(u.id, game, wager, outcome.multiplier || 0, payoutC, ctx.nonce, u.client_seed,
         fair.sha256(u.server_seed), JSON.stringify(outcome));

  const balance = db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(u.id).balance_cents;
  res.json({ betId: info.lastInsertRowid, ...outcome, payout: payoutC / 100, wager: wager / 100, balance: balance / 100 });
}

function loadLimit(userId, key) {
  const v = db.prepare('SELECT value FROM limits WHERE user_id = ? AND key = ?').get(userId, key);
  return v ? JSON.parse(v.value) : null;
}
// limits table (created lazily so db.js stays clean)
db.exec(`CREATE TABLE IF NOT EXISTS limits (
  user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key))`);

/* ------------------------- Games (server-side RNG) ------------------------- */
app.post('/api/games/dice', requireAuth, (req, res) => {
  const target = Number(req.body.target), dir = req.body.direction === 'under' ? 'under' : 'over';
  if (!(target >= 0.01 && target <= 99.98)) return bad(res, 400, 'Target must be 0.01-99.98');
  placeBet(req, res, 'dice', (nonce) => fair.dice(req.user.server_seed, req.user.client_seed, nonce, target, dir));
});

app.post('/api/games/slots', requireAuth, (req, res) =>
  placeBet(req, res, 'slots', (nonce) => fair.slots(req.user.server_seed, req.user.client_seed, nonce)));

app.post('/api/games/plinko', requireAuth, (req, res) =>
  placeBet(req, res, 'plinko', (nonce) => fair.plinko(req.user.server_seed, req.user.client_seed, nonce)));

app.post('/api/games/crash', requireAuth, (req, res) => {
  const cashout = Number(req.body.autoCashout);
  if (!(cashout >= 1.01 && cashout <= 1000)) return bad(res, 400, 'Auto-cashout must be 1.01-1000');
  placeBet(req, res, 'crash', (nonce) => {
    const o = fair.crash(req.user.server_seed, req.user.client_seed, nonce);
    const won = o.crashPoint >= cashout;
    return { ...o, autoCashout: cashout, won, multiplier: won ? cashout : 0 };
  });
});

app.get('/api/bets/mine', requireAuth, (req, res) => {
  res.json({ bets: db.prepare('SELECT id, game, wager_cents, multiplier, payout_cents, created_at FROM bets WHERE user_id=? ORDER BY id DESC LIMIT 50')
    .all(req.user.id).map(b => ({ ...b, wager: b.wager_cents / 100, payout: b.payout_cents / 100 })) });
});

/* ------------------------- Responsible gambling ------------------------- */
app.post('/api/limits', requireAuth, (req, res) => {
  const { maxBet, dailyLossLimit } = req.body || {};
  const set = (k, v) => {
    if (v === null || v === undefined || v === '') {
      db.prepare('DELETE FROM limits WHERE user_id=? AND key=?').run(req.user.id, k);
    } else {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error('Invalid ' + k);
      db.prepare(`INSERT INTO limits (user_id, key, value) VALUES (?,?,?)
                  ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value`).run(req.user.id, k, JSON.stringify(n));
    }
  };
  try { if (maxBet !== undefined) set('max_bet', maxBet); if (dailyLossLimit !== undefined) set('daily_loss_limit', dailyLossLimit); }
  catch (e) { return bad(res, 400, e.message); }
  res.json({ ok: true, maxBet: loadLimit(req.user.id, 'max_bet'), dailyLossLimit: loadLimit(req.user.id, 'daily_loss_limit') });
});
app.get('/api/limits', requireAuth, (req, res) =>
  res.json({ maxBet: loadLimit(req.user.id, 'max_bet'), dailyLossLimit: loadLimit(req.user.id, 'daily_loss_limit') }));

/* ------------------------- Admin panel ------------------------- */
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  res.json({ users: db.prepare(`SELECT id, username, email, role, balance_cents, locked, created_at FROM users ORDER BY id DESC`)
    .all().map(u => ({ ...u, balance: u.balance_cents / 100 })) });
});
app.post('/api/admin/adjust', requireAuth, requireAdmin, (req, res) => {
  const amt = Math.round(Number(req.body.amount) * 100);
  if (!Number.isFinite(amt)) return bad(res, 400, 'Invalid amount');
  const balance = applyWallet(Number(req.body.userId), 'adjust', amt, 'admin-adjust');
  res.json({ ok: true, balance: balance / 100 });
});
app.post('/api/admin/lock', requireAuth, requireAdmin, (req, res) => {
  db.prepare('UPDATE users SET locked = ? WHERE id = ? AND role != \'admin\'')
    .run(req.body.locked ? 1 : 0, Number(req.body.userId));
  res.json({ ok: true });
});
app.get('/api/admin/bets', requireAuth, requireAdmin, (req, res) => {
  res.json({ bets: db.prepare(`SELECT b.*, u.username FROM bets b JOIN users u ON u.id=b.user_id ORDER BY b.id DESC LIMIT 100`).all()
    .map(b => ({ ...b, wager: b.wager_cents / 100, payout: b.payout_cents / 100 })) });
});

/* ------------------------- Bootstrap + listen ------------------------- */
if (!db.prepare('SELECT id FROM users WHERE username = ?').get(C.ADMIN_USERNAME)) {
  const info = db.prepare(`INSERT INTO users (username, email, pass_hash, role, balance_cents, age_verified, client_seed, server_seed)
    VALUES (?,?,?,?,?,1,?,?)`).run(C.ADMIN_USERNAME, 'admin@neonvault.local',
    bcrypt.hashSync(C.ADMIN_PASSWORD, 10), 'admin', 10000000 * 100, fair.newClientSeed(), fair.newServerSeed());
  applyWallet(info.lastInsertRowid, 'bonus', 0, 'admin-seed');
}

app.listen(C.PORT, () => console.log(`NeonVault Casino (play-money demo) → http://localhost:${C.PORT}`));
