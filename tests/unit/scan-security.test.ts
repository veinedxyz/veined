import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { POST } from "../../src/app/api/scan/route";
import { setAppLimiterForTests } from "../../src/server/api-guard";
import { MemoryRateLimiter } from "../../src/server/rate-limit";
const mocked = vi.hoisted(() => ({
  list: vi.fn(),
  ingest: vi.fn(),
  lookup: vi.fn(),
  worker: vi.fn(),
}));
vi.mock("../../src/scan/server", () => ({
  scanIndex: () => mocked,
  startScanWorker: mocked.worker,
}));
const origin = "http://127.0.0.1:3470",
  account = "0x" + "1".repeat(40),
  hash = "0x" + "2".repeat(64);
const old = process.env.OTHERBRIDGE_APP_ORIGINS;
beforeEach(() => {
  process.env.OTHERBRIDGE_APP_ORIGINS = origin;
  setAppLimiterForTests(new MemoryRateLimiter());
  vi.clearAllMocks();
  mocked.ingest.mockReturnValue([]);
  mocked.list.mockReturnValue([]);
  mocked.lookup.mockResolvedValue({ hash, account });
});
afterEach(() => {
  if (old === undefined) delete process.env.OTHERBRIDGE_APP_ORIGINS;
  else process.env.OTHERBRIDGE_APP_ORIGINS = old;
  setAppLimiterForTests(undefined);
});
const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request(origin + "/api/scan", {
      method: "POST",
      headers: {
        origin,
        host: "127.0.0.1:3470",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
it.each<Record<string, string>>([
  { origin: "https://evil.invalid" },
  { host: "evil.invalid:3450" },
  { "content-type": "text/plain" },
])("rejects hostile metadata %j", async (headers) => {
  expect((await post({ q: account }, headers)).status).not.toBe(200);
  expect(mocked.lookup).not.toHaveBeenCalled();
});
it.each([
  { chain: "1" },
  { q: "../../secret" },
  { q: "https://localhost/rpc" },
  { q: hash, url: "https://evil.invalid" },
  { q: account, transaction: { data: "0xdead" } },
  { q: account, released: true },
  { q: account, method: "eth_sendTransaction" },
])("does not accept extra capability %j", async (body) => {
  expect((await post(body)).status).not.toBe(200);
  expect(mocked.lookup).not.toHaveBeenCalled();
});
it("hash lookup requires an explicit supported chain", async () => {
  const r = await post({ q: hash, chain: "all", refresh: true });
  expect((await r.json()).error).toBe("SELECT_TRANSACTION_CHAIN");
  expect(mocked.lookup).not.toHaveBeenCalled();
});
it("address lookup only reads the exact lowercased scope", async () => {
  expect((await post({ q: account, chain: "8453" })).status).toBe(200);
  expect(mocked.list).toHaveBeenCalledWith(account, "8453");
  expect(mocked.lookup).not.toHaveBeenCalled();
});
it("explicit hash search reaches only the fixed read-only verifier", async () => {
  expect((await post({ q: hash, chain: "8453", refresh: true })).status).toBe(
    200,
  );
  expect(mocked.lookup).toHaveBeenCalledWith("8453", hash);
});
it("upstream messages and URLs are never reflected in API errors", async () => {
  mocked.lookup.mockRejectedValue(
    Error("secret upstream https://bad.invalid/key"),
  );
  const r = await post({ q: hash, chain: "8453", refresh: true });
  const body = await r.text();
  expect(body).not.toContain("bad.invalid");
  expect(body).not.toContain("secret upstream");
});
