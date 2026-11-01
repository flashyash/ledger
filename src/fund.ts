// Fund layer on top of the ledger: a private fund's books as ordinary accounts and balanced transactions.
//
// Sign convention is the ledger's: positive = debit. Assets (cash, investments, receivables) carry positive
// balances; LP equity (contributions, gains) carries negative ones. Every operation is one ledger transaction,
// so it is idempotent, atomic, and can't overdraw a guarded account.
//
// Per LP:  uncalled      memo: commitment not yet called. Can't go negative → a call can't exceed the commitment.
//          receivable    called but not yet paid. Can't go negative → an LP can't overpay.
//          contributions capital called (credit, negative)
//          distributions cash returned to the LP (debit, positive)
//          fees          management fees charged to the LP (debit, positive)
//          gains         allocated gains/losses (credit when positive)
// Fund:    cash, investments (at fair value), commitments (memo contra for `uncalled`).
import type { Pool } from "./db.ts";
import {
  InsufficientFundsError,
  ValidationError,
  findIdempotentResult,
  postTransaction,
  type EntryInput,
  type PostResult,
} from "./ledger.ts";

const FUND_KINDS = ["cash", "investments", "commitments"] as const;
const LP_KINDS = ["uncalled", "receivable", "contributions", "distributions", "fees", "gains"] as const;
type FundKind = (typeof FUND_KINDS)[number];
type LpKind = (typeof LP_KINDS)[number];

export interface Lp {
  id: string;
  name: string;
  commitment: bigint;
  accounts: Record<LpKind, string>;
}

export interface Fund {
  id: string;
  name: string;
  currency: string;
  accounts: Record<FundKind, string>;
  lps: Lp[]; // ordered by id: allocation tie-breaks depend on a stable order
}

export class FundNotFoundError extends Error {
  name = "FundNotFoundError";
}
export class CommitmentExceededError extends Error {
  name = "CommitmentExceededError";
}
export class OverpaymentError extends Error {
  name = "OverpaymentError";
}

// Splits `total` across `weights` so the parts are proportional and sum to exactly `total`.
// Largest remainder method: everyone gets floor(total × w / W), then the leftover minor units go one each to the
// largest fractional remainders (ties: earlier index). Negative totals allocate the magnitude and flip the sign.
export function allocate(total: bigint, weights: bigint[]): bigint[] {
  if (weights.length === 0 || weights.some((w) => w < 0n)) throw new ValidationError("weights must be non-negative");
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum === 0n) throw new ValidationError("weights must not all be zero");
  const sign = total < 0n ? -1n : 1n;
  const abs = total * sign;
  const parts = weights.map((w) => (abs * w) / sum);
  const remainders = weights.map((w, i) => ({ i, r: (abs * w) % sum }));
  let left = abs - parts.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of remainders) {
    if (left === 0n) break;
    parts[i] += 1n;
    left -= 1n;
  }
  return parts.map((p) => p * sign);
}

