import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "../src/db.ts";
import {
  AlreadyReversedError,
  InsufficientFundsError,
  TransactionNotFoundError,
  createAccount,
  getBalance,
  postTransaction,
  reconcile,
  reverseTransaction,
} from "../src/ledger.ts";
import { TEST_DATABASE_URL } from "./global-setup.ts";

let pool: Pool;
let world: string;

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  world = await createAccount(pool, { name: "world", currency: "USD", allowNegative: true });
});
afterAll(() => pool.end());

const usd = (name: string) => createAccount(pool, { name, currency: "USD" });

function transfer(from: string, to: string, amount: bigint) {
  return postTransaction(pool, {
    idempotencyKey: randomUUID(),
    entries: [
      { accountId: from, amount: -amount },
      { accountId: to, amount },
    ],
  });
}

const reverse = (transactionId: string, idempotencyKey = randomUUID()) =>
  reverseTransaction(pool, { transactionId, idempotencyKey });

describe("reversals", () => {
  it("restores both balances and keeps the original in history", async () => {
    const [a, b] = [await usd("a"), await usd("b")];
    await transfer(world, a, 1_000n);
    const { transactionId: original } = await transfer(a, b, 300n);

    const { transactionId: reversal } = await reverse(original);

    expect(await getBalance(pool, a)).toBe(1_000n);
    expect(await getBalance(pool, b)).toBe(0n);
    const { rows } = await pool.query<{ transaction_id: string; account_id: string; amount: bigint }>(
      "select transaction_id, account_id, amount from entries where transaction_id = any($1) order by id",
      [[original, reversal]],
    );
    expect(rows.map((r) => [r.transaction_id, r.account_id, r.amount])).toEqual([
      [original, a, -300n],
      [original, b, 300n],
      [reversal, a, 300n],
      [reversal, b, -300n],
    ]);
    const link = await pool.query("select reverses_id from transactions where id = $1", [reversal]);
    expect(link.rows[0].reverses_id).toBe(original);
    expect(await reconcile(pool)).toEqual([]);
  });

  it("can't reverse the same transaction twice", async () => {
    const a = await usd("a");
    const { transactionId } = await transfer(world, a, 100n);
    await reverse(transactionId);
    await expect(reverse(transactionId)).rejects.toBeInstanceOf(AlreadyReversedError);
    expect(await getBalance(pool, a)).toBe(0n);
  });

  it("retrying a reversal with the same key replays it", async () => {
    const a = await usd("a");
    const { transactionId } = await transfer(world, a, 100n);
    const k = randomUUID();
    const first = await reverse(transactionId, k);
    const second = await reverse(transactionId, k);
    expect(second).toEqual({ transactionId: first.transactionId, replayed: true });
  });

  it("can't reverse a deposit whose money was already spent", async () => {
    const [a, b] = [await usd("a"), await usd("b")];
    const { transactionId: deposit } = await transfer(world, a, 100n);
    await transfer(a, b, 80n);
    await expect(reverse(deposit)).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await getBalance(pool, a)).toBe(20n);
  });

  it("rejects an unknown transaction", async () => {
    await expect(reverse(randomUUID())).rejects.toBeInstanceOf(TransactionNotFoundError);
  });

  it("10 racing reversals with different keys: exactly one wins", async () => {
    const [a, b] = [await usd("a"), await usd("b")];
    await transfer(world, a, 500n);
    const { transactionId } = await transfer(a, b, 500n);

    const results = await Promise.allSettled(Array.from({ length: 10 }, () => reverse(transactionId)));

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(AlreadyReversedError);
    }
    expect(await getBalance(pool, a)).toBe(500n);
    expect(await getBalance(pool, b)).toBe(0n);
  });

  it("DB refuses a second reversal even when the app is bypassed", async () => {
    const a = await usd("a");
    const { transactionId } = await transfer(world, a, 100n);
    await reverse(transactionId);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await expect(
        client.query("insert into transactions (reverses_id) values ($1)", [transactionId]),
      ).rejects.toThrow(/transactions_reverses_once/);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
