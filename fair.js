// ---------------------------------------------------------------
// Provably fair engine (Stake-style HMAC scheme)
// serverSeed (hidden until rotation) + clientSeed + nonce
// -> HMAC-SHA256 -> floats -> game outcomes.
// Deterministic: players can verify every bet after seed reveal.
// ---------------------------------------------------------------
const crypto = require('crypto');
const { SERVER_SEED_BYTES, HOUSE_EDGE } = require('./config');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function newServerSeed() {
  return crypto.randomBytes(SERVER_SEED_BYTES).toString('hex');
}
function newClientSeed() {
  return crypto.randomBytes(8).toString('hex');
}

// HMAC_SHA256(key=serverSeed, msg=`${clientSeed}:${nonce}:${cursor}`)
// -> 4 bytes at a time -> float in [0,1)
function floats({ serverSeed, clientSeed, nonce, count = 1 }) {
  const out = [];
  let cursor = 0;
  while (out.length < count) {
    const hmac = crypto
      .createHmac('sha256', serverSeed)
      .update(`${clientSeed}:${nonce}:${cursor}`)
      .digest();
    for (let i = 0; i < 4 && out.length < count; i++) {
      out.push(hmac[i] / 256 + hmac[i + 4] / 256 ** 2 + hmac[i + 8] / 256 ** 3 + hmac[i + 12] / 256 ** 4);
    }
    cursor++;
  }
  return out;
}

/* ----------------------------- Games ----------------------------- */

// DICE: roll 0.00-99.99; player picks win-chance -> payout = 99/chance (1% edge)
function dice(serverSeed, clientSeed, nonce, target, direction) {
  const f = floats({ serverSeed, clientSeed, nonce })[0] * 100;
  const roll = Math.floor(f * 100) / 100;
  const chance = direction === 'over' ? 99.99 - target : target - 0.01;
  const multiplier = +(99 / chance).toFixed(4); // (100-edge)/chance
  const won = direction === 'over' ? roll > target : roll < target;
  return { roll, chance: +chance.toFixed(2), multiplier, won };
}

// CRASH: multiplier M where P(M >= x) ~ 99/x, with 1% instant-bust band
function crash(serverSeed, clientSeed, nonce) {
  const f = floats({ serverSeed, clientSeed, nonce })[0];
  if (f < HOUSE_EDGE) return { crashPoint: 1.0 }; // instant bust
  const e = 2 ** 32;
  const h = Math.floor(f * e);
  const crashPoint = Math.max(1, Math.floor((100 * e - h) / (e - h)) / 100);
  return { crashPoint: Math.min(crashPoint, 1000) };
}

// SLOTS: 3 reels x 10 symbols; paytable on triples/pairs
const SLOT_SYMBOLS = ['🍒','🍋','🔔','⭐','💎','7️⃣','🍀','🍇','🎲','👑'];
function slots(serverSeed, clientSeed, nonce) {
  const f = floats({ serverSeed, clientSeed, nonce, count: 3 });
  const reels = f.map((x) => Math.floor(x * 10));
  const sym = reels.map((r) => SLOT_SYMBOLS[r]);
  let payout = 0;
  if (sym[0] === sym[1] && sym[1] === sym[2]) {
    payout = { '🍒':4,'🍋':6,'🔔':10,'⭐':16,'💎':30,'7️⃣':75,'🍀':40,'🍇':12,'🎲':8,'👑':150 }[sym[0]] || 4;
  } else if (sym[0] === sym[1] || sym[1] === sym[2] || sym[0] === sym[2]) {
    payout = 1.5; // pair
  }
  return { reels, symbols: sym, multiplier: payout };
}

// PLINKO: 16 rows, ball falls left/right at each peg (Stake-style)
// Multipliers table (risk: medium)
const PLINKO_TABLE = [16, 9, 2, 1.4, 1.2, 1.1, 1, 0.5, 0.3, 0.5, 1, 1.1, 1.2, 1.4, 2, 9, 16];
function plinko(serverSeed, clientSeed, nonce, rows = 16) {
  const f = floats({ serverSeed, clientSeed, nonce, count: rows });
  let bucket = 0;
  const path = f.map((x) => (x < 0.5 ? (bucket++, 0) : 1));
  const expected = PLINKO_TABLE.length - 1; // 16 rows -> 17 buckets
  const idx = Math.round((bucket / rows) * expected);
  return { path, bucketIndex: idx, multiplier: PLINKO_TABLE[idx] };
}

// Hi-Lo uses dice floats as a card deck draw
function cardFromFloat(f) {
  const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const r = Math.floor(f * 52);
  return { rank: ranks[r % 13], suit: ['♠','♥','♦','♣'][Math.floor(r / 13)], value: (r % 13) + 2 };
}

module.exports = {
  sha256, newServerSeed, newClientSeed, floats, dice, crash, slots, plinko, cardFromFloat,
  SLOT_SYMBOLS, PLINKO_TABLE,
};
