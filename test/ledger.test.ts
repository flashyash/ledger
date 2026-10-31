import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "../src/db.ts";
import {
  AccountNotFoundError,
  IdempotencyConflictError,
  InsufficientFundsError,
  ValidationError,
  createAccount,
  getBalance,
  postTransaction,
  reconcile,
} from "../src/ledger.ts";
import { TEST_DATABASE_URL } from "./global-setup.ts";

let pool: Pool;
let world: string; // external account money enters from; allowed to go negative

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  world = await createAccount(pool, { name: "world", currency: "USD", allowNegative: true });
});
afterAll(() => pool.end());

const key = () => randomUUID();
const usd = (name: string) => createAccount(pool, { name, currency: "USD" });

async function fund(accountId: string, amount: bigint) {
  return postTransaction(pool, {
    idempotencyKey: key(),
    description: "deposit",
    entries: [
      { accountId: world, amount: -amount },
      { accountId, amount },
    ],
  });
}

// Runs raw SQL in one DB transaction, bypassing the app, to prove the database enforces the invariants itself.
async function rawTxn(fn: (q: (sql: string, params?: unknown[]) => Promise<unknown>) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await fn((sql, params) => client.query(sql, params));
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

describe("accounts and balances", () => {
  it("a new account has a zero balance", async () => {
    expect(await getBalance(pool, await usd("alice"))).toBe(0n);
  });

  it("posting a transfer moves both balances and keeps the cache equal to the entries", async () => {
    const [a, b] = [await usd("a"), await usd("b")];
    await fund(a, 10_000n);
    const res = await postTransaction(pool, {
      idempotencyKey: key(),
      entries: [
        { accountId: a, amount: -2_500n },
        { accountId: b, amount: 2_500n },
      ],
    });
    expect(res.replayed).toBe(false);
    expect(await getBalance(pool, a)).toBe(7_500n);
    expect(await getBalance(pool, b)).toBe(2_500n);
    expect(await reconcile(pool)).toEqual([]);
  });

  it("rejects a transfer that would overdraw a normal account, and writes nothing", async () => {
    const [a, b] = [await usd("a"), await usd("b")];
    await fund(a, 100n);
    await expect(
      postTransaction(pool, {
        idempotencyKey: key(),
        entries: [
          { accountId: a, amount: -101n },
          { accountId: b, amount: 101n },
        ],
      }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await getBalance(pool, a)).toBe(100n);
    expect(await getBalance(pool, b)).toBe(0n);
  });

  it("rejects an unknown account", async () => {
    await expect(
      postTransaction(pool, {
        idempotencyKey: key(),
        entries: [
          { accountId: world, amount: -1n },
          { accountId: randomUUID(), amount: 1n },
        ],
      }),
    ).rejects.toBeInstanceOf(AccountNotFoundError);
  });
});

describe("zero-sum invariant", () => {
  it("app rejects entries that don't sum to zero", async () => {
    const a = await usd("a");
    await expect(
      postTransaction(pool, {
        idempotencyKey: key(),
        entries: [
          { accountId: world, amount: -100n },
          { accountId: a, amount: 99n },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("app rejects a cross-currency transfer that only sums to zero across currencies", async () => {
    const eur = await createAccount(pool, { name: "eur", currency: "EUR" });
    await expect(
      postTransaction(pool, {
        idempotencyKey: key(),
        entries: [
          { accountId: world, amount: -100n },
          { accountId: eur, amount: 100n },
        ],
      }),
    ).rejects.toThrow(/USD/);
  });

  it("app rejects fewer than 2 entries and zero amounts", async () => {
    const a = await usd("a");
    await expect(
      postTransaction(pool, { idempotencyKey: key(), entries: [{ accountId: a, amount: 5n }] }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      postTransaction(pool, {
        idempotencyKey: key(),
        entries: [
          { accountId: a, amount: 0n },
          { accountId: world, amount: 0n },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("DB rejects an unbalanced transaction at commit even when the app is bypassed", async () => {
    const a = await usd("a");
    await expect(
      rawTxn(async (q) => {
        const id = randomUUID();
        await q("insert into transactions (id) values ($1)", [id]);
        await q("insert into entries (transaction_id, account_id, currency, amount) values ($1, $2, 'USD', -100), ($1, $3, 'USD', 99)", [id, world, a]);
      }),
    ).rejects.toThrow(/does not sum to zero/);
  });

  it("DB rejects a transaction with one entry or none", async () => {
    await expect(
      rawTxn(async (q) => {
        const id = randomUUID();
        await q("insert into transactions (id) values ($1)", [id]);
        await q("insert into entries (transaction_id, account_id, currency, amount) values ($1, $2, 'USD', 100)", [id, world]);
      }),
    ).rejects.toThrow(/needs at least 2/);
    await expect(
      rawTxn(async (q) => {
        await q("insert into transactions (id) values ($1)", [randomUUID()]);
      }),
    ).rejects.toThrow(/has 0 entries/);
  });

  it("DB rejects an entry whose currency doesn't match its account", async () => {
    const eur = await createAccount(pool, { name: "eur", currency: "EUR" });
    await expect(
      rawTxn(async (q) => {
        const id = randomUUID();
        await q("insert into transactions (id) values ($1)", [id]);
        await q("insert into entries (transaction_id, account_id, currency, amount) values ($1, $2, 'USD', -100), ($1, $3, 'USD', 100)", [id, world, eur]);
      }),
    ).rejects.toThrow(/foreign key/);
  });
});

describe("append-only history", () => {
  it("DB refuses to update or delete entries and transactions", async () => {
    const a = await usd("a");
    const { transactionId } = await fund(a, 500n);
    await expect(pool.query("update entries set amount = amount * 2 where transaction_id = $1", [transactionId])).rejects.toThrow(/append-only/);
    await expect(pool.query("delete from entries where transaction_id = $1", [transactionId])).rejects.toThrow(/append-only/);
    await expect(pool.query("delete from transactions where id = $1", [transactionId])).rejects.toThrow(/append-only/);
    await expect(pool.query("truncate entries cascade")).rejects.toThrow(/append-only/);
  });
});

describe("idempotency", () => {
  it("same key + same body returns the original result and moves money once", async () => {
    const a = await usd("a");
    const req = {
      idempotencyKey: key(),
      entries: [
        { accountId: world, amount: -700n },
        { accountId: a, amount: 700n },
      ],
    };
    const first = await postTransaction(pool, req);
    const second = await postTransaction(pool, req);
    expect(second).toEqual({ transactionId: first.transactionId, replayed: true });
    expect(await getBalance(pool, a)).toBe(700n);
  });

  it("entry order doesn't change the request's identity", async () => {
    const a = await usd("a");
    const k = key();
    const first = await postTransaction(pool, {
      idempotencyKey: k,
      entries: [
        { accountId: world, amount: -1n },
        { accountId: a, amount: 1n },
      ],
    });
    const second = await postTransaction(pool, {
      idempotencyKey: k,
      entries: [
        { accountId: a, amount: 1n },
        { accountId: world, amount: -1n },
      ],
    });
    expect(second.transactionId).toBe(first.transactionId);
  });

  it("same key + different body is rejected as a client bug", async () => {
    const a = await usd("a");
    const k = key();
    await postTransaction(pool, {
      idempotencyKey: k,
      entries: [
        { accountId: world, amount: -100n },
        { accountId: a, amount: 100n },
      ],
    });
    await expect(
      postTransaction(pool, {
        idempotencyKey: k,
        entries: [
          { accountId: world, amount: -999n },
          { accountId: a, amount: 999n },
        ],
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await getBalance(pool, a)).toBe(100n);
  });

  it("a rejected request doesn't consume its key: the retry runs again (v1 decision)", async () => {
    const [a, b] = [await usd("a"), await usd("b")];
    const req = {
      idempotencyKey: key(),
      entries: [
        { accountId: a, amount: -50n },
        { accountId: b, amount: 50n },
      ],
    };
    await expect(postTransaction(pool, req)).rejects.toBeInstanceOf(InsufficientFundsError);
    await fund(a, 50n);
    expect((await postTransaction(pool, req)).replayed).toBe(false);
    expect(await getBalance(pool, b)).toBe(50n);
  });
});