export async function createFund(
  pool: Pool,
  opts: { name: string; currency: string; lps: { name: string; commitment: bigint }[] },
): Promise<Fund> {
  if (opts.lps.length === 0) throw new ValidationError("a fund needs at least one LP");
  for (const lp of opts.lps) {
    if (typeof lp.commitment !== "bigint" || lp.commitment <= 0n) {
      throw new ValidationError(`commitment for ${lp.name} must be a positive bigint`);
    }
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ id: string }>(
      "insert into funds (name, currency) values ($1, $2) returning id",
      [opts.name, opts.currency],
    );
    const fundId = rows[0].id;

    const account = async (name: string, allowNegative: boolean, kind: string, lpId: string | null) => {
      const { rows } = await client.query<{ id: string }>(
        "insert into accounts (name, currency, allow_negative) values ($1, $2, $3) returning id",
        [name, opts.currency, allowNegative],
      );
      await client.query("insert into balances (account_id) values ($1)", [rows[0].id]);
      await client.query("insert into fund_accounts (fund_id, lp_id, kind, account_id) values ($1, $2, $3, $4)", [
        fundId,
        lpId,
        kind,
        rows[0].id,
      ]);
      return rows[0].id;
    };

    // Only the guards matter here: allow_negative = false is what enforces "no over-call", "no overpayment",
    // "no spending cash the fund doesn't have", "no negative investment value".
    const guarded = new Set<string>(["cash", "investments", "uncalled", "receivable", "distributions", "fees"]);
    for (const kind of FUND_KINDS) await account(`${opts.name}:${kind}`, !guarded.has(kind), kind, null);

    const commitments: EntryInput[] = [];
    for (const lp of opts.lps) {
      const { rows } = await client.query<{ id: string }>(
        "insert into fund_lps (fund_id, name, commitment) values ($1, $2, $3) returning id",
        [fundId, lp.name, lp.commitment.toString()],
      );
      for (const kind of LP_KINDS) {
        const id = await account(`${opts.name}:${lp.name}:${kind}`, !guarded.has(kind), kind, rows[0].id);
        if (kind === "uncalled") commitments.push({ accountId: id, amount: lp.commitment });
      }
    }

    // Record the commitments as memo entries in the same DB transaction, so a fund never exists without them.
    // Written directly rather than via postTransaction: the accounts are new and uncommitted, so there is nothing
    // to lock or replay. The deferred zero-sum trigger still checks it at COMMIT.
    const total = opts.lps.reduce((a, lp) => a + lp.commitment, 0n);
    const { rows: memo } = await client.query<{ account_id: string }>(
      "select account_id from fund_accounts where fund_id = $1 and kind = 'commitments'",
      [fundId],
    );
    commitments.push({ accountId: memo[0].account_id, amount: -total });
    const { rows: txn } = await client.query<{ id: string }>(
      "insert into transactions (description) values ($1) returning id",
      [`${opts.name}: commitments`],
    );
    await client.query(
      `insert into entries (transaction_id, account_id, currency, amount)
       select $1, t.account_id, $2, t.amount from unnest($3::uuid[], $4::bigint[]) as t(account_id, amount)`,
      [txn[0].id, opts.currency, commitments.map((e) => e.accountId), commitments.map((e) => e.amount.toString())],
    );
    await client.query(
      `update balances b set balance = d.amount from unnest($1::uuid[], $2::bigint[]) as d(account_id, amount)
        where b.account_id = d.account_id`,
      [commitments.map((e) => e.accountId), commitments.map((e) => e.amount.toString())],
    );

    await client.query("commit");
    return await getFund(pool, fundId);
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getFund(pool: Pool, fundId: string): Promise<Fund> {
  const { rows: funds } = await pool.query<{ id: string; name: string; currency: string }>(
    "select id, name, currency from funds where id::text = $1",
    [fundId],
  );
  if (funds.length === 0) throw new FundNotFoundError(`fund ${fundId} not found`);
  const { rows: lps } = await pool.query<{ id: string; name: string; commitment: bigint }>(
    "select id, name, commitment from fund_lps where fund_id = $1 order by id",
    [fundId],
  );
  const { rows: accts } = await pool.query<{ lp_id: string | null; kind: string; account_id: string }>(
    "select lp_id, kind, account_id from fund_accounts where fund_id = $1",
    [fundId],
  );
  const pick = (lpId: string | null) =>
    Object.fromEntries(accts.filter((a) => a.lp_id === lpId).map((a) => [a.kind, a.account_id]));
  return {
    ...funds[0],
    accounts: pick(null) as Record<FundKind, string>,
    lps: lps.map((lp) => ({ ...lp, accounts: pick(lp.id) as Record<LpKind, string> })),
  };
}

interface FundOp {
  fundId: string;
  idempotencyKey: string;
  effectiveAt?: Date;
  description?: string;
}

function positive(amount: bigint, what: string) {
  if (typeof amount !== "bigint" || amount <= 0n) throw new ValidationError(`${what} must be a positive bigint`);
}


// Posts one fund transaction and turns the ledger's generic overdraft error into the fund rule it broke.
async function post(pool: Pool, fund: Fund, op: FundOp, label: string, entries: EntryInput[]): Promise<PostResult> {
  try {
    return await postTransaction(pool, {
      idempotencyKey: op.idempotencyKey,
      effectiveAt: op.effectiveAt,
      description: op.description ?? `${fund.name}: ${label}`,
      entries: entries.filter((e) => e.amount !== 0n), // an LP whose share rounds to 0 gets no entry
    });
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      const lp = fund.lps.find((l) => l.accounts.uncalled === err.accountId || l.accounts.receivable === err.accountId);
      if (lp?.accounts.uncalled === err.accountId) {
        throw new CommitmentExceededError(`${label} exceeds ${lp.name}'s unfunded commitment`);
      }
      if (lp) throw new OverpaymentError(`${label} exceeds what ${lp.name} owes`);
    }
    throw err;
  }
}

