# ledger

A double-entry ledger in TypeScript + Postgres. Money moves between accounts as balanced, append-only
transactions; retries are safe through idempotency keys; balances are a cache you can always rebuild from the log.

## Run it

```bash
npm install && npm run db:up && npm test
```

Needs Node ≥ 24 and Docker. Postgres runs on `localhost:5433` (see `docker-compose.yml`); tests use a separate
`ledger_test` database that is wiped on every run.

## How it works

| Table | Role |
|---|---|
| `entries` | Source of truth. Signed amounts in minor units (`bigint`, never float). Append-only. |
| `transactions` | Groups entries that must balance. `effective_at` (economic date) vs `posted_at` (recorded). |
| `balances` | Cached `SUM(entries.amount)` per account, updated in the same DB transaction as the entries. |
| `idempotency_keys` | One row per client request key, committed together with the transaction it created. |

**Invariants and where they're enforced**

| Invariant | App | Database |
|---|---|---|
| Entries sum to zero, per currency | clear `ValidationError` | deferred constraint trigger at `COMMIT` |
| ≥ 2 entries, no zero amounts | ✓ | trigger + `CHECK (amount <> 0)` |
| Entry currency = account currency | — | composite FK `(account_id, currency)` |
| History is append-only | — | triggers reject `UPDATE`/`DELETE`/`TRUNCATE` |
| No overdraft (unless `allow_negative`) | checked under row lock | — |
| Cached balance = sum of entries | updated in the same transaction | `reconcile()` reports any drift |

**Posting** (`postTransaction`), all in one Postgres transaction:
1. `INSERT` the idempotency key `ON CONFLICT DO NOTHING`. Lost the race → roll back, return the stored result
   (or `IdempotencyConflictError` if the body differs).
2. Lock the touched `balances` rows `FOR UPDATE`, ordered by account id (no deadlocks).
3. Check currencies and funds, insert the transaction and entries, bump balances, link the key.
4. `COMMIT`. The zero-sum trigger runs here.

Design notes and open decisions: [DESIGN.md](DESIGN.md).

## Numbers

| Metric | Value |
|---|---|
| Tests | 20 (DB-only invariant checks, idempotency, overdraft, 5 concurrency) |

Posting benchmark (`npm run bench`, 2,000 transfers per scenario, pool of 20, Postgres 17 in Docker on an Apple-silicon
laptop, two runs):

| Scenario | Throughput | p50 | p99 |
|---|---|---|---|
| Sequential, one account pair | ~415 tx/s | 2.4 ms | 3.1–3.5 ms |
| 20 concurrent, **one hot pair** | ~570 tx/s | 36–37 ms | 56–57 ms |
| 20 concurrent, 20 disjoint pairs | ~2,370 tx/s | 8.3 ms | 12–15 ms |

A hot account barely scales: every posting holds its row lock from `FOR UPDATE` to `COMMIT`, so the 20 workers mostly
queue. Spread across accounts, the same code does ~4× the throughput.

## What I learned / what I'd do differently

_To fill in as the project goes._
