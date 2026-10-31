# Ledger — design

_Concepts: `~/work/learning/notes/double-entry-ledger.md`. Built in build mode; decisions recorded as we go._

## Scope
v1: accounts, balanced multi-entry transactions, idempotent posting, overdraft protection, cached balances with
reconciliation. Later: reversals, concurrency + load numbers, balance-at-scale benchmark, HTTP API, fund layer.
Not in v1: multi-tenant key scoping, FX conversion, auth.

## Data model
See `migrations/001_init.sql`. `entries` is the only authority; `balances` can be dropped and rebuilt from it.

## Invariants
See the table in the README. Rule of thumb: the DB is the correctness floor, the app gives readable errors.

## Decisions
| Decision | Why | Revisit when |
|---|---|---|
| Balance cache updated in the posting transaction (Option A) | O(1) reads; always consistent with entries | hot accounts make contention measurable |
| `READ COMMITTED` + explicit `FOR UPDATE` row locks, in account-id order | serializes only transfers that share an account; deterministic order prevents deadlocks | concurrency test results |
| Idempotency key inserted in the same DB transaction as the posting | no "in-flight" state is ever visible; retries block, then replay | posting gains external side effects (then: commit key first, Stripe-style) |
| Rejected requests (e.g. insufficient funds) don't store the key | the retry re-runs; simpler, and the client can fix and retry with the same key | clients need a failure to stay final |
| Keys are global, not per client | single-tenant v1 | adding an API with clients: `unique (client_id, key)` + retention |

## Known gaps
- A later DB transaction could append a balanced pair of entries to an old transaction. Fix: reject entries whose
  transaction was created in a different DB transaction.
- Hot accounts (e.g. `world`/clearing) serialize every deposit. Measured: one hot pair ≈ 570 tx/s, p99 ≈ 57 ms vs
  ≈ 2,370 tx/s on disjoint pairs. Options: split a hot account into N sub-accounts, or skip the balance lock for
  `allow_negative` accounts (no overdraft check needed) and update their cache asynchronously.

## Milestones (≤3 h each, green test + commit)
- [x] Scaffold, schema with DB-enforced invariants, `postTransaction` + idempotency, 15 tests, CI
- [x] Concurrency: parallel transfers stay zero-sum, no lost updates; same key fired 10× → one transaction;
      racing withdrawals can't overdraw; deadlock demo; posting benchmark (README)
- [ ] Reversals: `reverseTransaction()` posts the negated entries, linked to the original
- [ ] Balances at scale: seed ~1M entries, time naive `SUM` vs cached read
- [ ] HTTP API (`POST /transfers` with `Idempotency-Key` header) + p50/p99 under load
- [ ] Fund layer (capital calls, distributions, fees → capital account statement)
