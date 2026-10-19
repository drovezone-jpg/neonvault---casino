// ---------------------------------------------------------------
// NeonVault Casino - central configuration
// ⚠️ PLAY-MONEY DEMO ONLY. Real-money gambling requires a gaming
// license, KYC/AML, age verification (18+) and geo-fencing.
// ---------------------------------------------------------------
module.exports = {
  PORT: process.env.PORT || 3000,

  // House edge applied across games (fraction). Dice uses (1-edge)
  // payout factor; crash adds an instant-bust band of `edge`.
  HOUSE_EDGE: 0.01,

  // Wallet
  CURRENCY: 'GC',              // "Gold Coins" - play money, NOT real currency
  SIGNUP_BONUS: 1000,          // free play balance on registration
  MIN_DEPOSIT: 10,
  MIN_WITHDRAW: 10,
  MAX_WITHDRAW_DAILY: 100000,

  // Responsible gambling defaults (players can tighten these)
  DEFAULT_DAILY_LOSS_LIMIT: null,   // null = unlimited
  DEFAULT_MAX_BET: 10000,

  // Session
  SESSION_TTL_HOURS: 24,

  // Provably fair
  SERVER_SEED_BYTES: 32,

  // Admin seed account (change in production!)
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'admin123'
};
