# ledger

A double-entry ledger in TypeScript + Postgres. Money moves between accounts as balanced, append-only
transactions; retries are safe through idempotency keys; balances are a cache you can always rebuild from the log.

## Run it

```bash
npm install && npm run db:up && npm test
```

Needs Node ≥ 24 and Docker. Postgres runs on `localhost:5433` (see `docker-compose.yml`); tests use a separate
`ledger_test` database that is wiped on every run.

Run the API (`http://127.0.0.1:3001`):

```bash
npm run migrate && npm start
```

## API

| Method + path | Body | Success | Errors (`{ error, message }`) |
|---|---|---|---|
| `POST /accounts` | `{ name, currency, allowNegative? }` | 201 account | 400 |
| `GET /accounts/:id` | — | 200 `{ id, name, currency, allowNegative, balance }` | 404 `account_not_found` |
| `POST /transactions` | `{ entries: [{ accountId, amount }], description?, effectiveAt? }` | 201 `{ transactionId }` | 400, 404, 409 `idempotency_key_reused`, 422 `insufficient_funds` |
| `GET /transactions/:id` | — | 200 with entries, `reversesId`, `reversedById` | 404 `transaction_not_found` |
| `POST /transactions/:id/reverse` | `{ description? }` (optional) | 201 `{ transactionId }` | 404, 409 `already_reversed`, 422 |

- `POST`s that move money require an `Idempotency-Key` header. A retry with the same key gets the same 201 and body,
  plus `Idempotent-Replayed: true`. The same key with a different body is a 409.
- Amounts are **strings** of integer minor units (`"-2500"` = −$25.00). JSON numbers, decimals and unknown fields are
  rejected with 400, so nothing gets silently rounded or dropped.

```bash
curl -s localhost:3001/transactions -H 'content-type: application/json' -H "idempotency-key: $(uuidgen)" \
  -d '{"entries":[{"accountId":"<from>","amount":"-2500"},{"accountId":"<to>","amount":"2500"}]}'
```

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
| A transaction is reversed at most once | clear `AlreadyReversedError` | partial unique index on `reverses_id` |
| Cached balance = sum of entries | updated in the same transaction | `reconcile()` reports any drift |

**Posting** (`postTransaction`), all in one Postgres transaction:
1. `INSERT` the idempotency key `ON CONFLICT DO NOTHING`. Lost the race → roll back, return the stored result
   (or `IdempotencyConflictError` if the body differs).
2. Lock the touched `balances` rows `FOR UPDATE`, ordered by account id (no deadlocks).
3. Check currencies and funds, insert the transaction and entries, bump balances, link the key.
4. `COMMIT`. The zero-sum trigger runs here.

**Reversing** (`reverseTransaction`) posts the exact negation of a transaction's entries as a new transaction
with `reverses_id` pointing at the original. Nothing is edited: history shows the mistake and its undo. It goes
through the same posting path, so it's idempotent and can't overdraw an account.

## Fund layer

A private fund's books built on the same ledger (`src/fund.ts`): LPs commit capital, the fund calls it, invests,
charges fees, marks investments to fair value and distributes cash, and each LP gets a **capital account statement**.

Every fund operation is one balanced ledger transaction, and the fund rules are the ledger's overdraft guard on
the right account. There are no separate checks to keep in sync:

