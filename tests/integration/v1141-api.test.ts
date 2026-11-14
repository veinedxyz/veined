import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  DataPlane,
  fallbackRegistry,
  setDataPlaneForTests,
} from "../../src/data/plane";
import { clearScanStateForTests } from "../../src/defi/scanner";
import { clearDefiMetadataCacheForTests } from "../../src/defi/cache";
import {
  scanSchema,
  deploymentCoverageSchema,
  positionSchema,
} from "../../src/defi/model";
import { setAppLimiterForTests } from "../../src/server/api-guard";
import { MemoryRateLimiter } from "../../src/server/rate-limit";
import { readRound } from "../../src/components/defi-stream";
import {
  buildWorld,
  seedProfile,
  simPriceRead,
  SIM_WALLETS,
} from "../fixtures/defi-sim";
// V1.14.1 progressive DeFi API. The routing price list and the RPC data plane are the deterministic simulator
// (SYNTHETIC_TEST_ONLY); no upstream request leaves the process and no wallet / signature / transaction exists.
const world = buildWorld({
  chains: ["1"],
  morphoMarkets: 64,
  morphoVaults: 32,
});
const wallet = seedProfile(world, "production");
const price = simPriceRead(world);
vi.mock("../../src/adapters/routing-core", () => ({
  upstreamRead: (path: string, params: Record<string, string>) =>
    price(path, params),
}));
const { POST } = await import("../../src/app/api/portfolio/defi/route");
const base = fallbackRegistry();
const plane = new DataPlane(null, world.net.transport, 60000, () => ({
  ...base,
  endpoints: world.net.endpoints("1"),
}));
const request = (
  body: unknown,
  accept?: string,
  origin = "http://127.0.0.1:3100",
) =>
  new Request("http://127.0.0.1:3100/api/portfolio/defi", {
    method: "POST",
    headers: {
      Origin: origin,
      Host: "127.0.0.1:3100",
      "Content-Type": "application/json",
      ...(accept ? { Accept: accept } : {}),
    },
    body: JSON.stringify(body),
  });
const lines = async (r: Response) =>
  (await r.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; [k: string]: unknown });
beforeEach(() => {
  clearScanStateForTests();
  clearDefiMetadataCacheForTests();
  setAppLimiterForTests(new MemoryRateLimiter());
  setDataPlaneForTests(plane);
});
afterAll(() => setDataPlaneForTests(undefined));
describe("V1.14.1 progressive DeFi API", () => {
  it("NDJSON: one validated progress line per finished deployment, then the complete schema-checked round", async () => {
    const r = await POST(
      request(
        { wallet, consent: true, chains: ["1"], held: world.held(wallet) },
        "application/x-ndjson, application/json",
      ),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/x-ndjson");
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    const out = await lines(r);
    const progress = out.filter((l) => l.type === "progress");
    expect(progress.length).toBeGreaterThan(0);
    expect(out.at(-1)!.type).toBe("scan");
    const scan = scanSchema.parse(out.at(-1)!.scan);
    for (const p of progress) {
      const c = deploymentCoverageSchema.parse(p.coverage);
      for (const pos of positionSchema.array().parse(p.positions)) {
        expect(pos.deploymentId).toBe(c.deploymentId);
        expect(pos.wallet).toBe(wallet);
      }
      // Every streamed outcome is the outcome of the final round (progress is never a different truth).
      const final = scan.coverage.find(
        (x) => x.deploymentId === c.deploymentId,
      )!;
      expect({ state: final.state, scanResult: final.scanResult }).toEqual({
        state: c.state,
        scanResult: c.scanResult,
      });
    }
    expect(scan.receipt!.timing!.firstResultMs).not.toBeNull();
  });
  it("without NDJSON in Accept the V1.14 JSON response is unchanged", async () => {
    const r = await POST(request({ wallet, consent: true, chains: ["1"] }));
    expect(r.headers.get("content-type")).toContain("application/json");
    const scan = scanSchema.parse(await r.json());
    expect(scan.wallet).toBe(wallet);
  });
  it("the client reader renders the streamed round progressively and ends with the identical final round", async () => {
    const r = await POST(
      request(
        { wallet, consent: true, chains: ["1"], held: world.held(wallet) },
        "application/x-ndjson",
      ),
    );
    const partials: number[] = [];
    const final = await readRound(r, wallet, (p) =>
      partials.push(p.coverage.length),
    );
    expect(partials.length).toBeGreaterThan(0);
    expect(partials).toEqual([...partials].sort((a, b) => a - b));
    expect(final.wallet).toBe(wallet);
  });
  it("two wallets streaming at once never see each other's positions (account switch)", async () => {
    const [a, b] = await Promise.all([
      POST(
        request(
          { wallet, consent: true, chains: ["1"], held: world.held(wallet) },
          "application/x-ndjson",
        ),
      ),
      POST(
        request(
          { wallet: SIM_WALLETS.zero, consent: true, chains: ["1"] },
          "application/x-ndjson",
        ),
      ),
    ]);
    const [la, lb] = await Promise.all([lines(a), lines(b)]);
    for (const l of la.filter((x) => x.type === "progress"))
      for (const p of l.positions as { wallet: string }[])
        expect(p.wallet).toBe(wallet);
    expect(
      lb
        .filter((x) => x.type === "progress")
        .flatMap((l) => l.positions as unknown[]),
    ).toEqual([]);
  });
  it("hostile origins and arbitrary inputs are refused before any stream starts", async () => {
    expect(
      (
        await POST(
          request(
            { wallet, consent: true },
            "application/x-ndjson",
            "https://evil.test",
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await POST(
          request(
            { wallet, consent: true, url: "https://evil.test" },
            "application/x-ndjson",
          ),
        )
      ).status,
    ).toBe(422);
  });
});
