import { it, expect } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { publicData } from "../../src/server/public-data";
import { routingCore } from "../../src/adapters/routing-core";
import { normalizeActive, catalogDiff } from "../../src/catalog/model";
it("bounded live active catalog sync: safe snapshot and deterministic review diff", async () => {
  const base = process.env.OTHERBRIDGE_EVIDENCE_ROOT;
  if (!base) throw Error("UNIQUE_EVIDENCE_ROOT_REQUIRED");
  await mkdir(base, { recursive: true });
  const raw = await publicData("https://api.llama.fi/v2/chains"),
    routes = await routingCore.listNetworks(),
    observedAt = Date.now(),
    hash = createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
    after = normalizeActive(raw, routes, observedAt, hash),
    previous = JSON.parse(await readFile("src/catalog/snapshot.json", "utf8")),
    before = normalizeActive(previous.raw, routes, previous.observedAt);
  expect(after.livePositive).toBeGreaterThan(0);
  expect(after.chains.some((c) => c.chainId === "612055")).toBe(true);
  await writeFile(
    `${base}/active-catalog-raw.json`,
    JSON.stringify(raw, null, 2),
    { flag: "wx" },
  );
  await writeFile(
    `${base}/active-catalog.json`,
    JSON.stringify(after, null, 2),
    { flag: "wx" },
  );
  await writeFile(
    `${base}/catalog-diff.json`,
    JSON.stringify(
      {
        at: new Date(observedAt).toISOString(),
        hash,
        diff: catalogDiff(before, after),
        capabilitiesEnabled: false,
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  await writeFile(
    "src/catalog/snapshot.json",
    JSON.stringify({ observedAt, raw }, null, 2) + "\n",
  );
});
