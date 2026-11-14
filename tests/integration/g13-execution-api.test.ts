// G13 Phase 3: /api/execution through the real route handler (origin, content-type and rate guards; write actions
// refused) and the server-side review with injected read-only dependencies (synthetic catalog + quote fixtures;
// SYNTHETIC_TEST_ONLY account 0x3333…3333; no request leaves the process, nothing is signed).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "../../src/app/api/execution/route";
import { setAppLimiterForTests } from "../../src/server/api-guard";
import { MemoryRateLimiter } from "../../src/server/rate-limit";
import {
  reviewBridgeRoute,
  type ReviewDeps,
} from "../../src/execution/server/review";
import { normalizeQuote } from "../../src/routing/normalize";
import {
  fixtureCatalog,
  fixtureInput,
  fixtureQuote,
} from "../fixtures/routing";
import type { QuoteInput } from "../../src/routing/model";

const ORIGIN = "http://127.0.0.1:3100";
const request = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`${ORIGIN}/api/execution`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:3100",
      origin: ORIGIN,
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const call = async (body: unknown, headers?: Record<string, string>) => {
  const res = await POST(request(body, headers));
  return { status: res.status, json: await res.json() };
};
beforeEach(() => setAppLimiterForTests(new MemoryRateLimiter()));
afterEach(() => setAppLimiterForTests(undefined));

describe("G13-API /api/execution is read-only and closed", () => {
  it("A1 GET and the gate action report CLOSED with every reason", async () => {
    const g = await (await GET()).json();
    expect(g).toMatchObject({
      state: "CLOSED",
      open: false,
      platformFeeBps: 0,
    });
    const r = await call({ action: "gate", chainId: "8453" });
    expect(r.status).toBe(200);
    expect(r.json.reasons).toEqual(
      expect.arrayContaining([
        "FIREWALL_GLOBAL_KILL",
        "NO_OWNER_APPROVED_CANARY",
        "WALLET_CHAIN_NOT_TRUSTED",
      ]),
    );
  });
  it("A2 every write action name is refused as WRITE_DISABLED (no such path exists)", async () => {
    for (const action of [
      "send",
      "SUBMIT",
      "sign",
      "approve",
      "broadcast",
      "deposit",
      "execute",
      "relay",
    ]) {
      // A fresh allowance per attempt: the 5/min review limit (review F18) runs before the write refusal.
      setAppLimiterForTests(new MemoryRateLimiter());
      const r = await call({ action, transaction: { to: "0x1", data: "0x" } });
      expect(r.status, action).toBe(403);
      expect(r.json).toMatchObject({
        error: "WRITE_DISABLED",
        gate: { state: "CLOSED" },
      });
    }
  });
  it("A3 malformed, forged or foreign requests are refused before any work", async () => {
    expect((await call({ action: "gate", open: true })).json.error).toBe(
      "INVALID_REQUEST",
    );
    expect(
      (await call({ action: "review", input: {}, verdict: "ALLOW" })).json
        .error,
    ).toBe("INVALID_REQUEST");
    expect(
      (
        await call({
          action: "review",
          input: {},
          wallet: { account: "0xnot" },
        })
      ).json.error,
    ).toBe("INVALID_REQUEST");
    expect((await call("{not json")).json.error).toBe("INVALID_REQUEST");
    expect(
      (await call({ action: "gate" }, { origin: "https://evil.example" })).json
        .error,
    ).toBe("ORIGIN_REJECTED");
    expect(
      (await call({ action: "gate" }, { "content-type": "text/plain" })).json
        .error,
    ).toBe("INVALID_REQUEST");
  });
});

function deps(
  over: Partial<ReviewDeps> = {},
  mutate: (raw: ReturnType<typeof fixtureQuote>) => void = () => {},
): ReviewDeps {
  const catalog = fixtureCatalog();
  return {
    now: () => Date.now(),
    catalog: async () => catalog,
    quotes: async (input: QuoteInput) => {
      const raw = fixtureQuote(input);
      mutate(raw);
      return [normalizeQuote(raw, input, catalog)];
    },
    evidence: () => null,
    balances: async () => ["50000000000000000"],
    allowance: async () => "0",
    ...over,
  };
}
const input = (over: Partial<QuoteInput> = {}) => ({
  ...fixtureInput(),
  generation: "synthetic-fixture-catalog",
  ...over,
});

