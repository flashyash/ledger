import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { createPool, type Pool } from "../src/db.ts";
import { TEST_DATABASE_URL } from "./global-setup.ts";

let pool: Pool;
let app: ReturnType<typeof buildApp>;
let world: string;

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  app = buildApp(pool);
  world = (await createAccount("world", true)).id;
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

async function createAccount(name: string, allowNegative = false) {
  const res = await app.inject({ method: "POST", url: "/accounts", payload: { name, currency: "USD", allowNegative } });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; balance: string };
}

function post(payload: unknown, key: string | null = randomUUID()) {
  return app.inject({
    method: "POST",
    url: "/transactions",
    headers: key === null ? {} : { "idempotency-key": key },
    payload: payload as object,
  });
}

const move = (from: string, to: string, amount: string) => ({
  entries: [
    { accountId: from, amount: `-${amount}` },
    { accountId: to, amount },
  ],
});

const balance = async (id: string) => (await app.inject({ url: `/accounts/${id}` })).json().balance as string;

describe("HTTP API", () => {
  it("creates an account and reads its balance as a string", async () => {
    const acct = await createAccount("alice");
    expect(acct.balance).toBe("0");
    expect(await balance(acct.id)).toBe("0");
  });

  it("posts a transaction and returns it with its entries", async () => {
    const a = (await createAccount("a")).id;
    const res = await post({ description: "deposit", ...move(world, a, "1500") });
    expect(res.statusCode).toBe(201);
    const { transactionId } = res.json();

    const txn = (await app.inject({ url: `/transactions/${transactionId}` })).json();
    expect(txn.description).toBe("deposit");
    expect(txn.entries).toEqual([
      { accountId: world, currency: "USD", amount: "-1500" },
      { accountId: a, currency: "USD", amount: "1500" },
    ]);
    expect(await balance(a)).toBe("1500");
  });

  it("a retried request returns the same response, marked as a replay", async () => {
    const a = (await createAccount("a")).id;
    const key = randomUUID();
    const first = await post(move(world, a, "100"), key);
    const retry = await post(move(world, a, "100"), key);
    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toEqual(first.json());
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(await balance(a)).toBe("100");
  });

  it("maps domain errors to status codes with stable error codes", async () => {
    const [a, b] = [(await createAccount("a")).id, (await createAccount("b")).id];
    const key = randomUUID();
    await post(move(world, a, "10"), key);

    const cases: [Promise<{ statusCode: number; json: () => { error: string } }>, number, string][] = [
      [post(move(world, a, "10"), null), 400, "validation_error"], // no Idempotency-Key
      [post(move(world, a, "999"), key), 409, "idempotency_key_reused"],
      [post(move(a, b, "11")), 422, "insufficient_funds"],
      [post(move(world, randomUUID(), "1")), 404, "account_not_found"],
      [post({ entries: [{ accountId: world, amount: "-5" }, { accountId: a, amount: "4" }] }), 400, "validation_error"],
      [app.inject({ url: `/accounts/${randomUUID()}` }), 404, "account_not_found"],
      [app.inject({ url: "/transactions/not-a-uuid" }), 404, "transaction_not_found"],
    ];
    for (const [req, status, error] of cases) {
      const res = await req;
      expect([res.statusCode, res.json().error]).toEqual([status, error]);
    }
  });

  it("rejects amounts sent as JSON numbers, decimals, and unknown fields", async () => {
    const a = (await createAccount("a")).id;
    const bad = [
      { entries: [{ accountId: world, amount: -100 }, { accountId: a, amount: 100 }] },
      move(world, a, "1.50"),
      { ...move(world, a, "1"), memo: "hi" },
      { entries: [{ accountId: a, amount: "1" }] },
    ];
    for (const payload of bad) expect((await post(payload)).statusCode).toBe(400);
    expect(await balance(a)).toBe("0");
  });

  it("handles amounts beyond JavaScript's safe integer range exactly", async () => {
    const a = (await createAccount("a")).id;
    const huge = "9007199254740993"; // 2^53 + 1: a JSON number would silently round this
    expect((await post(move(world, a, huge))).statusCode).toBe(201);
    expect(await balance(a)).toBe(huge);
  });

  it("reverses a transaction once", async () => {
    const a = (await createAccount("a")).id;
    const { transactionId } = (await post(move(world, a, "300"))).json();
    const reverse = () =>
      app.inject({
        method: "POST",
        url: `/transactions/${transactionId}/reverse`,
        headers: { "idempotency-key": randomUUID() },
      });

    const res = await reverse();
    expect(res.statusCode).toBe(201);
    expect(await balance(a)).toBe("0");
    const original = (await app.inject({ url: `/transactions/${transactionId}` })).json();
    expect(original.reversedById).toBe(res.json().transactionId);

    const again = await reverse();
    expect([again.statusCode, again.json().error]).toEqual([409, "already_reversed"]);
  });
});
