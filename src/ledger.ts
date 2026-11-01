import { createHash } from "node:crypto";
import type { Pool } from "./db.ts";

export interface EntryInput {
  accountId: string;
  amount: bigint; // signed minor units: negative = money leaves the account
}

export interface PostTransactionInput {
  idempotencyKey: string;
  description?: string;
  effectiveAt?: Date;
  entries: EntryInput[];
}

interface PostInput extends PostTransactionInput {
  reversesId?: string;
}

export interface PostResult {
  transactionId: string;
  replayed: boolean; // true when this key was already processed and we returned the stored result
}

export class ValidationError extends Error {
  name = "ValidationError";
}
export class AccountNotFoundError extends Error {
  name = "AccountNotFoundError";
}
export class InsufficientFundsError extends Error {
  name = "InsufficientFundsError";
}
export class IdempotencyConflictError extends Error {
  name = "IdempotencyConflictError";
}
export class TransactionNotFoundError extends Error {
  name = "TransactionNotFoundError";
}
export class AlreadyReversedError extends Error {
  name = "AlreadyReversedError";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createAccount(
  pool: Pool,
  opts: { name: string; currency: string; allowNegative?: boolean },
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ id: string }>(
      "insert into accounts (name, currency, allow_negative) values ($1, $2, $3) returning id",
      [opts.name, opts.currency, opts.allowNegative ?? false],
    );
    await client.query("insert into balances (account_id) values ($1)", [rows[0].id]);
    await client.query("commit");
    return rows[0].id;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function getBalance(pool: Pool, accountId: string): Promise<bigint> {
  const { rows } = await pool.query<{ balance: bigint }>(
    "select balance from balances where account_id = $1",
    [accountId],
  );
  if (rows.length === 0) throw new AccountNotFoundError(`account ${accountId} not found`);
  return rows[0].balance;
}

export interface Account {
  id: string;
  name: string;
  currency: string;
  allowNegative: boolean;
  balance: bigint;
}

export async function getAccount(pool: Pool, accountId: string): Promise<Account> {
  if (!UUID.test(accountId)) throw new AccountNotFoundError(`account ${accountId} not found`);
  const { rows } = await pool.query<{
    id: string;
    name: string;
    currency: string;
    allow_negative: boolean;
    balance: bigint;
  }>(
    `select a.id, a.name, a.currency, a.allow_negative, b.balance
       from accounts a join balances b on b.account_id = a.id where a.id = $1`,
    [accountId],
  );
  if (rows.length === 0) throw new AccountNotFoundError(`account ${accountId} not found`);
  const r = rows[0];
  return { id: r.id, name: r.name, currency: r.currency, allowNegative: r.allow_negative, balance: r.balance };
}

export interface Transaction {
  id: string;
  description: string;
  effectiveAt: Date;
  postedAt: Date;
  reversesId: string | null;
  reversedById: string | null;
  entries: { accountId: string; currency: string; amount: bigint }[];
}

export async function getTransaction(pool: Pool, transactionId: string): Promise<Transaction> {
  if (!UUID.test(transactionId)) throw new TransactionNotFoundError(`transaction ${transactionId} not found`);
  const { rows } = await pool.query<{
    id: string;
    description: string;
    effective_at: Date;
    posted_at: Date;
    reverses_id: string | null;
    reversed_by_id: string | null;
  }>(
    `select t.id, t.description, t.effective_at, t.posted_at, t.reverses_id, r.id as reversed_by_id
       from transactions t left join transactions r on r.reverses_id = t.id
      where t.id = $1`,
    [transactionId],
  );
  if (rows.length === 0) throw new TransactionNotFoundError(`transaction ${transactionId} not found`);
  const entries = await pool.query<{ account_id: string; currency: string; amount: bigint }>(
    "select account_id, currency, amount from entries where transaction_id = $1 order by id",
    [transactionId],
  );
  const t = rows[0];
  return {
    id: t.id,
    description: t.description,
    effectiveAt: t.effective_at,
    postedAt: t.posted_at,
    reversesId: t.reverses_id,
    reversedById: t.reversed_by_id,
    entries: entries.rows.map((e) => ({ accountId: e.account_id, currency: e.currency, amount: e.amount })),
  };
}

export function postTransaction(pool: Pool, input: PostTransactionInput): Promise<PostResult> {
  return post(pool, input);
}

// Undoes a transaction by posting its exact negation, linked to the original. The original stays in history.
// Subject to the same rules as any posting: idempotent, and it can't overdraw an account (e.g. reversing a
// deposit whose money was already spent fails with InsufficientFundsError).
export async function reverseTransaction(
  pool: Pool,
  opts: { transactionId: string; idempotencyKey: string; description?: string },
): Promise<PostResult> {
  if (!UUID.test(opts.transactionId)) throw new ValidationError(`invalid transaction id ${opts.transactionId}`);
  // Entries are immutable, so reading them outside the posting transaction is safe.
  const { rows } = await pool.query<{ account_id: string; amount: bigint }>(
    "select account_id, amount from entries where transaction_id = $1 order by id",
    [opts.transactionId],
  );
  if (rows.length === 0) throw new TransactionNotFoundError(`transaction ${opts.transactionId} not found`);
  return post(pool, {
    idempotencyKey: opts.idempotencyKey,
    description: opts.description ?? `reversal of ${opts.transactionId}`,
    reversesId: opts.transactionId,
    entries: rows.map((r) => ({ accountId: r.account_id, amount: -r.amount })),
  });
}

async function post(pool: Pool, input: PostInput): Promise<PostResult> {
  validate(input);
  const hash = requestHash(input);
  const client = await pool.connect();
  try {
    await client.query("begin");

    // Claim the key. If another request holds it uncommitted, this blocks until that one commits or rolls back.
    const claimed = await client.query(
      "insert into idempotency_keys (key, request_hash) values ($1, $2) on conflict (key) do nothing",
      [input.idempotencyKey, hash],
    );
    if (claimed.rowCount === 0) {
      await client.query("rollback");
      return await replay(pool, input.idempotencyKey, hash);
    }

    const deltas = new Map<string, bigint>();
    for (const e of input.entries) deltas.set(e.accountId, (deltas.get(e.accountId) ?? 0n) + e.amount);
    const accountIds = [...deltas.keys()];

    // Lock every touched balance row, always in account-id order, so two transfers over
    // the same accounts (A→B and B→A) queue behind each other instead of deadlocking.
    const { rows: locked } = await client.query<{
      account_id: string;
      balance: bigint;
      currency: string;
      allow_negative: boolean;
    }>(
      `select b.account_id, b.balance, a.currency, a.allow_negative
         from balances b join accounts a on a.id = b.account_id
        where b.account_id = any($1::uuid[])
        order by b.account_id
          for update of b`,
      [accountIds],
    );
    if (locked.length !== accountIds.length) {
      const found = new Set(locked.map((r) => r.account_id));
      throw new AccountNotFoundError(`account ${accountIds.find((id) => !found.has(id))} not found`);
    }
    const accounts = new Map(locked.map((r) => [r.account_id, r]));

    // Checked after taking the locks: a racing reversal of the same transaction touches the same accounts, so by
    // now it has committed or rolled back, and this statement sees the outcome. Without this, reversing a deposit
    // twice would fail the funds check and report the wrong error. The unique index is the backstop.
    if (input.reversesId) {
      const prior = await client.query("select 1 from transactions where reverses_id = $1", [input.reversesId]);
      if (prior.rowCount) throw new AlreadyReversedError(`transaction ${input.reversesId} is already reversed`);
    }

    // App-level zero-sum check per currency, for a clear error. The deferred DB trigger is the real guarantee.
    const byCurrency = new Map<string, bigint>();
    for (const e of input.entries) {
      const ccy = accounts.get(e.accountId)!.currency;
      byCurrency.set(ccy, (byCurrency.get(ccy) ?? 0n) + e.amount);
    }
    for (const [ccy, total] of byCurrency) {
      if (total !== 0n) throw new ValidationError(`entries do not sum to zero in ${ccy} (off by ${total})`);
    }

    for (const [id, delta] of deltas) {
      const acct = accounts.get(id)!;
      if (!acct.allow_negative && acct.balance + delta < 0n) {
        throw new InsufficientFundsError(`account ${id} has ${acct.balance}, needs ${-delta}`);
      }
    }

    const { rows: txn } = await client.query<{ id: string }>(
      `insert into transactions (description, effective_at, reverses_id)
       values ($1, coalesce($2, now()), $3) returning id`,
      [input.description ?? "", input.effectiveAt ?? null, input.reversesId ?? null],
    );
    const transactionId = txn[0].id;

    await client.query(
      `insert into entries (transaction_id, account_id, currency, amount)
       select $1, t.account_id, t.currency, t.amount
         from unnest($2::uuid[], $3::char(3)[], $4::bigint[]) as t(account_id, currency, amount)`,
      [
        transactionId,
        input.entries.map((e) => e.accountId),
        input.entries.map((e) => accounts.get(e.accountId)!.currency),
        input.entries.map((e) => e.amount.toString()),
      ],
    );

    await client.query(
      `update balances b set balance = b.balance + d.delta, updated_at = now()
         from unnest($1::uuid[], $2::bigint[]) as d(account_id, delta)
        where b.account_id = d.account_id`,
      [accountIds, accountIds.map((id) => deltas.get(id)!.toString())],
    );

    await client.query("update idempotency_keys set transaction_id = $1 where key = $2", [
      transactionId,
      input.idempotencyKey,
    ]);

    await client.query("commit"); // deferred zero-sum trigger runs here
    return { transactionId, replayed: false };
  } catch (err) {
    // The key row is rolled back too, so a rejected request doesn't burn its key: a retry runs again.
    await client.query("rollback").catch(() => {});
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === "23505" && pgErr.constraint === "transactions_reverses_once") {
      throw new AlreadyReversedError(`transaction ${input.reversesId} is already reversed`);
    }
    throw err;
  } finally {
    client.release();
  }
}

