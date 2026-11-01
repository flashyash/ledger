// Runs a year of a small fund and prints each LP's capital account statement.
// Run: npm run db:up && npm run migrate && npm run demo:fund
import { randomUUID } from "node:crypto";
import { createPool } from "../src/db.ts";
import {
  chargeManagementFee,
  createFund,
  distribute,
  getCapitalAccountStatement,
  invest,
  issueCapitalCall,
  recordCallPayment,
  recordValuation,
} from "../src/fund.ts";

const pool = createPool();
const $ = (dollars: number) => BigInt(Math.round(dollars * 100));
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const fmt = (cents: bigint) => {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const s = `${(abs / 100n).toLocaleString("en-US")}.${(abs % 100n).toString().padStart(2, "0")}`;
  return neg ? `(${s})` : s;
};

const fund = await createFund(pool, {
  name: `Demo Fund ${new Date().toISOString().slice(0, 19)}`,
  currency: "USD",
  lps: [
    { name: "Pension Plan", commitment: $(6_000_000) },
    { name: "Endowment", commitment: $(3_000_000) },
    { name: "Family Office", commitment: $(1_000_000) },
  ],
});
const op = (iso: string) => ({ fundId: fund.id, idempotencyKey: randomUUID(), effectiveAt: day(iso) });
const [pension, endowment, family] = ["Pension Plan", "Endowment", "Family Office"].map(
  (n) => fund.lps.find((l) => l.name === n)!,
);

await issueCapitalCall(pool, { ...op("2026-01-15"), amount: $(2_000_000) });
await recordCallPayment(pool, { ...op("2026-01-29"), lpId: pension.id, amount: $(1_200_000) });
await recordCallPayment(pool, { ...op("2026-01-29"), lpId: endowment.id, amount: $(600_000) });
await recordCallPayment(pool, { ...op("2026-01-30"), lpId: family.id, amount: $(150_000) });
await invest(pool, { ...op("2026-02-01"), amount: $(1_500_000) });
await chargeManagementFee(pool, { ...op("2026-03-31"), amount: $(50_000) });
await recordValuation(pool, { ...op("2026-06-30"), change: $(300_000) });
await invest(pool, { ...op("2026-09-30"), amount: -$(500_000) });
await distribute(pool, { ...op("2026-09-30"), amount: $(400_000) });

for (const lp of fund.lps) {
  const s = await getCapitalAccountStatement(pool, { fundId: fund.id, lpId: lp.id, from: day("2026-01-01"), to: day("2027-01-01") });
  const rows: [string, bigint][] = [
    ["Beginning balance", s.beginningBalance],
    ["Contributions", s.contributions],
    ["Distributions", -s.distributions],
    ["Management fees", -s.managementFees],
    ["Net gains / (losses)", s.gains],
    ["Ending balance", s.endingBalance],
    ["", 0n],
    ["Commitment", s.commitment],
    ["Called to date", s.calledToDate],
    ["Unfunded commitment", s.unfundedCommitment],
    ["Outstanding calls", s.outstandingCalls],
  ];
  console.log(`\n${s.fund}: ${s.lp}, 2026-01-01 to 2026-12-31`);
  for (const [label, v] of rows) console.log(label ? `  ${label.padEnd(22)} ${fmt(v).padStart(16)}` : "");
}
await pool.end();
