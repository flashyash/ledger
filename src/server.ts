import { buildApp } from "./app.ts";
import { createPool } from "./db.ts";

const pool = createPool(undefined, Number(process.env.DB_POOL_SIZE ?? 20));
const app = buildApp(pool, { logger: { level: process.env.LOG_LEVEL ?? "info" } });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close(); // stop accepting, finish in-flight requests
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: Number(process.env.PORT ?? 3001), host: process.env.HOST ?? "127.0.0.1" });