async function replay(pool: Pool, key: string, hash: string): Promise<PostResult> {
  const { rows } = await pool.query<{ request_hash: string; transaction_id: string | null }>(
    "select request_hash, transaction_id from idempotency_keys where key = $1",
    [key],
  );
  // The key and its transaction commit together, so a visible key always has a transaction_id.
  if (rows.length === 0 || rows[0].transaction_id === null) {
    throw new Error(`idempotency key ${key} conflicted but has no committed result`);
  }
  if (rows[0].request_hash !== hash) {
    throw new IdempotencyConflictError(`idempotency key ${key} was already used with a different request`);
  }
  return { transactionId: rows[0].transaction_id, replayed: true };
}

function validate(input: PostTransactionInput): void {
  if (!input.idempotencyKey || input.idempotencyKey.length > 255) {
    throw new ValidationError("idempotencyKey must be 1–255 characters");
  }
  if (input.entries.length < 2) throw new ValidationError("a transaction needs at least 2 entries");
  for (const e of input.entries) {
    if (!UUID.test(e.accountId)) throw new ValidationError(`invalid account id ${e.accountId}`);
    if (typeof e.amount !== "bigint" || e.amount === 0n) {
      throw new ValidationError("each amount must be a non-zero bigint (minor units)");
    }
  }
}

