// HTTP load test: spawns the server as its own process, then drives it with autocannon.
// Run: npm run db:up && npm run migrate && npm run load   (DURATION=10 seconds per scenario, CONNECTIONS=20)
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import autocannon from "autocannon";
import { createPool } from "../src/db.ts";
import { reconcile } from "../src/ledger.ts";

const PORT = 3002;
const BASE = `http://127.0.0.1:${PORT}`;
const DURATION = Number(process.env.DURATION ?? 10);
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 20);
const USERS = 100;

const server = spawn(process.execPath, ["src/server.ts"], {
  env: { ...process.env, PORT: String(PORT), LOG_LEVEL: "warn" },
  stdio: "inherit",
});
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) break;
    } catch {}
    if (i > 50) throw new Error("server didn't start");
    await new Promise((r) => setTimeout(r, 100));
  }

  const json = async (method: string, path: string, body: unknown) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
    return res.json();
  };
  const transferBody = (from: string, to: string, amount: number) =>
    JSON.stringify({ entries: [{ accountId: from, amount: `-${amount}` }, { accountId: to, amount: `${amount}` }] });

  const world: string = (await json("POST", "/accounts", { name: "load-world", currency: "USD", allowNegative: true })).id;
  const users: string[] = [];
  for (let i = 0; i < USERS; i++) {
    const id: string = (await json("POST", "/accounts", { name: `load-user-${i}`, currency: "USD" })).id;
    await json("POST", "/transactions", JSON.parse(transferBody(world, id, 1_000_000_000)));
    users.push(id);
  }
  const pick = () => users[Math.floor(Math.random() * users.length)];

  async function scenario(name: string, request: autocannon.Request) {
    const r = await autocannon({ url: BASE, connections: CONNECTIONS, duration: DURATION, requests: [request] });
    const bad = r.non2xx + r.errors + r.timeouts;
    console.log(
      `${name.padEnd(36)} ${String(Math.round(r.requests.average)).padStart(6)} req/s   p50 ${String(r.latency.p50).padStart(3)} ms   p99 ${String(r.latency.p99).padStart(3)} ms   ${r.requests.total.toLocaleString()} requests, ${bad} failed`,
    );
  }

  const postWith = (body: () => string): autocannon.Request => ({
    method: "POST",
    path: "/transactions",
    setupRequest: (req) => ({
      ...req,
      headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
      body: body(),
    }),
  });

  console.log(`${CONNECTIONS} connections, ${DURATION} s per scenario, server pool 20, client + server + Postgres on one machine`);
  await scenario("POST /transactions, random user pairs", postWith(() => {
    const from = pick();
    let to = pick();
    while (to === from) to = pick();
    return transferBody(from, to, 1);
  }));
  await scenario("POST /transactions, all from world", postWith(() => transferBody(world, pick(), 1)));
  await scenario("GET /accounts/:id", {
    method: "GET",
    setupRequest: (req) => ({ ...req, path: `/accounts/${pick()}` }),
  });

  const pool = createPool();
  const drift = await reconcile(pool);
  await pool.end();
  console.log(`reconcile after load: ${drift.length} drifted balances`);
} finally {
  server.kill("SIGTERM");
}
