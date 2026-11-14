// V1.5 bounded local load: 400 Data API requests across TWO service instances sharing the durable
// PostgreSQL limiter (local measurement, not an SLA). A drill client/key is created and revoked.
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
const root = `${process.env.OTHERBRIDGE_EVIDENCE_ROOT}/performance`;
await mkdir(root, { recursive: true });
const cli = (args) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, ["scripts/data.mjs", ...args]);
    let o = "";
    c.stdout.on("data", (d) => (o += d));
    c.on("close", () =>
      resolve(
        JSON.parse(
          o
            .trim()
            .split("\n")
            .filter((l) => l.startsWith("{"))
            .pop(),
        ),
      ),
    );
  });
const pct = (a, p) =>
  [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * p)] ?? 0;
const out = { at: new Date().toISOString(), runs: {} };
const ports = [3203, 3204];
const servers = ports.map((port) =>
  spawn(process.execPath, ["scripts/data.mjs", "api"], {
    env: {
      ...process.env,
      OTHERBRIDGE_DATA_API_PORT: String(port),
      OTHERBRIDGE_DATA_LOG: "off",
    },
  }),
);
try {
  for (const port of ports)
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/v1/health`)).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
  for (const plan of ["developer", "internal"]) {
    const client = await cli([
      "client:create",
      "--name",
      `V15 load ${plan}`,
      "--plan",
      plan,
      "--scopes",
      "chains:read",
    ]);
    const key = await cli([
      "key:create",
      "--client",
      client.clientId,
      "--yes",
      "--stdout-json",
      "--test",
    ]);
    const lat = [],
      codes = {};
    const started = Date.now();
    let next = 0;
    await Promise.all(
      Array.from({ length: 40 }, async () => {
        while (next < 400) {
          const i = next++;
          const t = performance.now();
          const r = await fetch(
            `http://127.0.0.1:${ports[i % 2]}/v1/chains?limit=5`,
            { headers: { authorization: `Bearer ${key.apiKey}` } },
          );
          await r.arrayBuffer();
          lat.push(performance.now() - t);
          codes[r.status] = (codes[r.status] ?? 0) + 1;
        }
      }),
    );
    out.runs[plan] = {
      requests: 400,
      instances: 2,
      concurrency: 40,
      wallMs: Date.now() - started,
      codes,
      p50ms: Math.round(pct(lat, 0.5) * 10) / 10,
      p95ms: Math.round(pct(lat, 0.95) * 10) / 10,
      note:
        plan === "developer"
          ? "plan limit 30/min and 2 concurrent: a shared durable limiter admits at most the plan budget across both instances"
          : "internal plan 600/min, 16 concurrent slots shared across instances",
    };
    await cli(["key:revoke", "--key", key.prefix]);
  }
  out.sharedLimiterHolds = (out.runs.developer.codes[200] ?? 0) <= 30;
} finally {
  for (const s of servers) s.kill();
}
await writeFile(`${root}/data-api-load.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
