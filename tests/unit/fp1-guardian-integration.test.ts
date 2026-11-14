// Full-product integration audit (fp1): Guardian as the shared security layer of Swap and Bridge.
//  - Bridge recipient rules know the moved assets' contracts (a token-contract recipient blocks, as in Swap).
//  - The server-side Swap gate derives the same deterministic verdict from the facts the server holds and refuses a
//    BLOCK, so a direct API caller cannot obtain a route "verified for review" that Guardian blocks.
import { describe, expect, it } from "vitest";
import { review } from "../../src/guardian/verdict";
import type { BridgeFacts } from "../../src/guardian/model";
import {
  gateSwap,
  GuardianBlocked,
  swapAssetFacts,
  swapGateFacts,
} from "../../src/guardian/server/swap-gate";
import { swapIntent, swapQuote, usdc, wallet } from "../fixtures/swap";

const BURN = "0x000000000000000000000000000000000000dEaD";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const codes = (v: { findings: { code: string }[] }) =>
  v.findings.map((f) => f.code);
const bridge = (extra: Partial<BridgeFacts> = {}): BridgeFacts => ({
  kind: "bridge",
  sourceChain: "1",
  destinationChain: "8453",
  sender: wallet,
  recipient: wallet,
  pay: {
    chainId: "1",
    address: usdc,
    symbol: "USDC",
    native: false,
    level: "CURATED",
    risk: [],
  },
  receive: {
    chainId: "8453",
    address: USDC_BASE,
    symbol: "USDC",
    native: false,
    level: "CURATED",
    risk: [],
  },
  known: [wallet],
  ...extra,
});

describe("fp1 Bridge recipient rules", () => {
  it("FP1-01 a bridge whose recipient is the received token's own contract is blocked", () => {
    const v = review(bridge({ recipient: USDC_BASE }));
    expect(v.level).toBe("BLOCK");
    expect(codes(v)).toContain("RECIPIENT_TOKEN_CONTRACT");
    expect(v.steps[0]).toBe("STOP");
  });
  it("FP1-02 the paid token's contract is never a recipient either (case-insensitive EVM identity)", () => {
    const v = review(
      bridge({ recipient: usdc.toUpperCase().replace("0X", "0x") }),
    );
    expect(v.level).toBe("BLOCK");
    expect(codes(v)).toContain("RECIPIENT_TOKEN_CONTRACT");
  });
  it("FP1-03 native assets carry no contract: an external recipient only asks for care; self passes", () => {
    const native = (chainId: string) => ({
      chainId,
      address: "0x0000000000000000000000000000000000000000",
      symbol: "ETH",
      native: true,
    });
    const external = review(
      bridge({
        pay: native("1"),
        receive: native("8453"),
        recipient: USDC_BASE,
      }),
    );
    expect(external.level).toBe("CAUTION");
    expect(codes(external)).toContain("RECIPIENT_EXTERNAL");
    const self = review(bridge({ pay: native("1"), receive: native("8453") }));
    expect(codes(self)).toContain("RECIPIENT_SELF");
    expect(self.level).toBe("CLEAR");
  });
});

describe("fp1 server-side Swap gate", () => {
  it("FP1-04 registry evidence comes from the exact contract; a native token is canonical", () => {
    const i = swapIntent();
    expect(swapAssetFacts("1", i.tokenIn)).toMatchObject({
      native: true,
      level: "CANONICAL",
      risk: [],
    });
    expect(swapAssetFacts("1", i.tokenOut)).toMatchObject({
      level: "CURATED",
      risk: [],
    });
  });
  it("FP1-05 an unknown contract that carries a curated asset's symbol is an impersonation and blocks the receive side", () => {
    const i = swapIntent({
      tokenOut: {
        chain: "1",
        address: "0x" + "44".repeat(20),
        native: false,
        decimals: 6,
        symbol: "usdc",
      },
    });
    expect(swapAssetFacts("1", i.tokenOut).risk).toContain(
      "SYMBOL_IMPERSONATION",
    );
    expect(() => gateSwap(i)).toThrow(GuardianBlocked);
  });
  it("FP1-06 burn and token-contract recipients are refused before any build", () => {
    for (const recipient of [BURN, usdc]) {
      let blocked: GuardianBlocked | undefined;
      try {
        gateSwap(swapIntent({ recipient }));
      } catch (e) {
        blocked = e as GuardianBlocked;
      }
      expect(blocked).toBeInstanceOf(GuardianBlocked);
      expect(blocked!.message).toBe("GUARDIAN_BLOCKED");
      expect(blocked!.verdict.level).toBe("BLOCK");
      expect(codes(blocked!.verdict)).toEqual(
        expect.arrayContaining([
          recipient === BURN ? "RECIPIENT_BURN" : "RECIPIENT_TOKEN_CONTRACT",
        ]),
      );
    }
  });
  it("FP1-07 the reviewed quote joins the facts: a non-zero VEINED fee blocks, a clean quote passes deterministically", () => {
    const i = swapIntent();
    const clean = swapQuote(i);
    const a = gateSwap(i, clean),
      b = gateSwap(i, clean);
    expect(a.level).not.toBe("BLOCK");
    expect(a.digest).toBe(b.digest);
    expect(swapGateFacts(i, clean).quote?.platformFee).toBe("0");
    // The quote's own VEINED fee line (policy: always 0) is what the gate reads.
    expect(clean.costs.some((c) => c.kind === "PLATFORM")).toBe(true);
    const feeing = {
      ...clean,
      costs: clean.costs.map((c) =>
        c.kind === "PLATFORM" ? { ...c, amount: 1000n } : c,
      ),
    };
    expect(() => gateSwap(i, feeing)).toThrow(GuardianBlocked);
  });
  it("FP1-08 the server verdict equals the panel's for the same facts (one rule set)", () => {
    const i = swapIntent({ recipient: BURN });
    const facts = swapGateFacts(i);
    const now = Date.now();
    expect(review(facts, now).digest).toBe(review(facts, now).digest);
    expect(review(facts, now).level).toBe("BLOCK");
  });
});
