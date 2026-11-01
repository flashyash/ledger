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
| No covering index on `entries (account_id) INCLUDE (amount)` | reads come from the cache; the index only speeds up reconcile/history and costs every insert | balance-as-of-date queries or reconcile get slow |
| Amounts are JSON strings; numbers rejected | JSON numbers are IEEE doubles: integers above 2^53 round silently | never |
| Replays return the same 201 + `Idempotent-Replayed` header | a retrying client shouldn't need a second code path | — |
| Reversals obey the overdraft rule | reversing a spent deposit should be a human decision, not silent negative balance | modeling chargebacks (they can legitimately push an account negative) |
| Fund rules = overdraft guards on memo/receivable/cash accounts | one enforcement path, already concurrency-safe under the row locks | rules that aren't "balance ≥ 0" (e.g. recycling limits) |
| Calls allocated by unfunded commitment; fees, gains, distributions by commitment | per-call rounding by commitment drifts onto one LP until its last call fails | later closings / transfers (need ownership % over time) |
| A fund op that builds entries from current balances replays by key before recomputing | a retry after another call would compute different entries, so a hash check would wrongly 409 | — |
| Statement figures derived from entries by `effective_at`, nothing stored | one source of truth; any period can be re-run | statements must be frozen once sent (period close) |
| Keys are global, not per client | single-tenant v1 | adding an API with clients: `unique (client_id, key)` + retention |

## Known gaps
- The API has no auth, rate limiting or per-client key scoping. Anyone who can reach it can move money between any accounts.
- A later DB transaction could append a balanced pair of entries to an old transaction. Fix: reject entries whose
  transaction was created in a different DB transaction.
- "A reversal's entries exactly negate the original's" is checked by construction in the app, not by the DB.
  Partial reversals (refund $30 of $100) aren't supported; they'd be a normal transaction today.
- Hot accounts (e.g. `world`/clearing) serialize every deposit. Measured: one hot pair ≈ 570 tx/s, p99 ≈ 57 ms vs
  ≈ 2,370 tx/s on disjoint pairs. Options: split a hot account into N sub-accounts, or skip the balance lock for
  `allow_negative` accounts (no overdraft check needed) and update their cache asynchronously.

- Fund layer v1: one closing, fixed commitments, everything pro rata. No waterfall/carried interest, preferred
  return, equalization for later closings, recallable distributions, or fee offsets. Fees are an input amount,
  not computed from a rate.
- Ties in pro rata rounding always go to the earlier LP (by id), so over many fees/distributions the same LP can
  collect a few extra cents. Fix: rotate the tie-break, or allocate cumulatively.
- Backdated entries silently change already-issued statements. Real administrators close a period and post
  corrections in the current one.
- Replay-by-key for capital calls skips the request-hash check, so reusing a key for a *different* call returns
  the first call instead of a 409.

## Milestones (≤3 h each, green test + commit)
- [x] Scaffold, schema with DB-enforced invariants, `postTransaction` + idempotency, 15 tests, CI
- [x] Concurrency: parallel transfers stay zero-sum, no lost updates; same key fired 10× → one transaction;
      racing withdrawals can't overdraw; deadlock demo; posting benchmark (README)
- [x] Reversals: `reverseTransaction()` posts the negated entries, linked to the original; at most once (DB-enforced)
- [x] Balances at scale: 1M and 10M entries, naive `SUM` vs cached read vs covering index (README)
- [x] HTTP API (Fastify, `Idempotency-Key` header, string amounts, error codes) + p50/p99 under load (README)
- [x] Fund layer: capital calls, payments, fees, investments, valuations, distributions → capital account statement