// Pro rata by commitment. v1 has one closing and fixed commitments, so commitment share = ownership share.
const shares = (fund: Fund, total: bigint) => allocate(total, fund.lps.map((lp) => lp.commitment));

// A capital call notice: each LP now owes its pro rata share. No cash moves yet.
//   uncalled −s, commitments +S   (memo: the commitment is used up)
//   receivable +s, contributions −s
//
// Calls are allocated by *unfunded* commitment, not original commitment. Rounding each call by commitment would hand
// the same LP the spare cent every time, so by the last call it could owe a few cents more than it has left and the
// call would fail. Weighting by what's left makes a call for the whole remainder land exactly on every commitment.
// Because the entries depend on current balances, a retry replays by key before recomputing them.
export async function issueCapitalCall(pool: Pool, op: FundOp & { amount: bigint }): Promise<PostResult> {
  positive(op.amount, "call amount");
  const prior = await findIdempotentResult(pool, op.idempotencyKey);
  if (prior) return { transactionId: prior, replayed: true };
  const fund = await getFund(pool, op.fundId);
  const { rows } = await pool.query<{ account_id: string; balance: bigint }>(
    "select account_id, balance from balances where account_id = any($1::uuid[])",
    [fund.lps.map((lp) => lp.accounts.uncalled)],
  );
  const unfunded = fund.lps.map((lp) => rows.find((r) => r.account_id === lp.accounts.uncalled)!.balance);
  if (unfunded.every((u) => u === 0n)) throw new CommitmentExceededError("the fund is fully called");
  const s = allocate(op.amount, unfunded);
  return post(pool, fund, op, "capital call", [
    { accountId: fund.accounts.commitments, amount: op.amount },
    ...fund.lps.flatMap((lp, i) => [
      { accountId: lp.accounts.uncalled, amount: -s[i] },
      { accountId: lp.accounts.receivable, amount: s[i] },
      { accountId: lp.accounts.contributions, amount: -s[i] },
    ]),
  ]);
}

// An LP's wire arrives: cash +a, receivable −a. Partial payments are fine; paying more than owed is not.
export async function recordCallPayment(
  pool: Pool,
  op: FundOp & { lpId: string; amount: bigint },
): Promise<PostResult> {
  positive(op.amount, "payment");
  const fund = await getFund(pool, op.fundId);
  const lp = fund.lps.find((l) => l.id === op.lpId);
  if (!lp) throw new ValidationError(`LP ${op.lpId} is not in fund ${fund.name}`);
  return post(pool, fund, op, `payment from ${lp.name}`, [
    { accountId: fund.accounts.cash, amount: op.amount },
    { accountId: lp.accounts.receivable, amount: -op.amount },
  ]);
}

// Management fee paid out of fund cash to the manager, borne pro rata: fees +f, cash −F.
export async function chargeManagementFee(pool: Pool, op: FundOp & { amount: bigint }): Promise<PostResult> {
  positive(op.amount, "fee");
  const fund = await getFund(pool, op.fundId);
  const s = shares(fund, op.amount);
  return post(pool, fund, op, "management fee", [
    { accountId: fund.accounts.cash, amount: -op.amount },
    ...fund.lps.map((lp, i) => ({ accountId: lp.accounts.fees, amount: s[i] })),
  ]);
}

// Cash returned to LPs pro rata: distributions +d, cash −D.
export async function distribute(pool: Pool, op: FundOp & { amount: bigint }): Promise<PostResult> {
  positive(op.amount, "distribution");
  const fund = await getFund(pool, op.fundId);
  const s = shares(fund, op.amount);
  return post(pool, fund, op, "distribution", [
    { accountId: fund.accounts.cash, amount: -op.amount },
    ...fund.lps.map((lp, i) => ({ accountId: lp.accounts.distributions, amount: s[i] })),
  ]);
}

