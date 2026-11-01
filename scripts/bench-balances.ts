// Balance reads at scale: cached balance vs SUM over the entries, on a ~1M-entry ledger.
// Run: npm run db:up && npm run bench:balances   (ENTRIES=1000000 by default; uses its own ledger_bench database)
import pg from "pg";
import { createPool, DEFAULT_DATABASE_URL, type Client } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { reconcile } from "../src/ledger.ts";

const ENTRIES = Number(process.env.ENTRIES ?? 1_000_000);
const USERS = 1_000;
const BENCH_URL = process.env.BENCH_DATABASE_URL ?? "postgres://ledger:ledger@localhost:5433/ledger_bench";

const admin = new pg.Client({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL });
await admin.connect();
if ((await admin.query("select 1 from pg_database where datname = 'ledger_bench'")).rowCount === 0) {
  await admin.query("create database ledger_bench");
}
await admin.end();

const pool = createPool(BENCH_URL, 2);
await pool.query("drop schema public cascade; create schema public;");
await migrate(pool);
const db = await pool.connect();

// --- Seed -------------------------------------------------------------------------------------------------
// Posting 500k transactions one by one would take minutes, so the seed bulk-inserts with SQL. That means
// bypassing the per-row triggers (session_replication_role = replica also skips FK checks), so afterwards we
// verify the data the slow way: every transaction balances and every cached balance equals its entries.
console.log(`seeding ${ENTRIES.toLocaleString()} entries (${(ENTRIES / 2).toLocaleString()} deposits, 1 world + ${USERS} users)…`);
let t0 = performance.now();
await db.query("begin");
await db.query("set local session_replication_role = replica");
const world = (
  await db.query<{ id: string }>(
    "insert into accounts (name, currency, allow_negative) values ('world', 'USD', true) returning id",
  )
).rows[0].id;
await db.query(
  `insert into accounts (name, currency) select 'user-' || g, 'USD' from generate_series(0, $1 - 1) g`,
  [USERS],
);
await db.query("insert into balances (account_id) select id from accounts");
await db.query(
  `create temp table seed on commit drop as
     select gen_random_uuid() as txn, g, (1 + g % 10000)::bigint as amount from generate_series(1, $1 / 2) g`,
  [ENTRIES],
);
await db.query(
  `create temp table users on commit drop as
     select id, (row_number() over (order by id)) - 1 as rn from accounts where name like 'user-%'`,
);
await db.query("insert into transactions (id, description) select txn, 'seed deposit' from seed");
// Interleave world/user entries by transaction, the way real postings would land.
await db.query(
  `insert into entries (transaction_id, account_id, currency, amount)
   select s.txn, x.account_id, 'USD', x.amount
     from seed s join users u on u.rn = s.g % $2,
          lateral (values ($1::uuid, -s.amount), (u.id, s.amount)) as x(account_id, amount)
    order by s.g`,
  [world, USERS],
);
await db.query(
  `update balances b set balance = t.total
     from (select account_id, sum(amount)::bigint as total from entries group by account_id) t
    where b.account_id = t.account_id`,
);
await db.query("commit");
await db.query("vacuum analyze");
console.log(`  seeded in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

t0 = performance.now();
const unbalanced = await db.query(
  `select count(*)::int as n from (select transaction_id from entries group by transaction_id
    having sum(amount) <> 0 or count(*) < 2) x`,
);
const drift = await reconcile(pool);
if (unbalanced.rows[0].n !== 0 || drift.length !== 0) throw new Error("seed data violates ledger invariants");
console.log(`  verified: every transaction balances, 0 drifted balances (${((performance.now() - t0) / 1000).toFixed(1)} s)`);

// --- Measure ----------------------------------------------------------------------------------------------
const user = (await db.query<{ id: string }>("select id from accounts where name = 'user-0'")).rows[0].id;
const counts = await db.query<{ account_id: string; n: number }>(
  "select account_id, count(*)::int as n from entries where account_id = any($1) group by account_id",
  [[world, user]],
);
const entriesFor = new Map(counts.rows.map((r) => [r.account_id, r.n]));

interface PlanNode {
  "Node Type": string;
  "Heap Fetches"?: number;
  Plans?: PlanNode[];
}
const describe = (n: PlanNode): string =>
  n["Node Type"] + (n["Heap Fetches"] !== undefined ? ` (heap fetches ${n["Heap Fetches"]})` : "") +
  (n.Plans?.length ? " ← " + n.Plans.map(describe).join(", ") : "");

async function time(c: Client, label: string, sql: string, params: unknown[], runs = 30) {
  for (let i = 0; i < 3; i++) await c.query(sql, params); // warm the cache: we measure the query, not the disk
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    await c.query(sql, params);
    ms.push(performance.now() - s);
  }
  ms.sort((a, b) => a - b);
  const plan = await c.query(`explain (analyze, format json) ${sql}`, params);
  console.log(
    `${label.padEnd(44)} p50 ${ms[Math.floor(runs / 2)].toFixed(2).padStart(8)} ms   p99 ${ms[runs - 1].toFixed(2).padStart(8)} ms   ${describe(plan.rows[0]["QUERY PLAN"][0].Plan)}`,
  );
}

const CACHED = "select balance from balances where account_id = $1";
const SUM = "select coalesce(sum(amount), 0)::bigint from entries where account_id = $1";
const n = (id: string) => (entriesFor.get(id) ?? 0).toLocaleString();

console.log("\nbalance read for one account (30 runs each, warm cache)");
await time(db, `cached balance, world`, CACHED, [world]);
await time(db, `SUM over ${n(user)} entries (typical user)`, SUM, [user]);
await time(db, `SUM over ${n(world)} entries (world)`, SUM, [world]);

// Experiment: a covering index lets Postgres answer SUM from the index alone (no table reads).
// Still O(entries) per read, and it costs every insert, so it's measured here, not shipped.
await db.query("create index entries_account_amount_idx on entries (account_id) include (amount)");
await db.query("vacuum analyze entries");
await time(db, `SUM, typical user + covering index`, SUM, [user]);
await time(db, `SUM, world + covering index`, SUM, [world]);
// The planner may still prefer a parallel seq scan for an account that owns half the table. Force the index to see its cost.
await db.query("set enable_seqscan = off");
await time(db, `SUM, world + covering index (forced)`, SUM, [world]);
await db.query("reset enable_seqscan");
await db.query("drop index entries_account_amount_idx");

t0 = performance.now();
for (let i = 0; i < 3; i++) await reconcile(pool);
console.log(`\nreconcile() over all ${(USERS + 1).toLocaleString()} accounts: ${((performance.now() - t0) / 3).toFixed(0)} ms per run`);

db.release();
await pool.end();
