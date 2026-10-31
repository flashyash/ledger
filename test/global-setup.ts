import pg from "pg";
import { createPool, DEFAULT_DATABASE_URL } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://ledger:ledger@localhost:5433/ledger_test";

// Fresh test database per run: create it if missing, wipe the schema, apply migrations.
export default async function setup() {
  const dbName = new URL(TEST_DATABASE_URL).pathname.slice(1);
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL });
  await admin.connect();
  const exists = await admin.query("select 1 from pg_database where datname = $1", [dbName]);
  if (exists.rowCount === 0) await admin.query(`create database "${dbName}"`);
  await admin.end();

  const pool = createPool(TEST_DATABASE_URL);
  await pool.query("drop schema public cascade; create schema public;");
  await migrate(pool);
  await pool.end();
}