| Rule | Enforced by |
|---|---|
| A call can't exceed an LP's unfunded commitment | per-LP `uncalled` memo account can't go negative |
| An LP can't pay more than it owes | per-LP `receivable` can't go negative |
| Fees and distributions need cash (called-but-unpaid isn't cash) | fund `cash` can't go negative |
| Assets = sum of LP capital accounts | every transaction sums to zero |

| Operation | Entries (positive = debit) |
|---|---|
| `issueCapitalCall` | `uncalled −s`, `commitments +S`, `receivable +s`, `contributions −s` per LP |
| `recordCallPayment` | `cash +a`, `receivable −a` |
| `chargeManagementFee` | `fees +f` per LP, `cash −F` |
| `invest` | `investments ±a`, `cash ∓a` |
| `recordValuation` | `investments +g`, `gains −g` per LP |
| `distribute` | `distributions +d` per LP, `cash −D` |

`getCapitalAccountStatement(fund, lp, from, to)` derives everything from entries by effective date: beginning
balance, contributions, distributions, fees, gains, ending balance, called to date, unfunded commitment and
outstanding calls. `npm run demo:fund` runs a year of a three-LP fund and prints them.

**Allocation.** Pro rata shares are split with the largest remainder method, so they always sum to the exact
total. Capital calls are weighted by *unfunded* commitment, not original commitment. Rounding every call by
commitment hands the same LP the spare cent each time, and by the final call that LP is owed past its
commitment, so the call fails. A test reproduces this.

Design notes and open decisions: [DESIGN.md](DESIGN.md).

## Numbers

| Metric | Value |
|---|---|
| Tests | 43 (DB-only invariant checks, idempotency, overdraft, reversals, 6 concurrency, 7 HTTP, 9 fund incl. concurrent calls) |

HTTP load test (`npm run load`: server as its own process, autocannon, 20 connections, 10 s per scenario, unique
`Idempotency-Key` per request; client, server and Postgres share one laptop; two runs):

| Scenario | Throughput | p50 | p99 | Failed |
|---|---|---|---|---|
| `POST /transactions`, random pairs of 100 users | ~1,960 req/s | 8–9 ms | 26 ms | 0 |
| `POST /transactions`, every one from `world` (hot account) | ~585 req/s | 39–40 ms | 80–105 ms | 0 |
| `GET /accounts/:id` | ~17,300 req/s | 1 ms | 2–3 ms | 0 |

`reconcile()` after each run: 0 drifted balances. The HTTP layer costs little: posting throughput is close to the
direct-call benchmark below, so Postgres row locks and commits are the bottleneck, not the API.

Posting benchmark (`npm run bench`, 2,000 transfers per scenario, pool of 20, Postgres 17 in Docker on an Apple-silicon
laptop, two runs):

| Scenario | Throughput | p50 | p99 |
|---|---|---|---|
| Sequential, one account pair | ~415 tx/s | 2.4 ms | 3.1–3.5 ms |
| 20 concurrent, **one hot pair** | ~570 tx/s | 36–37 ms | 56–57 ms |
| 20 concurrent, 20 disjoint pairs | ~2,370 tx/s | 8.3 ms | 12–15 ms |

A hot account barely scales: every posting holds its row lock from `FOR UPDATE` to `COMMIT`, so the 20 workers mostly
queue. Spread across accounts, the same code does ~4× the throughput.

Balance reads (`npm run bench:balances`, warm cache, 30 runs each; 1 `world` account on one side of every deposit,
1,000 users). Seed is bulk-loaded, then verified: every transaction balances and 0 cached balances drift.

| Balance read, p50 (p99) | 1M entries | 10M entries |
|---|---|---|
| Cached `balances` row | 0.31 ms (0.37) | 0.32 ms (0.48) |
| `SUM`, typical user (500 / 5,000 entries) | 0.42 ms (0.49) | 1.89 ms (2.67) |
| `SUM`, `world` (500k / 5M entries) | 24.9 ms (34.6) | 191.6 ms (209.3) |
| `SUM`, `world`, covering index forced | 17.2 ms (25.1) | 141.3 ms (176.9) |
| `reconcile()`, all accounts | 98 ms | 1,215 ms |

The cached read stays flat; `SUM` grows linearly with the account's history (~600× slower than the cache for `world`
at 10M). A covering index `(account_id) INCLUDE (amount)` makes `SUM` an index-only scan, which helps small accounts
but is still linear, and for `world` the planner ignored it in favor of a parallel seq scan unless forced.

## What I learned / what I'd do differently

_To fill in as the project goes._