// Buy (amount > 0) or sell at carrying value (amount < 0): investments ±a, cash ∓a.
export async function invest(pool: Pool, op: FundOp & { amount: bigint }): Promise<PostResult> {
  if (typeof op.amount !== "bigint" || op.amount === 0n) throw new ValidationError("amount must be a non-zero bigint");
  const fund = await getFund(pool, op.fundId);
  return post(pool, fund, op, op.amount > 0n ? "investment" : "investment sale", [
    { accountId: fund.accounts.investments, amount: op.amount },
    { accountId: fund.accounts.cash, amount: -op.amount },
  ]);
}

// Mark investments to fair value; the change (positive = gain) is allocated to LPs: investments +g, gains −g.
export async function recordValuation(pool: Pool, op: FundOp & { change: bigint }): Promise<PostResult> {
  if (typeof op.change !== "bigint" || op.change === 0n) throw new ValidationError("change must be a non-zero bigint");
  const fund = await getFund(pool, op.fundId);
  const s = shares(fund, op.change);
  return post(pool, fund, op, op.change > 0n ? "unrealized gain" : "unrealized loss", [
    { accountId: fund.accounts.investments, amount: op.change },
    ...fund.lps.map((lp, i) => ({ accountId: lp.accounts.gains, amount: -s[i] })),
  ]);
}

// Capital account statement for one LP over [from, to), by effective date. All figures are positive-is-good from
// the LP's point of view (the ledger's credit balances flipped), the way a fund administrator prints them.
export interface CapitalAccountStatement {
  fund: string;
  lp: string;
  from: Date;
  to: Date;
  commitment: bigint;
  beginningBalance: bigint;
  contributions: bigint;
  distributions: bigint;
  managementFees: bigint;
  gains: bigint; // net of losses
  endingBalance: bigint;
  calledToDate: bigint;
  unfundedCommitment: bigint;
  outstandingCalls: bigint; // called but not yet paid
}

export async function getCapitalAccountStatement(
  pool: Pool,
  opts: { fundId: string; lpId: string; from: Date; to: Date },
): Promise<CapitalAccountStatement> {
  if (!(opts.from < opts.to)) throw new ValidationError("from must be before to");
  const fund = await getFund(pool, opts.fundId);
  const lp = fund.lps.find((l) => l.id === opts.lpId);
  if (!lp) throw new ValidationError(`LP ${opts.lpId} is not in fund ${fund.name}`);

  // One statement, one snapshot: every figure comes from the same view of the entries.
  const { rows } = await pool.query<{ kind: LpKind; before: bigint; during: bigint }>(
    `select fa.kind,
            coalesce(sum(e.amount) filter (where t.effective_at < $2), 0)::bigint as before,
            coalesce(sum(e.amount) filter (where t.effective_at >= $2 and t.effective_at < $3), 0)::bigint as during
       from fund_accounts fa
       left join entries e on e.account_id = fa.account_id
       left join transactions t on t.id = e.transaction_id
      where fa.lp_id = $1
      group by fa.kind`,
    [lp.id, opts.from, opts.to],
  );
  const before = (k: LpKind) => rows.find((r) => r.kind === k)?.before ?? 0n;
  const during = (k: LpKind) => rows.find((r) => r.kind === k)?.during ?? 0n;
  const equity: LpKind[] = ["contributions", "distributions", "fees", "gains"];

  const beginningBalance = -equity.reduce((a, k) => a + before(k), 0n);
  const contributions = -during("contributions");
  const distributions = during("distributions");
  const managementFees = during("fees");
  const gains = -during("gains");
  // From contributions, not the `uncalled` memo: the memo's opening entry is dated when the fund was created,
  // which can be after backdated activity. Only calls write to contributions, so this is "called as of `to`".
  const calledToDate = -(before("contributions") + during("contributions"));
  return {
    fund: fund.name,
    lp: lp.name,
    from: opts.from,
    to: opts.to,
    commitment: lp.commitment,
    beginningBalance,
    contributions,
    distributions,
    managementFees,
    gains,
    endingBalance: beginningBalance + contributions - distributions - managementFees + gains,
    calledToDate,
    unfundedCommitment: lp.commitment - calledToDate,
    outstandingCalls: before("receivable") + during("receivable"),
  };
}
