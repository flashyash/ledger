// Posting throughput + latency: one-at-a-time vs 20 concurrent on one hot account pair vs 20 concurrent on disjoint pairs.
// Run: npm run db:up && npm run migrate && npm run bench
import { randomUUID } from "node:crypto";
import { createPool } from "../src/db.ts";
import { createAccount, postTransaction } from "../src/ledger.ts";

const N = Number(process.env.N ?? 2000);
const CONCURRENCY = 20;
const pool = createPool(undefined, CONCURRENCY);

const pairs = await Promise.all(
  Array.from({ length: CONCURRENCY }, async (_, i) => {
    const a = await createAccount(pool, { name: `bench-a${i}`, currency: "USD", allowNegative: true });
    const b = await createAccount(pool, { name: `bench-b${i}`, currency: "USD", allowNegative: true });
    return [a, b] as const;
  }),
);

async function post([from, to]: readonly [string, string]): Promise<number> {
  const t0 = performance.now();
  await postTransaction(pool, {
    idempotencyKey: randomUUID(),
    entries: [
      { accountId: from, amount: -1n },
      { accountId: to, amount: 1n },
    ],
  });
  return performance.now() - t0;
}

async function run(name: string, workers: number, pairFor: (worker: number) => readonly [string, string]) {
  const latencies: number[] = [];
  let next = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: workers }, async (_, w) => {
      while (next < N) {
        next++;
        latencies.push(await post(pairFor(w)));
      }
    }),
  );
  const secs = (performance.now() - t0) / 1000;
  latencies.sort((x, y) => x - y);
  const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))];
  console.log(
    `${name.padEnd(34)} ${String(Math.round(N / secs)).padStart(6)} tx/s   p50 ${pct(50).toFixed(2)} ms   p99 ${pct(99).toFixed(2)} ms`,
  );
}

console.log(`N=${N} transfers per scenario, pool=${CONCURRENCY}`);
await run("sequential, one pair", 1, () => pairs[0]);
await run(`${CONCURRENCY} concurrent, one hot pair`, CONCURRENCY, () => pairs[0]);
await run(`${CONCURRENCY} concurrent, ${CONCURRENCY} disjoint pairs`, CONCURRENCY, (w) => pairs[w]);
await pool.end();