describe("G13-API server-side review (never trusts the client's numbers; nothing signable is returned)", () => {
  it("R1 a routing quote stops at the preflight: read-only quote, no calldata — UNKNOWN is never PASS", async () => {
    const r = await reviewBridgeRoute(
      {
        input: input(),
        wallet: { account: input().sourceAddress, chainId: "1" },
      },
      deps(),
    );
    expect(r.outcome).toBe("BLOCKED_BY_PREFLIGHT");
    expect(r.plan.transaction).toBeNull();
    expect(r.plan.platformFeeBps).toBe(0);
    const c = Object.fromEntries(r.preflight.checks.map((x) => [x.id, x]));
    expect(c.QUOTE).toMatchObject({
      status: "FAIL",
      code: "DRY_QUOTE_NOT_EXECUTABLE",
    });
    expect(c.PROVIDER).toMatchObject({
      status: "UNKNOWN",
      code: "CALLDATA_NOT_AVAILABLE",
    });
    expect(c.SIMULATION.status).toBe("UNKNOWN");
    expect(c.BALANCE).toMatchObject({
      status: "UNKNOWN",
      code: "BALANCE_SINGLE_SOURCE",
    });
    expect(r.preflight.ready).toBe(false);
    expect(r.gate.state).toBe("CLOSED");
    expect(r.review).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(r)).not.toMatch(
      /DEADBEEF|transactionRequest|typedData|never expose/i,
    );
  });
  it("R2 Guardian runs on the server: a burn-address recipient is BLOCKED there, whatever the client claims", async () => {
    const r = await reviewBridgeRoute(
      {
        input: input({
          destinationAddress: "0x000000000000000000000000000000000000dEaD",
        }),
      },
      deps(),
    );
    expect(r.guardian.level).toBe("BLOCK");
    expect(r.guardian.findings).toContain("RECIPIENT_BURN");
    expect(r.outcome).toBe("BLOCKED_BY_GUARDIAN");
    expect(r.preflight.checks.find((x) => x.id === "GUARDIAN")).toMatchObject({
      status: "FAIL",
      code: "GUARDIAN_BLOCK",
    });
  });
  it("R3 two RPC sources that disagree fail the balance check", async () => {
    const r = await reviewBridgeRoute(
      { input: input() },
      deps({ balances: async () => ["1", "2"] }),
    );
    expect(r.preflight.checks.find((x) => x.id === "BALANCE")).toMatchObject({
      status: "FAIL",
      code: "RPC_DISAGREEMENT",
    });
  });
  it("R4 forged client fields are refused by the strict input schema; same-chain and unknown networks are refused", async () => {
    await expect(
      reviewBridgeRoute({ input: { ...input(), minimum: "1" } }, deps()),
    ).rejects.toThrow();
    await expect(
      reviewBridgeRoute(
        { input: input({ destination: input().source }) },
        deps(),
      ),
    ).rejects.toMatchObject({ code: "BRIDGE_ONLY" });
    await expect(
      reviewBridgeRoute({ input: input({ destination: "999999999" }) }, deps()),
    ).rejects.toMatchObject({ code: "STALE_OR_UNKNOWN_NETWORK" });
  });
  it("R5 the wallet that would sign is checked against the plan's account", async () => {
    const r = await reviewBridgeRoute(
      {
        input: input(),
        wallet: {
          account: "0x4444444444444444444444444444444444444444",
          chainId: "1",
        },
      },
      deps(),
    );
    expect(r.preflight.checks.find((x) => x.id === "WALLET")).toMatchObject({
      status: "FAIL",
      code: "WALLET_ACCOUNT_MISMATCH",
    });
    const none = await reviewBridgeRoute({ input: input() }, deps());
    expect(none.preflight.checks.find((x) => x.id === "WALLET")).toMatchObject({
      status: "UNKNOWN",
      code: "WALLET_NOT_CONNECTED",
    });
    // Review F14: the request's own claim of the matching wallet is compared, never treated as proof.
    const claimed = await reviewBridgeRoute(
      {
        input: input(),
        wallet: { account: input().sourceAddress, chainId: "1" },
      },
      deps(),
    );
    expect(
      claimed.preflight.checks.find((x) => x.id === "WALLET"),
    ).toMatchObject({ status: "UNKNOWN", code: "WALLET_NOT_PROVEN" });
  });
  it("R6 an RPC failure is UNKNOWN, never an assumed balance", async () => {
    const r = await reviewBridgeRoute(
      { input: input() },
      deps({
        balances: async () => {
          throw new Error("rpc down");
        },
      }),
    );
    expect(r.preflight.checks.find((x) => x.id === "BALANCE")).toMatchObject({
      status: "UNKNOWN",
      code: "BALANCE_UNKNOWN",
    });
  });
});
