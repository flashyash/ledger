import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "../src/db.ts";
import { InsufficientFundsError, createAccount, getBalance, postTransaction, reconcile } from "../src/ledger.ts";
import { TEST_DATABASE_URL } from "./global-setup.ts";

let pool: Pool;
let world: string;

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL, 20);
  world = await createAccount(pool, { name: "world", currency: "USD", allowNegative: true });
});
afterAll(() => pool.end());

const usd = (name: string) => createAccount(pool, { name, currency: "USD" });

function transfer(from: string, to: string, amount: bigint, idempotencyKey = randomUUID()) {
  return postTransaction(pool, {
    idempotencyKey,
    entries: [
      { accountId: from, amount: -amount },
      { accountId: to, amount },
    ],
  });
}

describe("concurrency", () => {
  it("100 parallel transfers between the same accounts: no lost updates", async () => {
    const [a, b] = [await usd("a"), await usd("b")];
    await transfer(world, a, 100_000n);

    await Promise.all(Array.from({ length: 100 }, () => transfer(a, b, 10n)));

    expect(await getBalance(pool, a)).toBe(99_000n);
    expect(await getBalance(pool, b)).toBe(1_000n);
    expect(await reconcile(pool)).toEqual([]);
  });

  it("transfers in both directions at once don't deadlock", async () => {
    const [a, b] = [await usd("a"), await usd("b")];
    await transfer(world, a, 10_000n);
    await transfer(world, b, 10_000n);

    await Promise.all(
      Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? transfer(a, b, 7n) : transfer(b, a, 3n))),
    );

    // 50 × (−7 + 3) for a, the mirror for b.
    expect(await getBalance(pool, a)).toBe(10_000n - 200n);
    expect(await getBalance(pool, b)).toBe(10_000n + 200n);
    expect(await reconcile(pool)).toEqual([]);
  });

  it("racing withdrawals can't overdraw: exactly as many succeed as the balance allows", async () => {
    const [a, b] = [await usd("a"), await usd("b")];
    await transfer(world, a, 50n);

    const results = await Promise.allSettled(Array.from({ length: 100 }, () => transfer(a, b, 1n)));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected");

    expect(ok).toBe(50);
    expect(rejected).toHaveLength(50);
    for (const r of rejected) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientFundsError);
    expect(await getBalance(pool, a)).toBe(0n);
  });

  it("the same idempotency key fired 10× at once creates exactly one transaction", async () => {
    const a = await usd("a");
    const k = randomUUID();

    const results = await Promise.all(Array.from({ length: 10 }, () => transfer(world, a, 250n, k)));

    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await getBalance(pool, a)).toBe(250n);
    const { rows } = await pool.query("select count(*)::int as n from entries where transaction_id = $1", [
      results[0].transactionId,
    ]);
    expect(rows[0].n).toBe(2);
  });

  // Why postTransaction sorts its locks: two transactions taking the same two row locks in
  // opposite order wait on each other forever, and Postgres has to kill one of them.
  it("locking in opposite order deadlocks (the bug the ORDER BY prevents)", async () => {
    const [a, b] = [await usd("a"), await usd("b")];
    const [c1, c2] = [await pool.connect(), await pool.connect()];
    const lock = (c: typeof c1, id: string) =>
      c.query("select balance from balances where account_id = $1 for update", [id]);
    try {
      await c1.query("begin");
      await c2.query("begin");
      await lock(c1, a);
      await lock(c2, b);
      const results = await Promise.allSettled([lock(c1, b), lock(c2, a)]);
      const deadlocked = results.filter(
        (r) => r.status === "rejected" && (r.reason as { code?: string }).code === "40P01",
      );
      expect(deadlocked).toHaveLength(1); // Postgres detects the cycle and aborts one side
    } finally {
      await c1.query("rollback");
      await c2.query("rollback");
      c1.release();
      c2.release();
    }
  });
});
