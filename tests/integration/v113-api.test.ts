import { it, expect } from "vitest";
import { createDataApi } from "../../src/data/api/router";
import { MemoryStore } from "../../src/data/store/memory";
import { DataPlane } from "../../src/data/plane";
import { MemoryRateLimiter } from "../../src/server/rate-limit";
import { generateKey } from "../../src/data/api/keys";
import { defiFixture, defiWallet } from "../fixtures/defi";
import { fixtureCatalog } from "../fixtures/routing";
import type { Scope } from "../../src/data/api/plans";
async function api(scopes: Scope[] = ["portfolio:read"]) {
  const store = new MemoryStore(),
    key = generateKey("test");
  await store.createClient({
    id: "client-a",
    displayName: "Synthetic API",
    status: "ACTIVE",
    planId: "developer",
    scopes,
    createdAt: Date.now(),
  });
  await store.createKey({
    id: "key-a",
    clientId: "client-a",
    prefix: key.prefix,
    verifier: key.verifier,
    status: "ACTIVE",
    createdAt: Date.now(),
    revokedAt: null,
    lastUsedAt: null,
  });
  const scan = await defiFixture();
  scan.positions = Array.from({ length: 500 }, (_, i) => ({
    ...scan.positions[i % 9],
    id: "p-" + String(i).padStart(4, "0"),
  }));
  let scans = 0;
  const handle = createDataApi({
    store,
    plane: new DataPlane(store),
    limiter: new MemoryRateLimiter(),
    routing: async () => fixtureCatalog(),
    defiScan: async (_wallet, _plane, o) => {
      expect(o?.clientScope).toBe("client-a");
      scans++;
      return scan;
    },
  });
  const get = (suffix = "", auth = true) =>
    handle(
      new Request(
        "http://127.0.0.1:3200/v1/address/" + defiWallet + "/defi" + suffix,
        { headers: auth ? { Authorization: "Bearer " + key.plaintext } : {} },
      ),
    );
  return { get, handle, store, scan, scans: () => scans };
}
it("DeFi API base route paginates 500 position records with exact provenance", async () => {
  const { get } = await api();
  const r = await get("?limit=100");
  expect(r.status).toBe(200);
  expect(r.headers.get("Cache-Control")).toBe("no-store");
  const b = await r.json();
  expect(b.data.positions.length).toBe(100);
  expect(b.data.totalPositions).toBe(500);
  expect(b.data.positions[0].sourceBlock).toBe("12345");
  const next = await (
    await get("?limit=100&cursor=" + b.data.nextCursor)
  ).json();
  expect(next.data.positions[0].id).toBe("p-0100");
});
it("coverage and protocols are separate truthful surfaces", async () => {
  const { get } = await api();
  expect((await (await get("/coverage")).json()).data.nonEvm).toBe(
    "NOT_CHECKED",
  );
  expect((await (await get("/protocols")).json()).data.protocols).toContain(
    "aave-v3",
  );
});
it("unknown scan cursor cannot retrieve another client history", async () => {
  const { get } = await api();
  expect((await get("?cursor=garbage")).status).toBe(400);
});
it("exact position detail lookup and missing position have proper statuses", async () => {
  const { get } = await api();
  expect((await get("/p-0000")).status).toBe(200);
  expect((await get("/p-does-not-exist")).status).toBe(404);
});
it("invalid pagination and chain fail closed", async () => {
  const { get } = await api();
  expect((await get("?limit=101")).status).toBe(400);
  expect((await get("?chains=999999999999")).status).toBe(400);
});
it("unauthorized/scopeless queries cannot perform expensive scans", async () => {
  const { get, scans } = await api(["chains:read"]);
  expect((await get("", false)).status).toBe(401);
  expect((await get()).status).toBe(403);
  expect(scans()).toBe(0);
});
it("API quota/rate accounting charges expensive scans and bounds fanout", async () => {
  const { get, scans } = await api();
  for (let i = 0; i < 30; i++) expect((await get()).status).toBe(200);
  expect((await get()).status).toBe(429);
  expect(scans()).toBe(30);
});
