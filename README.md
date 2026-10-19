# NeonVault Casino — Play-Money Provably-Fair Casino Demo

A Stake/Scatter-style casino platform: accounts, wallet with append-only ledger,
deposits, withdrawals, and 4 provably-fair games (Dice, Crash, Plinko, Slots) —
all server-side RNG, admin panel, responsible-gambling limits, and an 18+ gate.

> ⚠️ **PLAY-MONEY DEMO — NOT A REAL-MONEY CASINO.**
> Operating a real-money gambling site requires a gaming license, KYC/AML,
> age and geo verification, RG tooling per jurisdiction, etc. Deposits and
> withdrawals here are wired to a **mock payment adapter** (test-mode style,
> instantly "succeeds"). Replace `server.js` PSP routes with a licensed
> payment provider only after you have legal clearance.

## Run

```bash
npm install
npm start
# open http://localhost:3000
```

Demo admin: `admin / admin123` (change in `config.js`).
New players get a 1,000 GC signup bonus. Currency = GC (Gold Coins, no real value).

## Games

| Game   | Mechanic                                                        |
|--------|------------------------------------------------------------------|
| Dice   | Roll 0–99.99, pick over/under target; payout = 99 / win-chance  |
| Crash  | Auto-cashout multiplier; ~1% instant-bust band                  |
| Plinko | 16 rows, 17 buckets, medium risk 0.3x–16x                       |
| Slots  | 3×10 symbols, triples up to 150x, pairs 1.5x                    |

## Provably fair

HMAC-SHA256(serverSeed, `clientSeed:nonce:cursor`) → byte-stream → floats.

- `serverSeed`: hidden; its SHA-256 hash is shown before betting (`/api/me`).
- `clientSeed`: player-controlled (Fairness panel).
- `nonce`: increments per bet, atomically with the wager debit.

Verify any bet after rotating/revealing the seed (Fairness panel → Rotate → Verify).

## Architecture

- `server.js` — Express API: auth, wallet, games, fairness, limits, admin
- `db.js` — SQLite (WAL): users, sessions, **append-only ledger**, bets, PSP stubs
- `fair.js` — provably-fair engine + game math (house edge in `config.js`)
- `public/index.html` — single-file neon frontend

All balance changes go through `applyWallet()` — an atomic ledger-insert +
balance-update transaction — so bets, deposits, and withdrawals can never
race or desync from the ledger.
