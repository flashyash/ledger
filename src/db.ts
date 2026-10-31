import pg from "pg";

// Postgres bigint (OID 20) comes back as a string by default. Money must stay exact, so parse to BigInt.
pg.types.setTypeParser(20, (v) => BigInt(v));

export const DEFAULT_DATABASE_URL = "postgres://ledger:ledger@localhost:5433/ledger";

export function createPool(connectionString = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, max = 20) {
  return new pg.Pool({ connectionString, max });
}

export type Pool = pg.Pool;
export type Client = pg.PoolClient;
