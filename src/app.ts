import Fastify, { type FastifyError, type FastifyReply, type FastifyServerOptions } from "fastify";
import type { Pool } from "./db.ts";
import {
  AccountNotFoundError,
  AlreadyReversedError,
  IdempotencyConflictError,
  InsufficientFundsError,
  TransactionNotFoundError,
  ValidationError,
  createAccount,
  getAccount,
  getTransaction,
  postTransaction,
  reverseTransaction,
  type Account,
  type PostResult,
  type Transaction,
} from "./ledger.ts";

// Domain error → HTTP status + stable machine-readable code. Clients branch on `error`, never on `message`.
const ERRORS: [new (...args: never[]) => Error, number, string][] = [
  [ValidationError, 400, "validation_error"],
  [AccountNotFoundError, 404, "account_not_found"],
  [TransactionNotFoundError, 404, "transaction_not_found"],
  [IdempotencyConflictError, 409, "idempotency_key_reused"],
  [AlreadyReversedError, 409, "already_reversed"],
  [InsufficientFundsError, 422, "insufficient_funds"],
];

// Amounts travel as strings of integer minor units. A JSON number loses precision above 2^53 (~$90 trillion in cents
// sounds safe, until someone sends 0.1 + 0.2), so the schema rejects numbers outright. 18 digits fits in Postgres bigint.
const AMOUNT = { type: "string", pattern: "^-?[0-9]{1,18}$" } as const;
const UUID = { type: "string", format: "uuid" } as const;

const accountBody = {
  type: "object",
  required: ["name", "currency"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    currency: { type: "string", pattern: "^[A-Z]{3}$" },
    allowNegative: { type: "boolean" },
  },
} as const;

const transactionBody = {
  type: "object",
  required: ["entries"],
  additionalProperties: false,
  properties: {
    description: { type: "string", maxLength: 1000 },
    effectiveAt: { type: "string", format: "date-time" },
    entries: {
      type: "array",
      minItems: 2,
      maxItems: 100,
      items: {
        type: "object",
        required: ["accountId", "amount"],
        additionalProperties: false,
        properties: { accountId: UUID, amount: AMOUNT },
      },
    },
  },
} as const;

const reverseBody = {
  type: "object",
  additionalProperties: false,
  properties: { description: { type: "string", maxLength: 1000 } },
} as const;

const idParams = { type: "object", required: ["id"], properties: { id: { type: "string" } } } as const;

interface TransactionBody {
  description?: string;
  effectiveAt?: string;
  entries: { accountId: string; amount: string }[];
}

const accountJson = (a: Account) => ({ ...a, balance: a.balance.toString() });
const transactionJson = (t: Transaction) => ({
  ...t,
  entries: t.entries.map((e) => ({ ...e, amount: e.amount.toString() })),
});

export function buildApp(pool: Pool, opts: FastifyServerOptions = {}) {
  const app = Fastify({
    ...opts,
    // Strict input: don't coerce 100 into "100", and reject unknown fields instead of silently dropping them.
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err.validation) return reply.status(400).send({ error: "validation_error", message: err.message });
    for (const [type, status, code] of ERRORS) {
      if (err instanceof type) return reply.status(status).send({ error: code, message: err.message });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: err.code ?? "bad_request", message: err.message });
    }
    req.log.error(err);
    return reply.status(500).send({ error: "internal_error", message: "internal error" });
  });

  // Retries must carry the same key, so it has to come from the client. Without one, a timeout can't be retried safely.
  function idempotencyKey(headers: Record<string, string | string[] | undefined>): string {
    const key = headers["idempotency-key"];
    if (typeof key !== "string" || key.length === 0) {
      throw new ValidationError("Idempotency-Key header is required");
    }
    return key;
  }

  function sendPosted(reply: FastifyReply, res: PostResult) {
    // Same status and body on a replay, so a retrying client can't tell the difference. The header is for debugging.
    if (res.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(201).send({ transactionId: res.transactionId });
  }

  app.get("/health", async () => {
    await pool.query("select 1");
    return { ok: true };
  });

  app.post<{ Body: { name: string; currency: string; allowNegative?: boolean } }>(
    "/accounts",
    { schema: { body: accountBody } },
    async (req, reply) => {
      const id = await createAccount(pool, req.body);
      return reply.status(201).send(accountJson(await getAccount(pool, id)));
    },
  );

  app.get<{ Params: { id: string } }>("/accounts/:id", { schema: { params: idParams } }, async (req) =>
    accountJson(await getAccount(pool, req.params.id)),
  );

  app.post<{ Body: TransactionBody }>("/transactions", { schema: { body: transactionBody } }, async (req, reply) => {
    const res = await postTransaction(pool, {
      idempotencyKey: idempotencyKey(req.headers),
      description: req.body.description,
      effectiveAt: req.body.effectiveAt ? new Date(req.body.effectiveAt) : undefined,
      entries: req.body.entries.map((e) => ({ accountId: e.accountId, amount: BigInt(e.amount) })),
    });
    return sendPosted(reply, res);
  });

  app.get<{ Params: { id: string } }>("/transactions/:id", { schema: { params: idParams } }, async (req) =>
    transactionJson(await getTransaction(pool, req.params.id)),
  );

  app.post<{ Params: { id: string }; Body: { description?: string } | undefined }>(
    "/transactions/:id/reverse",
    {
      schema: { params: idParams, body: reverseBody },
      // The body is optional; validate a missing one as {} instead of rejecting "body must be object".
      preValidation: async (req) => {
        req.body ??= {};
      },
    },
    async (req, reply) => {
      const res = await reverseTransaction(pool, {
        transactionId: req.params.id,
        idempotencyKey: idempotencyKey(req.headers),
        description: req.body?.description,
      });
      return sendPosted(reply, res);
    },
  );

  return app;
}
