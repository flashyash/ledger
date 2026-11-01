import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "../src/db.ts";
import {
  CommitmentExceededError,
  OverpaymentError,
  allocate,
  chargeManagementFee,
  createFund,
  distribute,
  getCapitalAccountStatement,
  invest,
  issueCapitalCall,
  recordCallPayment,
  recordValuation,
  type Fund,
} from "../src/fund.ts";
import { InsufficientFundsError, getBalance, reconcile } from "../src/ledger.ts";
import { TEST_DATABASE_URL } from "./global-setup.ts";

let pool: Pool;
beforeAll(() => {
  pool = createPool(TEST_DATABASE_URL);
});
afterAll(() => pool.end());

const $ = (dollars: number) => BigInt(Math.round(dollars * 100)); // dollars → cents
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const key = () => randomUUID();

function newFund(lps: [string, bigint][]) {
  return createFund(pool, {
    name: `fund-${randomUUID().slice(0, 8)}`,
    currency: "USD",
    lps: lps.map(([name, commitment]) => ({ name, commitment })),
  });
}

const lp = (fund: Fund, name: string) => fund.lps.find((l) => l.name === name)!;
const unfunded = (fund: Fund) => Promise.all(fund.lps.map((l) => getBalance(pool, l.accounts.uncalled)));

// Assets = LP capital: the fund's balance sheet balances because every fund transaction is zero-sum.
async function assertBalanceSheet(fund: Fund) {
  const bal = (id: string) => getBalance(pool, id);
  let assets = (await bal(fund.accounts.cash)) + (await bal(fund.accounts.investments));
  let capital = 0n;
  for (const l of fund.lps) {
    assets += await bal(l.accounts.receivable);
    for (const k of ["contributions", "distributions", "fees", "gains"] as const) capital -= await bal(l.accounts[k]);
  }
  expect(assets).toBe(capital);
}