// Fingerprint of the request's meaning. Entries are sorted so the same transfer listed in a
// different order hashes the same; ids are lowercased because Postgres treats uuids case-insensitively.
export function requestHash(input: PostInput): string {
  const canonical = {
    description: input.description ?? "",
    reversesId: input.reversesId?.toLowerCase() ?? null,
    effectiveAt: input.effectiveAt?.toISOString() ?? null,
    entries: input.entries
      .map((e) => [e.accountId.toLowerCase(), e.amount.toString()])
      .sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : a[0] + a[1] > b[0] + b[1] ? 1 : 0)),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export interface Drift {
  accountId: string;
  cached: bigint;
  actual: bigint;
}

// Recomputes every balance from the entries (the source of truth) and reports any account whose cache drifted.
// One statement = one snapshot, and entries + balance updates commit together, so in-flight posts can't cause false drift.
export async function reconcile(pool: Pool): Promise<Drift[]> {
  const { rows } = await pool.query<{ account_id: string; cached: bigint; actual: bigint }>(
    `select b.account_id, b.balance as cached, coalesce(sum(e.amount), 0)::bigint as actual
       from balances b left join entries e on e.account_id = b.account_id
      group by b.account_id, b.balance
     having b.balance <> coalesce(sum(e.amount), 0)`,
  );
  return rows.map((r) => ({ accountId: r.account_id, cached: r.cached, actual: r.actual }));
}
