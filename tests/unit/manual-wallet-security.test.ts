// Targeted adversarial HTTP review, separate from the broker/client happy-path tests. Same executor, no second reviewer.
import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "../../src/app/api/manual-wallet/route";
import { setAppLimiterForTests } from "../../src/server/api-guard";
import { MemoryRateLimiter } from "../../src/server/rate-limit";
const mocked = vi.hoisted(() => ({ account: vi.fn() }));
vi.mock("../../src/manual-wallet/server/runtime", () => ({
  manualAccount: mocked.account,
}));
const origin = "http://127.0.0.1:3470",
  account = "0x" + "3".repeat(40);
beforeEach(() => {
  setAppLimiterForTests(new MemoryRateLimiter());
  mocked.account.mockReset();
  mocked.account.mockResolvedValue({
    review: async () => ({ ready: false, problems: ["SYNTHETIC_REVIEW"] }),
  });
});
it("limits session issuance before creating unbounded cookies", async () => {
  for (let i = 0; i < 30; i++) await session();
  const r = await GET(
    new NextRequest(origin + "/api/manual-wallet", {
      headers: { host: "127.0.0.1:3470" },
    }),
  );
  expect(r.status).toBe(429);
  expect(r.headers.has("set-cookie")).toBe(false);
});
it("limits expensive reviews before RPC/runtime access", async () => {
  const s = await session();
  const make = () =>
    new NextRequest(origin + "/api/manual-wallet", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3470",
        origin,
        "content-type": "application/json",
        "x-manual-csrf": s.csrf,
        cookie: s.cookie,
      },
      body: JSON.stringify({
        action: "review",
        lane: "SWAP",
        account,
        chainId: 8453,
      }),
    });
  for (let i = 0; i < 12; i++) expect((await POST(make())).status).toBe(200);
  expect((await POST(make())).status).toBe(429);
  expect(mocked.account).toHaveBeenCalledTimes(12);
});
async function session() {
  const res = await GET(
    new NextRequest(origin + "/api/manual-wallet", {
      headers: { host: "127.0.0.1:3470" },
    }),
  );
  const { csrf } = await res.json();
  return { csrf, cookie: res.headers.get("set-cookie")!.split(";")[0] };
}
async function post(body: unknown, change: Record<string, string> = {}) {
  const s = await session();
  return POST(
    new NextRequest(origin + "/api/manual-wallet", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3470",
        origin,
        "content-type": "application/json",
        "x-manual-csrf": s.csrf,
        cookie: s.cookie,
        ...change,
      },
      body: JSON.stringify(body),
    }),
  );
}
it("host rebinding cannot mint a local session", async () => {
  const r = await GET(
    new NextRequest(origin + "/api/manual-wallet", {
      headers: { host: "evil.invalid:3450" },
    }),
  );
  expect(r.status).toBe(403);
  expect(r.headers.has("set-cookie")).toBe(false);
});
const hostileHeaders: Record<string, string>[] = [
  { origin: "https://evil.invalid" },
  { "sec-fetch-site": "cross-site" },
  { "content-type": "text/plain" },
  { "x-manual-csrf": "forged" },
  { cookie: "forged" },
];
it.each(hostileHeaders)(
  "rejects hostile request metadata %j before runtime",
  async (headers) => {
    const r = await post(
      { action: "review", lane: "SWAP", account, chainId: 8453 },
      headers,
    );
    expect(r.status).toBe(409);
    expect(mocked.account).not.toHaveBeenCalled();
  },
);
it.each([
  { lane: "BRIDGE_OTHER" },
  { chainId: 8453, transaction: { data: "0xdeadbeef" } },
  { released: true },
  { action: "sign_send" },
  { amount: "999999999" },
])("rejects caller supplied policy/transaction %j", async (over) => {
  const r = await post({
    action: "review",
    lane: "SWAP",
    account,
    chainId: 8453,
    ...over,
  });
  expect(r.status).toBe(409);
  expect(mocked.account).not.toHaveBeenCalled();
});
it("closed financial activation rejects a real claim before account/RPC/store access", async () => {
  const r = await post({
    action: "claim",
    lane: "SWAP",
    account,
    chainId: 8453,
    id: "a".repeat(64),
  });
  expect((await r.json()).error).toBe("OWNER_RELEASE_REQUIRED");
  expect(mocked.account).not.toHaveBeenCalled();
});
it("body limit also applies when Content-Length is absent", async () => {
  const r = await post({
    action: "review",
    lane: "SWAP",
    account,
    chainId: 8453,
    padding: "a".repeat(9000),
  });
  expect((await r.json()).error).toBe("MANUAL_BODY_LIMIT");
  expect(mocked.account).not.toHaveBeenCalled();
});
it("an account-bound session cannot authorize a changed account", async () => {
  const s = await session();
  const headers = {
    host: "127.0.0.1:3470",
    origin,
    "content-type": "application/json",
    "x-manual-csrf": s.csrf,
    cookie: s.cookie,
  };
  const make = (a: string) =>
    new NextRequest(origin + "/api/manual-wallet", {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "review",
        lane: "SWAP",
        account: a,
        chainId: 8453,
      }),
    });
  expect((await POST(make(account))).status).toBe(200);
  const changed = await POST(make("0x" + "4".repeat(40)));
  expect((await changed.json()).error).toBe("MANUAL_SESSION_ACCOUNT_CHANGED");
  expect(mocked.account).toHaveBeenCalledTimes(1);
});