describe("allocate", () => {
  it("splits proportionally and always sums to the total", () => {
    expect(allocate(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(allocate(-100n, [1n, 1n, 1n])).toEqual([-34n, -33n, -33n]);
    expect(allocate(1n, [1n, 1n])).toEqual([1n, 0n]);
    expect(allocate(1000n, [6n, 3n, 1n])).toEqual([600n, 300n, 100n]);
    expect(allocate(10n, [1n, 0n, 2n])).toEqual([3n, 0n, 7n]); // 3.33 / 6.67: the larger remainder gets the cent
  });

  it("holds for random inputs: exact sum, each part within one unit of exact", () => {
    for (let n = 0; n < 1000; n++) {
      const weights = Array.from({ length: 1 + (n % 7) }, () => BigInt(Math.floor(Math.random() * 1e9)) + 1n);
      const total = BigInt(Math.floor(Math.random() * 1e12)) - 5n * 10n ** 11n;
      const parts = allocate(total, weights);
      expect(parts.reduce((a, b) => a + b, 0n)).toBe(total);
      const sum = weights.reduce((a, b) => a + b, 0n);
      parts.forEach((p, i) => {
        const exactTimesSum = total * weights[i]; // compare p × sum to the exact share × sum
        const diff = p * sum - exactTimesSum;
        expect(diff < 0n ? -diff : diff).toBeLessThan(sum);
      });
    }
  });
});

describe("fund lifecycle → capital account statement", () => {
  it("produces the statement a fund administrator would", async () => {
    const fund = await newFund([
      ["A", $(6_000_000)],
      ["B", $(3_000_000)],
      ["C", $(1_000_000)],
    ]);
    const [A, B, C] = ["A", "B", "C"].map((n) => lp(fund, n));
    const op = (iso: string) => ({ fundId: fund.id, idempotencyKey: key(), effectiveAt: day(iso) });

    await issueCapitalCall(pool, { ...op("2026-01-15"), amount: $(2_000_000) }); // A 1.2M, B 600k, C 200k
    await recordCallPayment(pool, { ...op("2026-01-29"), lpId: A.id, amount: $(1_200_000) });
    await recordCallPayment(pool, { ...op("2026-01-29"), lpId: B.id, amount: $(600_000) });
    await recordCallPayment(pool, { ...op("2026-01-30"), lpId: C.id, amount: $(150_000) }); // C still owes 50k
    await invest(pool, { ...op("2026-02-01"), amount: $(1_500_000) });
    await chargeManagementFee(pool, { ...op("2026-03-31"), amount: $(50_000) });
    await recordValuation(pool, { ...op("2026-06-30"), change: $(300_000) });
    await invest(pool, { ...op("2026-09-30"), amount: -$(500_000) }); // sale at carrying value
    await distribute(pool, { ...op("2026-09-30"), amount: $(400_000) });

    const h1 = await getCapitalAccountStatement(pool, {
      fundId: fund.id,
      lpId: A.id,
      from: day("2026-01-01"),
      to: day("2026-07-01"),
    });
    expect(h1).toMatchObject({
      commitment: $(6_000_000),
      beginningBalance: 0n,
      contributions: $(1_200_000),
      distributions: 0n,
      managementFees: $(30_000),
      gains: $(180_000),
      endingBalance: $(1_350_000),
      calledToDate: $(1_200_000),
      unfundedCommitment: $(4_800_000),
      outstandingCalls: 0n,
    });

    const h2 = await getCapitalAccountStatement(pool, {
      fundId: fund.id,
      lpId: A.id,
      from: day("2026-07-01"),
      to: day("2027-01-01"),
    });
    expect(h2).toMatchObject({
      beginningBalance: $(1_350_000), // = last period's ending
      contributions: 0n,
      distributions: $(240_000),
      managementFees: 0n,
      gains: 0n,
      endingBalance: $(1_110_000),
    });

    const c = await getCapitalAccountStatement(pool, {
      fundId: fund.id,
      lpId: C.id,
      from: day("2026-01-01"),
      to: day("2027-01-01"),
    });
    // Called capital counts in C's capital account even though 50k is unpaid; it shows as an outstanding call.
    expect(c).toMatchObject({ contributions: $(200_000), endingBalance: $(185_000), outstandingCalls: $(50_000) });

    expect(await getBalance(pool, fund.accounts.cash)).toBe($(500_000));
    expect(await getBalance(pool, fund.accounts.investments)).toBe($(1_300_000));
    await assertBalanceSheet(fund);
    expect(await reconcile(pool)).toEqual([]);
  });
});

describe("fund rules", () => {
  it("a call can't exceed unfunded commitments", async () => {
    const fund = await newFund([
      ["A", $(100)],
      ["B", $(100)],
    ]);
    await expect(
      issueCapitalCall(pool, { fundId: fund.id, idempotencyKey: key(), amount: $(200.01) }),
    ).rejects.toThrow(CommitmentExceededError);
    expect(await unfunded(fund)).toEqual([$(100), $(100)]); // nothing posted
  });

  it("rounding doesn't accumulate: calling the whole remainder lands exactly on every commitment", async () => {
    // Equal commitments of 100 cents, three calls of 100 cents. By commitment each call would be 34/33/33 and
    // the same LP would get the spare cent three times (102 > 100). By unfunded commitment it evens out.
    const fund = await newFund([
      ["A", 100n],
      ["B", 100n],
      ["C", 100n],
    ]);
    for (let i = 0; i < 3; i++) {
      await issueCapitalCall(pool, { fundId: fund.id, idempotencyKey: key(), amount: 100n });
    }
    expect(await unfunded(fund)).toEqual([0n, 0n, 0n]);
    await expect(issueCapitalCall(pool, { fundId: fund.id, idempotencyKey: key(), amount: 1n })).rejects.toThrow(
      CommitmentExceededError,
    );
  });

  it("an LP can't pay more than it owes", async () => {
    const fund = await newFund([["A", $(1000)]]);
    await issueCapitalCall(pool, { fundId: fund.id, idempotencyKey: key(), amount: $(100) });
    await expect(
      recordCallPayment(pool, { fundId: fund.id, idempotencyKey: key(), lpId: fund.lps[0].id, amount: $(100.01) }),
    ).rejects.toThrow(OverpaymentError);
  });

  it("fees and distributions need cash in the fund (called but unpaid capital isn't cash)", async () => {
    const fund = await newFund([["A", $(1000)]]);
    await issueCapitalCall(pool, { fundId: fund.id, idempotencyKey: key(), amount: $(100) });
    await expect(chargeManagementFee(pool, { fundId: fund.id, idempotencyKey: key(), amount: $(1) })).rejects.toThrow(
      InsufficientFundsError,
    );
    await recordCallPayment(pool, { fundId: fund.id, idempotencyKey: key(), lpId: fund.lps[0].id, amount: $(100) });
    await expect(distribute(pool, { fundId: fund.id, idempotencyKey: key(), amount: $(100.01) })).rejects.toThrow(
      InsufficientFundsError,
    );
  });

  it("a retried call with the same key is posted once, even after another call changed the weights", async () => {
    const fund = await newFund([
      ["A", 100n],
      ["B", 200n],
    ]);
    const k = key();
    const first = await issueCapitalCall(pool, { fundId: fund.id, idempotencyKey: k, amount: 10n });
    await issueCapitalCall(pool, { fundId: fund.id, idempotencyKey: key(), amount: 7n });
    const retry = await issueCapitalCall(pool, { fundId: fund.id, idempotencyKey: k, amount: 10n });
    expect(retry).toEqual({ transactionId: first.transactionId, replayed: true });
    const left = await unfunded(fund);
    expect(left[0] + left[1]).toBe(300n - 17n);
  });

  it("concurrent calls that together exceed commitments: exactly one succeeds", async () => {
    const fund = await newFund([
      ["A", $(600)],
      ["B", $(400)],
    ]);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        issueCapitalCall(pool, { fundId: fund.id, idempotencyKey: key(), amount: $(600) }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(CommitmentExceededError);
    expect(await getBalance(pool, lp(fund, "A").accounts.uncalled)).toBe($(240));
    expect(await getBalance(pool, lp(fund, "B").accounts.uncalled)).toBe($(160));
    await assertBalanceSheet(fund);
  });
});
