// G13 Phase 3: owner-signed execution foundation (pure modules), hardened after the independent review
// (evidence/review-p3/REVIEW.md: F01–F24). Every reviewer reproduction is a regression test here (F20).
// SYNTHETIC_TEST_ONLY: the account is 0x3333…3333; the one real artefact is a PUBLIC LI.FI quote's calldata for that
// synthetic account (tests/fixtures/g13-lifi-bridge-call.json). Nothing here signs, sends or reaches a network.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  type Hex,
} from "viem";
import call from "../fixtures/g13-lifi-bridge-call.json" with { type: "json" };
import {
  EXECUTION_POLICY,
  LIFECYCLE,
  TRANSITIONS,
  isCompleted,
  labelOf,
  type ExecutionPlan,
} from "../../src/execution/model";
import {
  AuthorizationError,
  authorizationProblem,
  issueAuthorization,
  planDigest,
  reviewDigest,
} from "../../src/execution/binding";
import { canonicalJson } from "../../src/execution/canonical";
import {
  apply,
  auditHead,
  newRecord,
  verifyAudit,
  type AuditEntry,
  type ExecutionEvent,
  type ExecutionRecord,
} from "../../src/execution/lifecycle";
import { digest } from "../../src/execution/canonical";
import {
  CHECK_IDS,
  preflight,
  preflightDigest,
  type PreflightFacts,
} from "../../src/execution/preflight";
import {
  APPROVE_SELECTOR,
  MAX_UINT256,
  approvalProblem,
  approvalTransaction,
  decodeApproval,
  encodeExactApproval,
} from "../../src/execution/erc20";
import { decodeLifiBridgeCall } from "../../src/execution/lifi-decoder";
import {
  PROVIDER_CONTRACTS,
  behaviourPinned,
  familyOf,
  identify,
} from "../../src/execution/providers";
import {
  nearStatusEvent,
  observeSource,
  reconcile,
  routeStatusEvent,
} from "../../src/execution/tracking";
import {
  buildNearExecutableRequest,
  nearExecutableProblems,
  nearQuoteKind,
  nearRequestRuleProblems,
  nearReviewDigest,
} from "../../src/execution/near";
import { executionGateState } from "../../src/execution/server/gate";
import { walletRequest } from "../../src/execution/wallet-request";
import { compareCanonicalTx } from "../../src/features/wallet/adapter";

const SELF = "0x3333333333333333333333333333333333333333";
const OTHER = "0x4444444444444444444444444444444444444444";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const DAI_BASE = "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb";
const DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const FEE_RECIPIENT = "c06ebbefd94032b85424d51906e2a335efae264b";
const NOW = 1_800_000_000_000;
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const NONCE = (n: number) => n.toString(16).padStart(32, "0");
const REAL = call.transaction.data;
/** Replaces argument word `i` (0 = first word after the selector) of calldata. */
const patchWord = (data: string, i: number, value: bigint | string) =>
  data.slice(0, 10 + i * 64) +
  (typeof value === "bigint"
    ? value.toString(16)
    : value.replace(/^0x/, "")
  ).padStart(64, "0") +
  data.slice(10 + (i + 1) * 64);
// BridgeData starts at argument word 3 (head: three offsets): referrer 6, sendingAssetId 7, receiver 8, minAmount 9,
// destinationChainId 10, hasSourceSwaps 11, hasDestinationCall 12.
const BD = {
  referrer: 6,
  sendingAssetId: 7,
  receiver: 8,
  minAmount: 9,
  destinationChainId: 10,
  hasDestinationCall: 12,
} as const;

const usdc = (chainId: string, address: string) => ({
  chainId,
  address,
  symbol: "USDC",
  decimals: 6,
  native: false,
});
function plan(over: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    version: EXECUTION_POLICY.version,
    kind: "EVM_BRIDGE",
    provider: "routing-core",
    tool: "lifiIntents",
    quoteId: "q-1",
    quotedAt: NOW - 1000,
    expiresAt: NOW + 25000,
    executable: true,
    account: SELF,
    sourceChainId: "8453",
    destinationChainId: "42161",
    pay: usdc("8453", USDC_BASE),
    receive: usdc("42161", USDC_ARB),
    // The real quote's own numbers (review F20): 5 USDC in, 5.007450 expected and minimum (an intents surplus).
    amountIn: call.fromAmount,
    expectedOut: call.toAmount,
    minimumOut: call.toAmountMin,
    recipient: SELF,
    refundTo: null,
    slippageBps: 50,
    platformFeeBps: 0,
    fees: [
      {
        name: "LIFI Fixed Fee",
        amount: "12500",
        usd: "0.0124",
        included: true,
        kind: "fee",
        asset: usdc("8453", USDC_BASE),
      },
      {
        name: "SEND",
        amount: "2700000000000",
        usd: "0.0027",
        included: false,
        kind: "gas",
        asset: {
          chainId: "8453",
          address: "0x0000000000000000000000000000000000000000",
          symbol: "ETH",
          decimals: 18,
          native: true,
        },
      },
    ],
    spender: DIAMOND,
    approval: { token: USDC_BASE, spender: DIAMOND, amount: call.fromAmount },
    transaction: { ...call.transaction },
    ...over,
  };
}
const ev = (chainId: string, address: string) => ({
  chainId,
  address: address.toLowerCase(),
  symbol: "USDC",
  decimals: 6,
  level: "CANONICAL",
  risk: [] as string[],
});
function facts(over: Partial<PreflightFacts> = {}): PreflightFacts {
  return {
    now: NOW,
    wallet: { account: SELF, chainId: "8453", proven: true },
    evidence: { pay: ev("8453", USDC_BASE), receive: ev("42161", USDC_ARB) },
    balances: {
      pay: "9000000",
      native: "10000000000000000",
      agreement: "AGREE",
    },
    allowance: "0",
    allowanceSpender: DIAMOND,
    gas: { limit: call.transaction.gas, maxFeePerGas: "1000000000" },
    inputUsd: "5.00",
    simulation: {
      success: true,
      block: "30000000",
      payDelta: "-5000000",
      receiveDelta: null,
      unexpectedOutflows: 0,
      allowanceAfter: "0",
    },
    guardian: { level: "CLEAR", digest: "d".repeat(64), quoteId: "q-1" },
    supportedDestinations: ["1", "8453", "42161"],
    ...over,
  };
}
const check = (p: ExecutionPlan, f: PreflightFacts, id: string) =>
  preflight(p, f).checks.find((c) => c.id === id)!;
const withData = (data: string) =>
  plan({ transaction: { ...call.transaction, data } });

describe("G13-X preflight on the real LI.FI calldata", () => {
  it("X1 everything provable passes; exactly the three unprovable facts stay UNKNOWN (never PASS)", () => {
    const r = preflight(plan(), facts());
    expect(r.checks.filter((c) => c.status !== "PASS")).toEqual([
      { id: "PROVIDER", status: "UNKNOWN", code: "CONTRACT_NOT_PINNED" },
      {
        id: "RECIPIENT",
        status: "UNKNOWN",
        code: "FACET_RECEIVER_NOT_VERIFIED",
      },
      {
        id: "AMOUNTS",
        status: "UNKNOWN",
        code: "DESTINATION_MINIMUM_NOT_DECODED",
      },
    ]);
    expect(r.ready).toBe(false);
    expect(r.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(executionGateState("8453").open).toBe(false);
  });
  it("X2 the decoder proves from the bytes: receiver, asset, chain, no destination call, fee step = the disclosed fee", () => {
    const d = decodeLifiBridgeCall(REAL, "8453")!;
    expect(d.receiver.toLowerCase()).toBe(SELF);
    expect(d.sendingAssetId.toLowerCase()).toBe(USDC_BASE.toLowerCase());
    expect(d.destinationChainId).toBe("42161");
    expect(d.hasDestinationCall).toBe(false);
    expect(d.minAmount).toBe(4987500n);
    expect(d.swaps).toHaveLength(1);
    expect(d.swaps[0].fees).toHaveLength(1);
    expect(d.swaps[0].fees![0].recipient.toLowerCase()).toBe(
      `0x${FEE_RECIPIENT}`,
    );
    expect(d.swaps[0].fees![0].amount).toBe(12500n);
    expect(5_000_000n - d.minAmount).toBe(12500n);
  });
});

describe("G13-X review F01: a recipient planted behind another function or a non-canonical offset is never read", () => {
  it("F01a another LI.FI function (swapTokensGeneric selector) is not decoded: RECIPIENT stays UNKNOWN", () => {
    const forged = "0x4630a0d8" + REAL.slice(10);
    expect(decodeLifiBridgeCall(forged, "8453")).toBeNull();
    expect(check(withData(forged), facts(), "RECIPIENT")).toMatchObject({
      status: "UNKNOWN",
      code: "CALLDATA_NOT_DECODED",
    });
  });
  it("F01b the reviewer's construction: real swapTokensGeneric args paying 0x4444… plus a planted BridgeData naming the owner", () => {
    const abi = parseAbi([
      "function swapTokensGeneric(bytes32,string,string,address,uint256,(address,address,address,address,uint256,bytes,bool)[])",
    ]);
    const real = encodeFunctionData({
      abi,
      functionName: "swapTokensGeneric",
      args: [H(1) as Hex, "x", "y", OTHER, 1n, []],
    });
    const planted = encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { type: "bytes32" },
            { type: "string" },
            { type: "string" },
            { type: "address" },
            { type: "address" },
            { type: "address" },
            { type: "uint256" },
            { type: "uint256" },
            { type: "bool" },
            { type: "bool" },
          ],
        },
      ],
      [
        [
          H(2) as Hex,
          "lifiIntents",
          "lifi-api",
          "0x0000000000000000000000000000000000000000",
          USDC_BASE,
          SELF,
          4987500n,
          42161n,
          true,
          false,
        ],
      ],
    );
    const forged = real + planted.slice(66);
    expect(decodeLifiBridgeCall(forged, "8453")).toBeNull();
    expect(preflight(withData(forged), facts()).ready).toBe(false);
    expect(check(withData(forged), facts(), "RECIPIENT").status).not.toBe(
      "PASS",
    );
  });
  it("F01c the allowlisted selector with a moved head offset (planted bytes) is refused", () => {
    expect(decodeLifiBridgeCall(patchWord(REAL, 0, 0x80n), "8453")).toBeNull();
  });
  it("F01d a receiver in the calldata that is not the owner is a definitive FAIL; a destination call too", () => {
    expect(
      check(
        withData(patchWord(REAL, BD.receiver, OTHER)),
        facts(),
        "RECIPIENT",
      ),
    ).toMatchObject({ status: "FAIL", code: "WRONG_RECIPIENT" });
    expect(
      check(
        withData(patchWord(REAL, BD.hasDestinationCall, 1n)),
        facts(),
        "RECIPIENT",
      ),
    ).toMatchObject({ status: "FAIL", code: "DESTINATION_CALL" });
  });
});

describe("G13-X review F02: the bridged amount, sending asset and every fee are tied to what was disclosed", () => {
  it("F02a bridged amount patched to 1 unit (provider keeps 99.99 %) fails", () => {
    expect(
      check(withData(patchWord(REAL, BD.minAmount, 1n)), facts(), "AMOUNTS"),
    ).toMatchObject({ status: "FAIL", code: "BRIDGED_BELOW_DISCLOSED" });
  });
  it("F02b a different sending asset fails", () => {
    expect(
      check(
        withData(patchWord(REAL, BD.sendingAssetId, DAI_BASE)),
        facts(),
        "AMOUNTS",
      ),
    ).toMatchObject({ status: "FAIL", code: "SENDING_ASSET_MISMATCH" });
  });
  it("F02c a fee paid to any address other than the pinned LI.FI fee recipient (an integrator / platform commission) fails", () => {
    const forged = REAL.replace(new RegExp(FEE_RECIPIENT, "i"), OTHER.slice(2));
    expect(forged).not.toBe(REAL);
    expect(check(withData(forged), facts(), "AMOUNTS")).toMatchObject({
      status: "FAIL",
      code: "UNEXPECTED_FEE_RECIPIENT",
    });
  });
  it("F02d an on-chain fee larger than the disclosed fee line fails; a referrer fails; bridged above input fails", () => {
    const p = plan({
      fees: [{ ...plan().fees[0], amount: "12000" }, plan().fees[1]],
    });
    expect(check(p, facts(), "AMOUNTS")).toMatchObject({
      status: "FAIL",
      code: "UNDISCLOSED_FEE",
    });
    expect(
      check(withData(patchWord(REAL, BD.referrer, OTHER)), facts(), "AMOUNTS"),
    ).toMatchObject({ status: "FAIL", code: "REFERRER_SET" });
    expect(
      check(
        withData(patchWord(REAL, BD.minAmount, 5_000_001n)),
        facts(),
        "AMOUNTS",
      ),
    ).toMatchObject({ status: "FAIL", code: "BRIDGED_ABOVE_INPUT" });
    expect(
      check(
        withData(patchWord(REAL, BD.destinationChainId, 10n)),
        facts(),
        "AMOUNTS",
      ),
    ).toMatchObject({ status: "FAIL", code: "DESTINATION_CHAIN_MISMATCH" });
  });
});

describe("G13-X other adversarial preflight cases", () => {
  it("X3 wrong token or chain", () => {
    expect(
      check(
        plan({
          pay: {
            ...plan().pay,
            address: DAI_BASE,
            symbol: "DAI",
            decimals: 18,
          },
        }),
        facts(),
        "ASSETS",
      ).code,
    ).toBe("PAY_ASSET_NOT_REVIEWED");
    expect(
      check(
        plan(),
        facts({
          evidence: {
            pay: { ...ev("8453", USDC_BASE), risk: ["IMPERSONATION"] },
            receive: ev("42161", USDC_ARB),
          },
        }),
        "ASSETS",
      ).status,
    ).toBe("FAIL");
    expect(
      check(
        plan({ transaction: { ...call.transaction, chainId: "1" } }),
        facts(),
        "CHAINS",
      ).code,
    ).toBe("TRANSACTION_CHAIN_MISMATCH");
    expect(
      check(
        plan({
          destinationChainId: "137",
          receive: { ...plan().receive, chainId: "137" },
        }),
        facts(),
        "CHAINS",
      ).code,
    ).toBe("UNSUPPORTED_CHAIN_PAIR");
    expect(
      check(plan(), facts({ evidence: { pay: null, receive: null } }), "ASSETS")
        .status,
    ).toBe("UNKNOWN");
  });
  it("X4 malicious target or spender; an upgradeable diamond is never 'reviewed' without a facet pin (F13)", () => {
    expect(
      check(
        plan({ transaction: { ...call.transaction, to: OTHER } }),
        facts(),
        "PROVIDER",
      ).code,
    ).toBe("UNEXPECTED_TARGET_CONTRACT");
    expect(
      check(
        plan({
          approval: { token: USDC_BASE, spender: OTHER, amount: "5000000" },
        }),
        facts(),
        "PROVIDER",
      ).code,
    ).toBe("UNEXPECTED_SPENDER");
    expect(
      check(
        plan({
          approval: {
            token: USDC_BASE,
            spender: "0x000000000022d473030f116ddee9f6b43ac78ba3",
            amount: "5000000",
          },
        }),
        facts(),
        "PROVIDER",
      ).code,
    ).toBe("UNEXPECTED_SPENDER");
    expect(
      check(plan({ provider: "some-new-aggregator" }), facts(), "PROVIDER")
        .code,
    ).toBe("PROVIDER_NOT_SUPPORTED");
    expect(check(plan(), facts(), "PROVIDER")).toMatchObject({
      status: "UNKNOWN",
      code: "CONTRACT_NOT_PINNED",
    });
    const diamond = PROVIDER_CONTRACTS.find((c) => c.family === "lifi")!;
    expect(behaviourPinned(diamond)).toBe(false);
    expect(familyOf("near-intents")).toBe("near-intents");
  });
  it("X5 unlimited, oversized, undersized, wrong-token, unnecessary and non-zero-first approvals (F15)", () => {
    const a = (amount: string) =>
      plan({ approval: { token: USDC_BASE, spender: DIAMOND, amount } });
    expect(check(a(MAX_UINT256.toString()), facts(), "APPROVAL").code).toBe(
      "UNLIMITED_APPROVAL",
    );
    expect(check(a((2n ** 255n).toString()), facts(), "APPROVAL").code).toBe(
      "UNLIMITED_APPROVAL",
    );
    expect(check(a("5000001"), facts(), "APPROVAL").code).toBe(
      "APPROVAL_EXCEEDS_AMOUNT",
    );
    expect(check(a("4999999"), facts(), "APPROVAL").code).toBe(
      "APPROVAL_BELOW_AMOUNT",
    );
    expect(
      check(
        plan({
          approval: { token: USDC_ARB, spender: DIAMOND, amount: "5000000" },
        }),
        facts(),
        "APPROVAL",
      ).code,
    ).toBe("APPROVAL_WRONG_TOKEN");
    expect(
      check(plan(), facts({ allowance: "5000000" }), "APPROVAL").code,
    ).toBe("APPROVAL_NOT_NEEDED");
    expect(check(plan(), facts({ allowance: "1" }), "APPROVAL").code).toBe(
      "NONZERO_ALLOWANCE_FIRST",
    );
    expect(check(plan({ approval: null }), facts(), "APPROVAL").code).toBe(
      "APPROVAL_MISSING",
    );
    expect(check(plan(), facts({ allowance: null }), "APPROVAL").status).toBe(
      "UNKNOWN",
    );
    expect(() =>
      approvalTransaction({
        ...plan(),
        approval: { token: USDC_BASE, spender: DIAMOND, amount: "4999999" },
      }),
    ).toThrow("APPROVAL_NOT_EXACT");
    expect(() => encodeExactApproval(DIAMOND, MAX_UINT256)).toThrow();
  });
  it("X6 quote manipulation: minimum above estimate, exact slippage bound (F12), VEINED fee, undisclosed value", () => {
    expect(
      check(plan({ minimumOut: "5007451" }), facts(), "AMOUNTS").code,
    ).toBe("MINIMUM_ABOVE_EXPECTED");
    const s = (min: string) =>
      check(
        plan({ expectedOut: "1000000", minimumOut: min, slippageBps: 300 }),
        facts(),
        "AMOUNTS",
      );
    expect(s("969810").code).toBe("SLIPPAGE_ABOVE_POLICY");
    expect(s("970000").code).not.toBe("SLIPPAGE_ABOVE_POLICY");
    expect(check(plan({ slippageBps: 301 }), facts(), "AMOUNTS").code).toBe(
      "SLIPPAGE_ABOVE_POLICY",
    );
    // Live finding: a provider's floored minimum at exactly 0.5 % (gap = ceil(expected / 200)) is not a violation.
    const e = 1_993_456_789_012_345n;
    const floored = (e * 9950n) / 10000n;
    expect(
      check(
        plan({ expectedOut: String(e), minimumOut: String(floored) }),
        facts(),
        "AMOUNTS",
      ).code,
    ).not.toBe("SLIPPAGE_ABOVE_POLICY");
    expect(
      check(
        plan({ expectedOut: String(e), minimumOut: String(floored - 1n) }),
        facts(),
        "AMOUNTS",
      ).code,
    ).toBe("SLIPPAGE_ABOVE_POLICY");
    expect(check(plan({ platformFeeBps: 25 }), facts(), "FEES").code).toBe(
      "PLATFORM_FEE_NOT_ALLOWED",
    );
    expect(
      check(
        plan({ transaction: { ...call.transaction, value: "1" } }),
        facts(),
        "AMOUNTS",
      ).code,
    ).toBe("UNDISCLOSED_VALUE");
    expect(
      check(
        plan({ fees: [{ ...plan().fees[0], usd: "0.9" }, plan().fees[1]] }),
        facts(),
        "FEES",
      ).code,
    ).toBe("UNECONOMIC");
    expect(planDigest(plan({ minimumOut: "5007449" }))).not.toBe(
      planDigest(plan()),
    );
    expect(
      planDigest(
        withData(REAL.slice(0, -1) + (REAL.endsWith("1") ? "2" : "1")),
      ),
    ).not.toBe(planDigest(plan()));
  });
  it("X7 F09 garbage numbers never pass; F11 a quote without a network fee line is not 'fees disclosed'", () => {
    for (const value of ["", " 0 ", "0x0", "0b0", "1e9", "-0"]) {
      const r = preflight(
        plan({ transaction: { ...call.transaction, value } }),
        facts(),
      );
      expect(r.ready, value).toBe(false);
      expect(
        r.checks.every((c) => c.status === "FAIL" && c.code === "PLAN_INVALID"),
        value,
      ).toBe(true);
    }
    for (const allowanceAfter of ["unknown", "-1", "1e9", null])
      expect(
        check(
          plan(),
          facts({ simulation: { ...facts().simulation!, allowanceAfter } }),
          "SIMULATION",
        ).status,
      ).toBe("UNKNOWN");
    expect(
      check(plan({ slippageBps: 50.5 }), facts(), "AMOUNTS"),
    ).toMatchObject({ status: "FAIL", code: "PLAN_INVALID" });
    expect(
      check(plan({ fees: [plan().fees[0]] }), facts(), "FEES"),
    ).toMatchObject({ status: "UNKNOWN", code: "NETWORK_FEE_NOT_QUOTED" });
  });
  it("X8 F10 gas uses the transaction's own limit and fee cap; fee caps are bound by the plan digest", () => {
    const p = plan({
      transaction: { ...call.transaction, maxFeePerGas: "1000000000" },
    });
    expect(
      check(
        p,
        facts({
          gas: { limit: "1", maxFeePerGas: "1" },
          balances: { pay: "9000000", native: "2", agreement: "AGREE" },
        }),
        "GAS",
      ).code,
    ).toBe("INSUFFICIENT_GAS");
    expect(
      check(p, facts({ gas: { limit: "1", maxFeePerGas: "1" } }), "GAS").code,
    ).toBe("GAS_COVERED");
    expect(planDigest(p)).not.toBe(planDigest(plan()));
  });
  it("X9 expired, stale, dry and future-dated quotes", () => {
    expect(check(plan(), facts({ now: NOW + 25000 }), "QUOTE").code).toBe(
      "QUOTE_EXPIRED",
    );
    expect(check(plan(), facts({ now: NOW + 16000 }), "QUOTE").code).toBe(
      "QUOTE_TOO_OLD",
    );
    expect(check(plan({ executable: false }), facts(), "QUOTE").code).toBe(
      "DRY_QUOTE_NOT_EXECUTABLE",
    );
    expect(
      check(
        plan({ quotedAt: NOW + 60000, expiresAt: NOW + 90000 }),
        facts(),
        "QUOTE",
      ).code,
    ).toBe("QUOTE_TIME_INVALID");
  });
  it("X10 insufficient balance, RPC disagreement, single RPC source, insufficient gas", () => {
    expect(
      check(
        plan(),
        facts({
          balances: {
            pay: "4999999",
            native: "10000000000000000",
            agreement: "AGREE",
          },
        }),
        "BALANCE",
      ).code,
    ).toBe("INSUFFICIENT_BALANCE");
    expect(
      check(
        plan(),
        facts({
          balances: {
            pay: "9000000",
            native: "10000000000000000",
            agreement: "DISAGREE",
          },
        }),
        "BALANCE",
      ).code,
    ).toBe("RPC_DISAGREEMENT");
    expect(
      check(
        plan(),
        facts({
          balances: {
            pay: "9000000",
            native: "10000000000000000",
            agreement: "SINGLE",
          },
        }),
        "BALANCE",
      ).status,
    ).toBe("UNKNOWN");
    expect(
      check(
        plan(),
        facts({
          balances: { pay: "9000000", native: "1000", agreement: "AGREE" },
        }),
        "GAS",
      ).code,
    ).toBe("INSUFFICIENT_GAS");
  });
  it("X11 simulation must reproduce exactly the planned input and nothing else", () => {
    const sim = facts().simulation!;
    expect(
      check(plan(), facts({ simulation: null }), "SIMULATION").status,
    ).toBe("UNKNOWN");
    expect(
      check(
        plan(),
        facts({ simulation: { ...sim, success: false } }),
        "SIMULATION",
      ).code,
    ).toBe("SIMULATION_REVERTED");
    expect(
      check(
        plan(),
        facts({ simulation: { ...sim, payDelta: "-5000001" } }),
        "SIMULATION",
      ).code,
    ).toBe("SIMULATED_INPUT_MISMATCH");
    expect(
      check(
        plan(),
        facts({ simulation: { ...sim, unexpectedOutflows: 1 } }),
        "SIMULATION",
      ).code,
    ).toBe("UNEXPECTED_OUTFLOW");
    expect(
      check(
        plan(),
        facts({ simulation: { ...sim, allowanceAfter: "1" } }),
        "SIMULATION",
      ).code,
    ).toBe("RESIDUAL_ALLOWANCE");
  });
  it("X12 Guardian BLOCK / HOLD / stale / forged level cannot be bypassed", () => {
    for (const level of ["BLOCK", "HOLD"])
      expect(
        check(
          plan(),
          facts({
            guardian: { level, digest: "d".repeat(64), quoteId: "q-1" },
          }),
          "GUARDIAN",
        ).status,
      ).toBe("FAIL");
    expect(
      check(
        plan(),
        facts({
          guardian: { level: "ALLOW", digest: "d".repeat(64), quoteId: "q-1" },
        }),
        "GUARDIAN",
      ).code,
    ).toBe("GUARDIAN_UNKNOWN_LEVEL");
    expect(
      check(
        plan(),
        facts({
          guardian: { level: "CLEAR", digest: "d".repeat(64), quoteId: "q-0" },
        }),
        "GUARDIAN",
      ).code,
    ).toBe("GUARDIAN_STALE");
  });
  it("X13 wallet disconnected, switched, or merely claimed (F14)", () => {
    expect(
      check(
        plan(),
        facts({ wallet: { account: null, chainId: null, proven: false } }),
        "WALLET",
      ).status,
    ).toBe("UNKNOWN");
    expect(
      check(
        plan(),
        facts({ wallet: { account: OTHER, chainId: "8453", proven: true } }),
        "WALLET",
      ).code,
    ).toBe("WALLET_ACCOUNT_MISMATCH");
    expect(
      check(
        plan(),
        facts({ wallet: { account: SELF, chainId: "42161", proven: true } }),
        "WALLET",
      ).code,
    ).toBe("WALLET_CHAIN_MISMATCH");
    expect(
      check(
        plan(),
        facts({ wallet: { account: SELF, chainId: "8453", proven: false } }),
        "WALLET",
      ),
    ).toMatchObject({ status: "UNKNOWN", code: "WALLET_NOT_PROVEN" });
  });
  it("X14 no calldata (today's routing quotes) is UNKNOWN on every check that needs it", () => {
    const r = preflight(
      plan({ transaction: null }),
      facts({ simulation: null }),
    );
    for (const id of ["PROVIDER", "RECIPIENT", "AMOUNTS", "GAS", "SIMULATION"])
      expect(r.checks.find((c) => c.id === id)?.status, id).toBe("UNKNOWN");
  });
  it("X15 exact approval codec", () => {
    const data = encodeExactApproval(DIAMOND, 5_000_000n);
    expect(data.slice(0, 10)).toBe(APPROVE_SELECTOR);
    expect(decodeApproval(data)).toEqual({
      spender: DIAMOND,
      amount: 5_000_000n,
    });
    expect(decodeApproval(data + "00")).toBeNull();
    expect(approvalTransaction(plan())).toEqual({
      chainId: "8453",
      from: SELF,
      to: USDC_BASE,
      value: "0",
      data,
    });
    expect(
      approvalProblem(
        plan({ pay: { ...plan().pay, native: true } }),
        0n,
        () => true,
      ),
    ).toBe("APPROVAL_ON_NATIVE");
    expect(identify("137", DIAMOND, "spender", "lifi")).toBeNull();
    expect(
      PROVIDER_CONTRACTS.every((c) => c.executionStatus === "REVIEW_REQUIRED"),
    ).toBe(true);
  });
});

// ---- Lifecycle ----
const RID = "g13-test-0001";
const go = (r: ExecutionRecord, ...events: ExecutionEvent[]) =>
  events.reduce(apply, r);
const auth = (
  review: string,
  action: "APPROVE" | "SEND",
  n: number,
  at = NOW,
  account = SELF,
  record = RID,
  quoteExpiresAt = NOW + 25000,
) =>
  issueAuthorization({
    action,
    review,
    record,
    account,
    now: at,
    quoteExpiresAt,
    nonce: NONCE(n),
    trustedGesture: true,
  });
function reviewed(
  p: ExecutionPlan = plan(),
  at = NOW,
  base: ExecutionRecord = newRecord(RID),
) {
  let r = go(base, { type: "QUOTE_READ", at, plan: p });
  r = go(r, PF(r.planHash!, at), {
    type: "GUARDIAN",
    at,
    plan: r.planHash!,
    level: "CLEAR",
    digest: "b".repeat(64),
    quoteId: p.quoteId,
  });
  const review = reviewDigest(
    r.planHash!,
    "b".repeat(64),
    PF(r.planHash!, at).digest,
  );
  return { r: go(r, { type: "REVIEW_SHOWN", at, review }), review };
}
function sent(withApproval = false) {
  const x = reviewed(plan(withApproval ? {} : { approval: null }));
  return go(
    x.r,
    {
      type: "OWNER_AUTHORIZED",
      at: NOW + 1,
      authorization: auth(x.review, withApproval ? "APPROVE" : "SEND", 1),
    },
    {
      type: "TX_SUBMITTED",
      at: NOW + 2,
      role: withApproval ? "approval" : "main",
      hash: H(1),
      nonce: NONCE(1),
    },
  );
}

describe("G13-X lifecycle", () => {
  it("X16 full happy path; nothing reads 'completed' before reconciliation; the audit chain verifies with its anchor", () => {
    const first = reviewed();
    let r = first.r;
    const review = first.review;
    r = go(r, {
      type: "OWNER_AUTHORIZED",
      at: NOW + 1,
      authorization: auth(review, "APPROVE", 1, NOW + 1),
    });
    r = go(r, {
      type: "TX_SUBMITTED",
      at: NOW + 2,
      role: "approval",
      hash: H(1),
      nonce: NONCE(1),
    });
    r = go(r, {
      type: "TX_CONFIRMED",
      at: NOW + 4,
      role: "approval",
      hash: H(1),
      block: "100",
      blockHash: H(100),
      confirmations: 10,
    });
    expect(r.state).toBe("APPROVAL_CONFIRMED");
    const p2 = plan({
      quoteId: "q-2",
      quotedAt: NOW + 5,
      expiresAt: NOW + 25005,
      approval: null,
    });
    r = go(r, { type: "QUOTE_READ", at: NOW + 5, plan: p2 });
    r = go(r, PF(r.planHash!, NOW + 5), {
      type: "GUARDIAN",
      at: NOW + 5,
      plan: r.planHash!,
      level: "CAUTION",
      digest: "e".repeat(64),
      quoteId: "q-2",
    });
    const review2 = reviewDigest(
      r.planHash!,
      "e".repeat(64),
      PF(r.planHash!, NOW + 5).digest,
    );
    r = go(
      r,
      { type: "REVIEW_SHOWN", at: NOW + 6, review: review2 },
      {
        type: "OWNER_AUTHORIZED",
        at: NOW + 7,
        authorization: auth(
          review2,
          "SEND",
          2,
          NOW + 7,
          SELF,
          RID,
          NOW + 25005,
        ),
      },
    );
    r = go(r, {
      type: "TX_SUBMITTED",
      at: NOW + 8,
      role: "main",
      hash: H(2),
      nonce: NONCE(2),
    });
    expect(labelOf(r.state)).toBe("PENDING");
    r = go(
      r,
      {
        type: "TX_CONFIRMED",
        at: NOW + 9,
        role: "main",
        hash: H(2),
        block: "200",
        blockHash: H(200),
        confirmations: 12,
      },
      { type: "DESTINATION", at: NOW + 10, status: "PENDING" },
    );
    r = go(r, {
      type: "DESTINATION",
      at: NOW + 11,
      status: "DELIVERED",
      hash: H(3),
      amount: "5007450",
    });
    expect(r.state).toBe("SETTLED");
    expect(isCompleted(r.state)).toBe(false);
    r = go(r, {
      type: "RECONCILED",
      at: NOW + 12,
      ok: true,
      detail: "BALANCES_RECONCILED",
    });
    expect(labelOf(r.state)).toBe("COMPLETED");
    expect(verifyAudit(r.id, r.audit, auditHead(r))).toEqual({ ok: true });
  });
  it("X17 only RECONCILED is ever labelled completed; dropped / replaced / refunded / failed delivery need attention", () => {
    for (const s of LIFECYCLE)
      expect(labelOf(s) === "COMPLETED", s).toBe(s === "RECONCILED");
    for (const s of [
      "DROPPED",
      "REPLACED",
      "REFUNDED",
      "DESTINATION_FAILED",
      "UNCERTAIN",
      "DISCREPANCY",
    ] as const)
      expect(labelOf(s), s).toBe("NEEDS_ATTENTION");
    for (const s of LIFECYCLE)
      for (const t of TRANSITIONS[s]) expect(LIFECYCLE).toContain(t);
  });
  it("F04 the review is recomputed from the record; authorizations are bound to their record; plan digests must match", () => {
    const base = go(newRecord(RID), {
      type: "QUOTE_READ",
      at: NOW,
      plan: plan(),
    });
    expect(() => go(base, PF("f".repeat(64), NOW))).toThrow(
      "PREFLIGHT_PLAN_MISMATCH",
    );
    const g = go(base, PF(base.planHash!, NOW), {
      type: "GUARDIAN",
      at: NOW,
      plan: base.planHash!,
      level: "CLEAR",
      digest: "b".repeat(64),
      quoteId: "q-1",
    });
    expect(() =>
      go(g, { type: "REVIEW_SHOWN", at: NOW, review: "anything" }),
    ).toThrow("REVIEW_MISMATCH");
    const { r, review } = reviewed();
    expect(() =>
      go(r, {
        type: "OWNER_AUTHORIZED",
        at: NOW + 1,
        authorization: auth(review, "APPROVE", 1, NOW, SELF, "g13-other-0002"),
      }),
    ).toThrow("WRONG_RECORD");
    expect(() =>
      go(r, {
        type: "OWNER_AUTHORIZED",
        at: NOW + 1,
        authorization: auth("f".repeat(64), "APPROVE", 1),
      }),
    ).toThrow("WRONG_REVIEW");
    expect(() =>
      go(r, {
        type: "OWNER_AUTHORIZED",
        at: NOW + 1,
        authorization: auth(review, "APPROVE", 1, NOW, OTHER),
      }),
    ).toThrow("WRONG_ACCOUNT");
    expect(() =>
      go(r, {
        type: "OWNER_AUTHORIZED",
        at: NOW + 1,
        authorization: auth(review, "SEND", 1),
      }),
    ).toThrow("WRONG_ACTION");
  });
  it("X18 no submission without a fresh, trusted, exact, single-use authorization with enough quote time (F16a)", () => {
    const { r, review } = reviewed();
    expect(() =>
      go(r, {
        type: "TX_SUBMITTED",
        at: NOW + 1,
        role: "approval",
        hash: H(1),
        nonce: NONCE(1),
      }),
    ).toThrow("SUBMISSION_NOT_AUTHORIZED");
    expect(() =>
      issueAuthorization({
        action: "APPROVE",
        review,
        record: RID,
        account: SELF,
        now: NOW,
        quoteExpiresAt: NOW + 25000,
        nonce: NONCE(1),
        trustedGesture: false,
      }),
    ).toThrow(AuthorizationError);
    expect(() =>
      issueAuthorization({
        action: "APPROVE",
        review,
        record: RID,
        account: SELF,
        now: NOW,
        quoteExpiresAt: NOW + 1,
        nonce: NONCE(1),
        trustedGesture: true,
      }),
    ).toThrow("QUOTE_TOO_CLOSE_TO_EXPIRY");
    const late = {
      action: "APPROVE" as const,
      review,
      record: RID,
      account: SELF,
      issuedAt: NOW + 24990,
      expiresAt: NOW + 25000,
      nonce: NONCE(4),
    };
    expect(() =>
      go(r, { type: "OWNER_AUTHORIZED", at: NOW + 24991, authorization: late }),
    ).toThrow("QUOTE_TOO_CLOSE_TO_EXPIRY");
    const ok = go(r, {
      type: "OWNER_AUTHORIZED",
      at: NOW + 1,
      authorization: auth(review, "APPROVE", 1),
    });
    expect(() =>
      go(ok, {
        type: "TX_SUBMITTED",
        at: NOW + 2,
        role: "approval",
        hash: H(1),
        nonce: NONCE(9),
      }),
    ).toThrow("SUBMISSION_NOT_AUTHORIZED");
    expect(
      authorizationProblem(auth(review, "APPROVE", 1), {
        action: "APPROVE",
        review,
        record: RID,
        account: SELF,
        now: NOW + 1,
        used: new Set([NONCE(1)]),
      }),
    ).toBe("NONCE_REUSED");
  });
  it("X19 duplicate submission refused; an uncertain wallet never gets a second request and resolves only with evidence (F06d)", () => {
    const { r, review } = reviewed(plan({ approval: null }));
    const w = go(r, {
      type: "OWNER_AUTHORIZED",
      at: NOW + 1,
      authorization: auth(review, "SEND", 1),
    });
    const s1 = go(w, {
      type: "TX_SUBMITTED",
      at: NOW + 2,
      role: "main",
      hash: H(1),
      nonce: NONCE(1),
    });
    expect(() =>
      go(s1, {
        type: "TX_SUBMITTED",
        at: NOW + 3,
        role: "main",
        hash: H(2),
        nonce: NONCE(1),
      }),
    ).toThrow("DUPLICATE_SUBMISSION");
    const u = go(w, { type: "WALLET_UNCERTAIN", at: NOW + 2 });
    expect(() =>
      go(u, {
        type: "OWNER_AUTHORIZED",
        at: NOW + 3,
        authorization: auth(review, "SEND", 2),
      }),
    ).toThrow("UNCERTAIN_NO_NEW_SIGNATURE");
    expect(() => go(u, { type: "OWNER_REJECTED", at: NOW + 3 })).toThrow(
      "REJECTION_NOT_EXPECTED",
    );
    expect(() =>
      go(u, {
        type: "UNCERTAIN_TIMEOUT",
        at: NOW + 3,
        accountNonceUnchanged: true,
      }),
    ).toThrow("NOT_DROPPED_YET");
    expect(() =>
      go(u, {
        type: "UNCERTAIN_TIMEOUT",
        at: NOW + 2 + EXECUTION_POLICY.dropAfterMs,
        accountNonceUnchanged: false,
      }),
    ).toThrow("NOT_DROPPED_YET");
    const d = go(u, {
      type: "UNCERTAIN_TIMEOUT",
      at: NOW + 2 + EXECUTION_POLICY.dropAfterMs,
      accountNonceUnchanged: true,
    });
    expect(d.state).toBe("DROPPED");
    expect(labelOf(d.state)).toBe("NEEDS_ATTENTION");
    expect(
      go(u, {
        type: "TX_SUBMITTED",
        at: NOW + 3,
        role: "main",
        hash: H(1),
        nonce: NONCE(1),
      }).state,
    ).toBe("SUBMITTED");
  });
  it("F06c expiry while a wallet prompt may be open becomes UNCERTAIN, and the hash returned later is still recorded", () => {
    const { r, review } = reviewed(plan({ approval: null }));
    const w = go(r, {
      type: "OWNER_AUTHORIZED",
      at: NOW + 1,
      authorization: auth(review, "SEND", 1),
    });
    const ex = go(w, { type: "EXPIRED", at: NOW + 25000 });
    expect(ex.state).toBe("UNCERTAIN");
    expect(
      go(ex, {
        type: "TX_SUBMITTED",
        at: NOW + 26000,
        role: "main",
        hash: H(7),
        nonce: NONCE(1),
      }).state,
    ).toBe("SUBMITTED");
    expect(go(r, { type: "EXPIRED", at: NOW + 25000 }).state).toBe("EXPIRED");
  });
  it("F05 no second main signature after a reorg; reorg / reobservation must name this intent's hash and role", () => {
    let s = sent();
    s = go(s, {
      type: "TX_CONFIRMED",
      at: NOW + 3,
      role: "main",
      hash: H(1),
      block: "1",
      blockHash: H(1),
      confirmations: 10,
    });
    expect(() =>
      go(s, { type: "REORG", at: NOW + 4, role: "main", hash: H(999) }),
    ).toThrow("REORG_NOT_EXPECTED");
    const org = go(s, { type: "REORG", at: NOW + 4, role: "main", hash: H(1) });
    expect(org.state).toBe("REORGED");
    expect(() =>
      go(org, {
        type: "REOBSERVED",
        at: NOW + 5,
        role: "approval",
        hash: H(999),
      }),
    ).toThrow("REOBSERVE_NOT_EXPECTED");
    expect(() =>
      go(org, { type: "REOBSERVED", at: NOW + 5, role: "main", hash: H(999) }),
    ).toThrow("REOBSERVE_NOT_EXPECTED");
    expect(TRANSITIONS.REORGED).toEqual([
      "SUBMITTED",
      "SOURCE_CONFIRMED",
      "SOURCE_FAILED",
      "DROPPED",
      "REPLACED",
    ]);
    expect(
      go(org, { type: "REOBSERVED", at: NOW + 5, role: "main", hash: H(1) })
        .state,
    ).toBe("SUBMITTED");
    const pending = go(s, {
      type: "DESTINATION",
      at: NOW + 4,
      status: "PENDING",
    });
    expect(
      go(pending, { type: "REORG", at: NOW + 5, role: "main", hash: H(1) })
        .state,
    ).toBe("REORGED");
  });
  it("F06a/b observations about other hashes never end a record; a speed-up keeps tracking; a cancel ends it", () => {
    const s = sent();
    const sped = go(s, {
      type: "TX_REPLACED",
      at: NOW + 3,
      role: "main",
      replaced: H(1),
      hash: H(5),
      sameIntent: true,
    });
    expect(sped.hashes.main).toBe(H(5));
    expect(() =>
      go(sped, {
        type: "TX_DROPPED",
        at: NOW + 4,
        role: "main",
        hash: H(1),
        unseenForMs: EXECUTION_POLICY.dropAfterMs + 1,
      }),
    ).toThrow("OBSERVATION_NOT_EXPECTED");
    expect(() =>
      go(sped, { type: "TX_FAILED", at: NOW + 4, role: "main", hash: H(77) }),
    ).toThrow("OBSERVATION_NOT_EXPECTED");
    expect(() =>
      go(sped, {
        type: "TX_REPLACED",
        at: NOW + 4,
        role: "main",
        replaced: H(77),
        hash: H(6),
        sameIntent: false,
      }),
    ).toThrow("REPLACEMENT_NOT_EXPECTED");
    expect(
      go(sped, {
        type: "TX_CONFIRMED",
        at: NOW + 5,
        role: "main",
        hash: H(1),
        block: "1",
        blockHash: H(1),
        confirmations: 10,
      }).state,
    ).toBe("SOURCE_CONFIRMED");
    expect(() =>
      go(sped, {
        type: "TX_DROPPED",
        at: NOW + 4,
        role: "main",
        hash: H(5),
        unseenForMs: 1000,
      }),
    ).toThrow("NOT_DROPPED_YET");
    // A full window unseen since this record last saw the transaction (the speed-up), round 5 T1.
    expect(() =>
      go(sped, {
        type: "TX_DROPPED",
        at: NOW + 4,
        role: "main",
        hash: H(5),
        unseenForMs: EXECUTION_POLICY.dropAfterMs + 1,
      }),
    ).toThrow("NOT_DROPPED_YET");
    expect(
      go(sped, {
        type: "TX_DROPPED",
        at: NOW + 4 + EXECUTION_POLICY.dropAfterMs,
        role: "main",
        hash: H(5),
        unseenForMs: EXECUTION_POLICY.dropAfterMs + 1,
      }).state,
    ).toBe("DROPPED");
    expect(
      go(s, {
        type: "TX_REPLACED",
        at: NOW + 3,
        role: "main",
        replaced: H(1),
        hash: H(6),
        sameIntent: false,
      }).state,
    ).toBe("REPLACED");
  });
  it("F16 re-quote identity, dry plans, approval reorg, destination hash format", () => {
    let a = sent(true);
    a = go(a, {
      type: "TX_CONFIRMED",
      at: NOW + 3,
      role: "approval",
      hash: H(1),
      block: "1",
      blockHash: H(1),
      confirmations: 10,
    });
    expect(() =>
      go(a, {
        type: "QUOTE_READ",
        at: NOW + 4,
        plan: plan({
          amountIn: "6000000",
          approval: { token: USDC_BASE, spender: DIAMOND, amount: "6000000" },
        }),
      }),
    ).toThrow("PLAN_IDENTITY_CHANGED");
    expect(() =>
      go(a, {
        type: "QUOTE_READ",
        at: NOW + 4,
        plan: plan({ pay: usdc("8453", DAI_BASE) }),
      }),
    ).toThrow("PLAN_IDENTITY_CHANGED");
    expect(
      go(a, { type: "REORG", at: NOW + 4, role: "approval", hash: H(1) }).state,
    ).toBe("APPROVAL_SUBMITTED");
    expect(() =>
      go(newRecord("g13-test-0009"), {
        type: "QUOTE_READ",
        at: NOW,
        plan: plan({ executable: false }),
      }),
    ).toThrow("DRY_QUOTE_NOT_EXECUTABLE");
    let m = sent();
    m = go(m, {
      type: "TX_CONFIRMED",
      at: NOW + 3,
      role: "main",
      hash: H(1),
      block: "1",
      blockHash: H(1),
      confirmations: 10,
    });
    expect(() =>
      go(m, {
        type: "DESTINATION",
        at: NOW + 4,
        status: "DELIVERED",
        hash: "abcdefghijabcdefghij",
        amount: "5007450",
      }),
    ).toThrow("DESTINATION_HASH_REQUIRED");
  });
  it("X20 failed, refunded, partial, short and unproven bridge settlement never read as completed", () => {
    let m = sent();
    m = go(m, {
      type: "TX_CONFIRMED",
      at: NOW + 3,
      role: "main",
      hash: H(1),
      block: "1",
      blockHash: H(1),
      confirmations: 10,
    });
    expect(
      go(m, { type: "DESTINATION", at: NOW + 4, status: "FAILED" }).state,
    ).toBe("DESTINATION_FAILED");
    const refund = go(m, {
      type: "DESTINATION",
      at: NOW + 4,
      status: "REFUND_PENDING",
    });
    expect(
      go(refund, {
        type: "DESTINATION",
        at: NOW + 5,
        status: "REFUNDED",
        amount: "4990000",
      }).state,
    ).toBe("REFUNDED");
    expect(
      go(m, { type: "DESTINATION", at: NOW + 4, status: "PARTIAL", hash: H(3) })
        .state,
    ).toBe("DISCREPANCY");
    expect(
      go(m, {
        type: "DESTINATION",
        at: NOW + 4,
        status: "DELIVERED",
        hash: H(3),
        amount: "5007449",
      }).state,
    ).toBe("DISCREPANCY");
    expect(() =>
      go(m, {
        type: "DESTINATION",
        at: NOW + 4,
        status: "DELIVERED",
        hash: H(3),
      }),
    ).toThrow("DESTINATION_AMOUNT_REQUIRED");
  });
  it("X21 Guardian block and VEINED fee stop the record before any signature", () => {
    const base = go(newRecord("g13-test-0002"), {
      type: "QUOTE_READ",
      at: NOW,
      plan: plan(),
    });
    const b = go(base, PF(base.planHash!, NOW), {
      type: "GUARDIAN",
      at: NOW,
      plan: base.planHash!,
      level: "BLOCK",
      digest: "b".repeat(64),
      quoteId: "q-1",
    });
    expect(b.state).toBe("BLOCKED");
    expect(() =>
      go(b, {
        type: "OWNER_AUTHORIZED",
        at: NOW + 1,
        authorization: auth(
          "x".repeat(64),
          "APPROVE",
          1,
          NOW,
          SELF,
          "g13-test-0002",
        ),
      }),
    ).toThrow("AUTHORIZATION_NOT_EXPECTED");
    expect(() =>
      go(newRecord("g13-test-0003"), {
        type: "QUOTE_READ",
        at: NOW,
        plan: plan({ platformFeeBps: 10 }),
      }),
    ).toThrow("PLATFORM_FEE_NOT_ALLOWED");
  });
  it("F07 the audit chain replays transitions (a fabricated chain fails) and an anchored head detects a cut-off tail", () => {
    const fabricated = (() => {
      const e0 = { type: "QUOTE_READ", at: NOW } as Record<string, unknown>;
      const a0 = {
        seq: 0,
        at: NOW,
        type: "QUOTE_READ" as const,
        state: "QUOTED" as const,
        event: e0,
        prev: "0".repeat(64),
        hash: "",
      };
      a0.hash = digest({
        seq: 0,
        at: NOW,
        type: a0.type,
        state: a0.state,
        event: e0,
        prev: a0.prev,
        id: RID,
      });
      const e1 = { type: "RECONCILED", at: NOW + 1, ok: true } as Record<
        string,
        unknown
      >;
      const a1 = {
        seq: 1,
        at: NOW + 1,
        type: "RECONCILED" as const,
        state: "RECONCILED" as const,
        event: e1,
        prev: a0.hash,
        hash: "",
      };
      a1.hash = digest({
        seq: 1,
        at: NOW + 1,
        type: a1.type,
        state: a1.state,
        event: e1,
        prev: a1.prev,
        id: RID,
      });
      return [a0, a1];
    })();
    expect(verifyAudit(RID, fabricated)).toEqual({ ok: false, at: 1 });
    const { r } = reviewed();
    const head = auditHead(r);
    expect(verifyAudit(r.id, r.audit.slice(0, -1))).toEqual({ ok: true }); // tamper-evident only with an anchor …
    expect(verifyAudit(r.id, r.audit.slice(0, -1), head).ok).toBe(false); // … which detects the cut tail
    const edited = r.audit.map((a, i) =>
      i === 1 ? { ...a, event: { ...a.event, ready: false } } : a,
    );
    expect(verifyAudit(r.id, edited).ok).toBe(false);
  });
});

describe("G13-X observation, settlement and reconciliation (read-only; nothing is ever re-sent)", () => {
  const base = {
    role: "main" as const,
    hash: H(1),
    receipt: null,
    canonicalHashAtBlock: null,
    head: "120",
    transactionKnown: true,
    accountNonce: "7",
    txNonce: "7",
    replacement: null,
    submittedAt: NOW,
    now: NOW + 1000,
  };
  const mined = {
    status: "success" as const,
    blockNumber: "111",
    blockHash: H(111),
  };
  it("X22 receipts: confirmations, revert, reorg, replacement; missing data concludes nothing (F17, F06b)", () => {
    // Pending in the mempool: only a sighting (round 6, U1) — it says nothing about the outcome.
    expect(observeSource(base)).toEqual({
      type: "REOBSERVED",
      at: NOW + 1000,
      role: "main",
      hash: H(1),
    });
    expect(
      observeSource({ ...base, receipt: mined, canonicalHashAtBlock: H(111) }),
    ).toMatchObject({ type: "TX_CONFIRMED", confirmations: 10 });
    expect(
      observeSource({ ...base, receipt: mined, canonicalHashAtBlock: null }),
    ).toBeNull();
    expect(
      observeSource({
        ...base,
        receipt: { ...mined, status: "reverted" },
        canonicalHashAtBlock: H(111),
      })?.type,
    ).toBe("TX_FAILED");
    expect(
      observeSource({ ...base, receipt: mined, canonicalHashAtBlock: H(112) })
        ?.type,
    ).toBe("REORG");
    expect(
      observeSource({ ...base, replacement: { hash: H(2), sameIntent: true } }),
    ).toMatchObject({ type: "TX_REPLACED", replaced: H(1), sameIntent: true });
    expect(
      observeSource({ ...base, transactionKnown: false, accountNonce: "8" }),
    ).toBeNull();
    expect(
      observeSource({
        ...base,
        transactionKnown: false,
        now: NOW + EXECUTION_POLICY.dropAfterMs + 1,
      }),
    ).toMatchObject({ type: "TX_DROPPED" });
    expect(
      observeSource({
        ...base,
        transactionKnown: false,
        accountNonce: null,
        now: NOW + EXECUTION_POLICY.dropAfterMs + 1,
      }),
    ).toBeNull();
  });
  it("X23 bridge and NEAR delivery only with an amount read on chain (F17)", () => {
    expect(
      routeStatusEvent(
        { status: "COMPLETED", authoritative: false, destinationHash: H(3) },
        "5007450",
        NOW,
      ),
    ).toBeNull();
    expect(
      routeStatusEvent(
        { status: "COMPLETED", authoritative: true, destinationHash: H(3) },
        null,
        NOW,
      ),
    ).toMatchObject({ status: "PENDING" });
    expect(
      routeStatusEvent(
        { status: "COMPLETED", authoritative: true, destinationHash: H(3) },
        "5007450",
        NOW,
      ),
    ).toMatchObject({ status: "DELIVERED" });
    const success = {
      status: "SUCCESS",
      swapDetails: {
        amountOut: "999",
        destinationChainTxHashes: [
          { hash: "5Hq3ubqmEJJd2QV6pZQAu3ZKP9ZnsT1bQx1yi3v4VxgF" },
        ],
      },
    };
    expect(nearStatusEvent(success, NOW, null)).toMatchObject({
      status: "PENDING",
    });
    expect(nearStatusEvent(success, NOW, "123")).toMatchObject({
      status: "DELIVERED",
      amount: "123",
    });
    expect(
      nearStatusEvent({ status: "INCOMPLETE_DEPOSIT" }, NOW, null),
    ).toMatchObject({ status: "REFUND_PENDING" });
    expect(nearStatusEvent({ status: "DONE!" }, NOW, null)).toBeNull();
  });
  it("X24 reconciliation uses this intent's own transfer and the native spend; an unrelated deposit cannot mask a short delivery", () => {
    const p = plan();
    const ok = {
      payBefore: "9000000",
      payAfter: "4000000",
      nativeBefore: "1000",
      nativeAfter: "900",
      networkFeePaid: "100",
      txValue: "0",
      deliveredInTransfer: "5007450",
    };
    expect(reconcile(p, ok)).toEqual({
      ok: true,
      detail: "BALANCES_RECONCILED",
    });
    expect(reconcile(p, { ...ok, deliveredInTransfer: "1" }).detail).toBe(
      "DESTINATION_BELOW_MINIMUM",
    );
    expect(reconcile(p, { ...ok, nativeAfter: "800" }).detail).toBe(
      "NATIVE_DELTA_MISMATCH",
    );
    expect(reconcile(p, { ...ok, payAfter: "3999999" }).detail).toBe(
      "SOURCE_DELTA_MISMATCH",
    );
    expect(reconcile(p, { ...ok, payBefore: "x" }).detail).toBe(
      "BALANCE_UNREADABLE",
    );
  });
});

describe("G13-X NEAR Intents: dry vs executable, bound to the reviewed request (F08)", () => {
  const reviewedRequest = {
    dry: true as const,
    swapType: "EXACT_INPUT" as const,
    slippageTolerance: 100,
    originAsset:
      "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    depositType: "ORIGIN_CHAIN" as const,
    destinationAsset: "nep141:wrap.near",
    amount: "5000000",
    refundTo: SELF,
    refundType: "ORIGIN_CHAIN" as const,
    recipient: "synthetic-owner.near",
    recipientType: "DESTINATION_CHAIN" as const,
    deadline: new Date(NOW + 10 * 60_000).toISOString(),
  };
  const G = "7".repeat(64);
  const authN = (review: string, n = 3) =>
    issueAuthorization({
      action: "NEAR_DEPOSIT_ADDRESS",
      review,
      record: RID,
      account: SELF,
      now: NOW,
      quoteExpiresAt: NOW + 60_000,
      nonce: NONCE(n),
      trustedGesture: true,
    });
  const ctx = (over: Record<string, unknown> = {}) => ({
    chain: "base" as const,
    sender: SELF,
    ownerNearAccount: "synthetic-owner.near",
    reviewed: reviewedRequest as unknown,
    guardianDigest: G,
    authorization: authN(nearReviewDigest(reviewedRequest, G)),
    record: RID,
    now: NOW + 1,
    used: new Set<string>(),
    ...over,
  });
  it("X25 the gate is read inside: with it closed (this build) the executable request is refused first", () => {
    expect(nearExecutableProblems(ctx())).toEqual(["EXECUTION_CLOSED"]);
    expect(() => buildNearExecutableRequest(ctx())).toThrow("EXECUTION_CLOSED");
  });
  it("X26 the rules: exact reviewed request, owner recipient, refund = sender, deadline window, record-bound authorization", () => {
    expect(nearRequestRuleProblems(ctx())).toEqual([]);
    expect(
      nearRequestRuleProblems(
        ctx({ reviewed: { ...reviewedRequest, recipient: "attacker.near" } }),
      ),
    ).toEqual(expect.arrayContaining(["RECIPIENT_NOT_OWNER", "WRONG_REVIEW"]));
    expect(
      nearRequestRuleProblems(
        ctx({ reviewed: { ...reviewedRequest, amount: "999999999" } }),
      ),
    ).toContain("WRONG_REVIEW");
    expect(
      nearRequestRuleProblems(
        ctx({
          reviewed: {
            ...reviewedRequest,
            appFees: [{ recipient: "fee.near", fee: 500 }],
          },
        }),
      ),
    ).toEqual(["REQUEST_INVALID"]);
    expect(
      nearRequestRuleProblems(
        ctx({ reviewed: { ...reviewedRequest, refundTo: OTHER } }),
      ),
    ).toContain("REFUND_NOT_SENDER");
    expect(
      nearRequestRuleProblems(
        ctx({
          reviewed: {
            ...reviewedRequest,
            deadline: new Date(NOW + 60_000).toISOString(),
          },
        }),
      ),
    ).toContain("DEADLINE_TOO_SOON");
    expect(
      nearRequestRuleProblems(
        ctx({
          reviewed: {
            ...reviewedRequest,
            deadline: new Date(NOW + 48 * 3600_000).toISOString(),
          },
        }),
      ),
    ).toContain("DEADLINE_TOO_LATE");
    expect(nearRequestRuleProblems(ctx({ authorization: null }))).toContain(
      "AUTHORIZATION_MISSING",
    );
    expect(
      nearRequestRuleProblems(ctx({ used: new Set([NONCE(3)]) })),
    ).toContain("NONCE_REUSED");
    expect(
      nearRequestRuleProblems(ctx({ record: "g13-other-0003" })),
    ).toContain("WRONG_RECORD");
  });
  it("X27 a deposit address on a dry quote, or none on an executable one, is an anomaly", () => {
    expect(nearQuoteKind(true, { quote: {} })).toBe("DRY");
    expect(nearQuoteKind(true, { quote: { depositAddress: "0xabc" } })).toBe(
      "ANOMALY",
    );
    expect(nearQuoteKind(false, { quote: {} })).toBe("ANOMALY");
  });
});

describe("G13-X canonical encoding and the execution gate", () => {
  it("F24 code-point key order, non-finite numbers refused, bigint tagged", () => {
    expect(canonicalJson({ b: 1, B: 2, a: 3 })).toBe('{"B":2,"a":3,"b":1}');
    expect(() => canonicalJson({ x: Number.NaN })).toThrow("NON_FINITE_NUMBER");
    expect(canonicalJson(5n)).not.toBe(canonicalJson("5"));
  });
  it("X28 CLOSED with every reason; environment variables cannot open it", () => {
    const before = executionGateState("8453");
    expect(before).toMatchObject({
      state: "CLOSED",
      open: false,
      platformFeeBps: 0,
    });
    expect(before.reasons).toEqual(
      expect.arrayContaining([
        "G5_GLOBAL_EXECUTION_DISABLED",
        "ROUTING_WRITE_DISABLED",
        "SWAP_EXECUTION_CLOSED",
        "FIREWALL_GLOBAL_KILL",
        "NO_ACTIVE_CONTRACT_ENTRY",
        "WALLET_CHAIN_NOT_TRUSTED",
        "NO_OWNER_APPROVED_CANARY",
      ]),
    );
    const saved = { ...process.env };
    try {
      for (const k of [
        "VEINED_EXECUTION",
        "VEINED_EXECUTION_ENABLED",
        "OTHERBRIDGE_EXECUTION",
        "EXECUTION_GATE",
        "VEINED_CANARY",
        "NEXT_PUBLIC_EXECUTION",
      ])
        process.env[k] = "1";
      expect(executionGateState("8453")).toEqual(before);
    } finally {
      process.env = saved;
    }
    for (const f of [
      "server/gate",
      "model",
      "preflight",
      "lifecycle",
      "binding",
      "near",
      "canonical",
    ])
      expect(readFileSync(`src/execution/${f}.ts`, "utf8"), f).not.toMatch(
        /process\.env|import\.meta\.env|localStorage|document\.cookie/,
      );
  });
  it("X29 no execution module can reach a wallet's signing or sending method (code, not comments)", () => {
    for (const f of [
      "model",
      "binding",
      "canonical",
      "lifecycle",
      "preflight",
      "erc20",
      "lifi-decoder",
      "providers",
      "tracking",
      "near",
      "server/gate",
      "server/review",
      "server/deps",
      "wallet-request",
    ]) {
      const text = readFileSync(`src/execution/${f}.ts`, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      expect(text, f).not.toMatch(
        /eth_sendTransaction|eth_sendRawTransaction|eth_sign|personal_sign|signTypedData|sendCanonicalTransaction|writeContract|privateKey|mnemonic/,
      );
    }
  });
});

describe("G13-X round-2 review fixes (evidence/review-p3-round2/REVIEW.md)", () => {
  it("N1 a NEAR deposit is never 'reviewed' or 'consistent' while no deposit address is bound to the quote", () => {
    const near = plan({
      kind: "NEAR_INTENTS",
      provider: "near-intents",
      destinationChainId: "near",
      receive: {
        chainId: "near",
        address: "nep141:wrap.near",
        symbol: "wNEAR",
        decimals: 24,
        native: false,
      },
      refundTo: SELF,
      approval: null,
      transaction: {
        chainId: "8453",
        from: SELF,
        to: OTHER,
        value: "999000000000000000000",
        data: "0x",
      },
    });
    const r = preflight(
      near,
      facts({
        supportedDestinations: ["near"],
        evidence: {
          pay: ev("8453", USDC_BASE),
          receive: {
            chainId: "near",
            address: "nep141:wrap.near",
            symbol: "wNEAR",
            decimals: 24,
            level: "CANONICAL",
            risk: [],
          },
        },
      }),
    );
    expect(r.checks.find((c) => c.id === "PROVIDER")).toMatchObject({
      status: "UNKNOWN",
      code: "NEAR_DEPOSIT_NOT_VERIFIED",
    });
    expect(r.checks.find((c) => c.id === "AMOUNTS")).toMatchObject({
      status: "UNKNOWN",
      code: "NEAR_DEPOSIT_NOT_VERIFIED",
    });
    expect(r.ready).toBe(false);
  });
  it("N2 the real approval path: after the approval the fresh plan carries no approval, preflight passes it, the record accepts it and asks for SEND", () => {
    const afterApproval = plan({ quoteId: "q-2", approval: null });
    expect(
      check(
        afterApproval,
        facts({
          allowance: "5000000",
          guardian: { level: "CLEAR", digest: "d".repeat(64), quoteId: "q-2" },
        }),
        "APPROVAL",
      ),
    ).toMatchObject({ status: "PASS", code: "NO_APPROVAL_NEEDED" });
    let a = sent(true);
    a = go(a, {
      type: "TX_CONFIRMED",
      at: NOW + 3,
      role: "approval",
      hash: H(1),
      block: "1",
      blockHash: H(1),
      confirmations: 10,
    });
    const q = go(a, {
      type: "QUOTE_READ",
      at: NOW + 4,
      plan: plan({
        quoteId: "q-2",
        quotedAt: NOW + 4,
        expiresAt: NOW + 25004,
        approval: null,
      }),
    });
    const r = go(q, PF(q.planHash!, NOW + 4), {
      type: "GUARDIAN",
      at: NOW + 4,
      plan: q.planHash!,
      level: "CLEAR",
      digest: "b".repeat(64),
      quoteId: "q-2",
    });
    const review = reviewDigest(
      r.planHash!,
      "b".repeat(64),
      PF(r.planHash!, NOW + 4).digest,
    );
    const ready = go(r, { type: "REVIEW_SHOWN", at: NOW + 5, review });
    expect(
      go(ready, {
        type: "OWNER_AUTHORIZED",
        at: NOW + 6,
        authorization: auth(review, "SEND", 2, NOW + 6, SELF, RID, NOW + 25004),
      }).state,
    ).toBe("AWAITING_SIGNATURE");
    // A plan that still asks for an approval the allowance already covers is refused (no unnecessary signature).
    expect(
      check(plan(), facts({ allowance: "5000000" }), "APPROVAL").code,
    ).toBe("APPROVAL_NOT_NEEDED");
  });
  it("N4 malformed event fields are refused, never read as confirmed / ready / valid", () => {
    const s = sent();
    for (const confirmations of [
      Number.NaN,
      -1,
      1.5,
      "abc" as unknown as number,
      undefined as unknown as number,
    ])
      expect(() =>
        go(s, {
          type: "TX_CONFIRMED",
          at: NOW + 3,
          role: "main",
          hash: H(1),
          block: "1",
          blockHash: H(1),
          confirmations,
        }),
      ).toThrow("INVALID_OBSERVATION");
    const q = go(newRecord("g13-test-0010"), {
      type: "QUOTE_READ",
      at: NOW,
      plan: plan(),
    });
    expect(() =>
      go(q, {
        type: "PREFLIGHT",
        at: NOW,
        plan: q.planHash!,
        ready: "false" as unknown as boolean,
        digest: "a".repeat(64),
        failed: [],
        report: PF(q.planHash!, NOW).report,
      }),
    ).toThrow("INVALID_OBSERVATION");
    const { r, review } = reviewed();
    const timeless = {
      action: "APPROVE" as const,
      review,
      record: RID,
      account: SELF,
      nonce: NONCE(5),
    } as unknown as Parameters<typeof authorizationProblem>[0];
    expect(
      () =>
        go(r, {
          type: "OWNER_AUTHORIZED",
          at: NOW + 1,
          authorization: timeless,
        }),
      // G14 (round 7, V2): a hand-made authorization without real timestamps is refused at the event shape check.
    ).toThrow("INVALID_OBSERVATION");
  });
  it("N6 a reorged transaction that is never mined again ends as DROPPED (needs attention) after the window", () => {
    let s = sent();
    s = go(
      s,
      {
        type: "TX_CONFIRMED",
        at: NOW + 3,
        role: "main",
        hash: H(1),
        block: "1",
        blockHash: H(1),
        confirmations: 10,
      },
      { type: "REORG", at: NOW + 4, role: "main", hash: H(1) },
    );
    expect(() =>
      go(s, {
        type: "TX_DROPPED",
        at: NOW + 5,
        role: "main",
        hash: H(1),
        unseenForMs: 1000,
      }),
    ).toThrow("NOT_DROPPED_YET");
    // The window runs from the reorg (round 4, S1): long unseen since submission is not enough right after it.
    expect(() =>
      go(s, {
        type: "TX_DROPPED",
        at: NOW + 5,
        role: "main",
        hash: H(1),
        unseenForMs: EXECUTION_POLICY.dropAfterMs + 1,
      }),
    ).toThrow("NOT_DROPPED_YET");
    const d = go(s, {
      type: "TX_DROPPED",
      at: NOW + 4 + EXECUTION_POLICY.dropAfterMs,
      role: "main",
      hash: H(1),
      unseenForMs: EXECUTION_POLICY.dropAfterMs + 1,
    });
    expect(d.state).toBe("DROPPED");
    expect(labelOf(d.state)).toBe("NEEDS_ATTENTION");
  });
  it("N8 a native-coin bridge must send the native asset (zero address) in the call", () => {
    const ETH = {
      chainId: "8453",
      address: "0x0000000000000000000000000000000000000000",
      symbol: "ETH",
      decimals: 18,
      native: true,
    };
    const native = plan({
      pay: ETH,
      approval: null,
      transaction: { ...call.transaction, value: call.fromAmount },
    });
    expect(
      check(
        native,
        facts({
          evidence: {
            pay: { ...ETH, level: "CANONICAL", risk: [] },
            receive: ev("42161", USDC_ARB),
          },
        }),
        "AMOUNTS",
      ),
    ).toMatchObject({ status: "FAIL", code: "SENDING_ASSET_MISMATCH" });
  });
  it("N10 every head offset must be canonical (aligned, increasing, inside the call)", () => {
    expect(decodeLifiBridgeCall(patchWord(REAL, 1, 0x60n), "8453")).toBeNull();
    expect(decodeLifiBridgeCall(patchWord(REAL, 2, 0x10n), "8453")).toBeNull();
    expect(
      decodeLifiBridgeCall(patchWord(REAL, 2, 0xffffffn), "8453"),
    ).toBeNull();
    expect(decodeLifiBridgeCall(REAL, "8453")).not.toBeNull();
  });
  it("N11 the expected amount and the fee lines the owner is shown are bound by the plan digest", () => {
    expect(planDigest(plan({ expectedOut: "5007451" }))).not.toBe(
      planDigest(plan()),
    );
    expect(
      planDigest(
        plan({
          fees: [{ ...plan().fees[0], amount: "12499" }, plan().fees[1]],
        }),
      ),
    ).not.toBe(planDigest(plan()));
  });
  it("F10 the canonical transaction converts to exactly the hex shape the protected adapter compares", () => {
    const tx = {
      ...call.transaction,
      maxFeePerGas: "1000000000",
      maxPriorityFeePerGas: "1000",
    };
    const req = walletRequest(tx);
    expect(req).toMatchObject({
      chainId: "0x2105",
      value: "0x0",
      gas: "0x" + BigInt(call.transaction.gas).toString(16),
      maxFeePerGas: "0x3b9aca00",
      maxPriorityFeePerGas: "0x3e8",
    });
    expect(compareCanonicalTx(req, { ...req })).toEqual([]);
    expect(compareCanonicalTx(req, { ...req, value: "0x1" })).toEqual([
      "value",
    ]);
    expect(() => walletRequest({ ...tx, value: "0x0" })).toThrow(
      "WALLET_REQUEST_INVALID",
    );
  });
  it("F16 a refund needs the amount read on chain; a bridge's destination hash is never its source hash", () => {
    let m = sent();
    m = go(m, {
      type: "TX_CONFIRMED",
      at: NOW + 3,
      role: "main",
      hash: H(1),
      block: "1",
      blockHash: H(1),
      confirmations: 10,
    });
    expect(() =>
      go(m, { type: "DESTINATION", at: NOW + 4, status: "REFUNDED" }),
    ).toThrow("REFUND_AMOUNT_REQUIRED");
    expect(() =>
      go(m, {
        type: "DESTINATION",
        at: NOW + 4,
        status: "DELIVERED",
        hash: H(1),
        amount: "5007450",
      }),
    ).toThrow("DESTINATION_HASH_IS_SOURCE");
  });
  it("F17 a native-coin transfer with a disclosed native fee reconciles", () => {
    const p = plan({
      pay: {
        chainId: "8453",
        address: "0x0000000000000000000000000000000000000000",
        symbol: "ETH",
        decimals: 18,
        native: true,
      },
      spender: null,
      approval: null,
      // The reviewed transaction carried amount + the disclosed native fee (round 3, R3: reconcile compares it).
      transaction: { ...call.transaction, value: "995010" },
    });
    const ok = {
      payBefore: "1000000",
      payAfter: "4890",
      nativeBefore: "1000000",
      nativeAfter: "4890",
      networkFeePaid: "100",
      txValue: "995010",
      deliveredInTransfer: "5007450",
    };
    expect(reconcile({ ...p, amountIn: "995000" }, ok)).toEqual({
      ok: true,
      detail: "BALANCES_RECONCILED",
    });
    expect(reconcile({ ...p, amountIn: "995011" }, ok).detail).toBe(
      "SOURCE_DELTA_MISMATCH",
    );
  });
});

describe("G13-X round-3 hardening (round-2 residuals F07, F09, F10)", () => {
  const rehash = (entries: AuditEntry[]) => {
    let prev = "0".repeat(64);
    return entries.map((a, seq) => {
      const e = { ...a, seq, prev };
      e.hash = digest({
        seq,
        at: e.at,
        type: e.type,
        state: e.state,
        event: e.event,
        prev,
        id: RID,
      });
      prev = e.hash;
      return e;
    });
  };
  it("F07 a re-hashed chain whose time runs backwards, or whose entry time is not its event time, is refused", () => {
    const { r } = reviewed();
    expect(verifyAudit(r.id, rehash(r.audit))).toEqual({ ok: true });
    const back = rehash(
      r.audit.map((a, i) =>
        i === 2
          ? {
              ...a,
              at: r.audit[1].at - 1,
              event: { ...a.event, at: r.audit[1].at - 1 },
            }
          : a,
      ),
    );
    expect(verifyAudit(r.id, back)).toEqual({ ok: false, at: 2 });
    const split = rehash(
      r.audit.map((a, i) => (i === 1 ? { ...a, at: a.at + 1 } : a)),
    );
    expect(verifyAudit(r.id, split)).toEqual({ ok: false, at: 1 });
  });
  it("F09 a non-canonical amount is refused as a FAIL, never thrown on", () => {
    expect(check(plan({ amountIn: "5e6" }), facts(), "APPROVAL")).toMatchObject(
      { status: "FAIL", code: "PLAN_INVALID" },
    );
    expect(
      approvalProblem({ ...plan(), amountIn: "5e6" }, 0n, () => true),
    ).toBe("AMOUNT_INVALID");
    expect(() =>
      approvalTransaction({
        ...plan(),
        amountIn: "5e6",
        approval: { token: USDC_BASE, spender: DIAMOND, amount: "5e6" },
      }),
    ).toThrow("APPROVAL_NOT_EXACT");
    expect(() => preflight(plan({ amountIn: "5e6" }), facts())).not.toThrow();
    expect(preflight(plan({ amountIn: "5e6" }), facts()).ready).toBe(false);
  });
  it("F10 a priority fee above the fee cap fails the gas check", () => {
    const tx = {
      ...call.transaction,
      maxFeePerGas: "1000",
      maxPriorityFeePerGas: "1001",
    };
    expect(check(plan({ transaction: tx }), facts(), "GAS")).toMatchObject({
      status: "FAIL",
      code: "PRIORITY_FEE_ABOVE_CAP",
    });
    const noCap = { ...call.transaction, maxPriorityFeePerGas: "1" };
    expect(check(plan({ transaction: noCap }), facts(), "GAS")).toMatchObject({
      status: "FAIL",
      code: "PRIORITY_FEE_ABOVE_CAP",
    });
  });
});

describe("G13-X round-3 review fixes (evidence/review-p3-round3/REVIEW.md)", () => {
  const word2 = (data: string) =>
    BigInt("0x" + data.slice(10 + 2 * 64, 10 + 3 * 64));
  const ETH = {
    chainId: "8453",
    address: "0x0000000000000000000000000000000000000000",
    symbol: "ETH",
    decimals: 18,
    native: true,
  };
  const confirmed = (r: ExecutionRecord, role: "approval" | "main") =>
    go(r, {
      type: "TX_CONFIRMED",
      at: NOW + 3,
      role,
      hash: H(1),
      block: "1",
      blockHash: H(1),
      confirmations: 10,
    });
  it("R1 a token payment pins its spender and must leave no allowance behind, with or without an approval in the plan", () => {
    const noApproval = plan({ approval: null });
    expect(
      check(
        noApproval,
        facts({ allowance: MAX_UINT256.toString() }),
        "APPROVAL",
      ),
    ).toMatchObject({ status: "FAIL", code: "ALLOWANCE_ABOVE_AMOUNT" });
    expect(
      check(noApproval, facts({ allowance: "5000001" }), "APPROVAL"),
    ).toMatchObject({ status: "FAIL", code: "ALLOWANCE_ABOVE_AMOUNT" });
    expect(
      check(noApproval, facts({ allowance: "5000000" }), "APPROVAL"),
    ).toMatchObject({ status: "PASS", code: "NO_APPROVAL_NEEDED" });
    const sim = (allowanceAfter: string | null) =>
      facts({
        allowance: "5000000",
        simulation: { ...facts().simulation!, allowanceAfter },
      });
    expect(check(noApproval, sim(null), "SIMULATION")).toMatchObject({
      status: "UNKNOWN",
      code: "ALLOWANCE_AFTER_UNKNOWN",
    });
    expect(
      check(noApproval, sim(MAX_UINT256.toString()), "SIMULATION"),
    ).toMatchObject({ status: "FAIL", code: "RESIDUAL_ALLOWANCE" });
    expect(check(noApproval, sim("0"), "SIMULATION")).toMatchObject({
      status: "PASS",
    });
    expect(
      check(plan({ approval: null, spender: null }), facts(), "PROVIDER"),
    ).toMatchObject({ status: "FAIL", code: "SPENDER_MISSING" });
    expect(
      check(plan({ approval: null, spender: OTHER }), facts(), "PROVIDER"),
    ).toMatchObject({ status: "FAIL", code: "UNEXPECTED_SPENDER" });
    expect(check(plan({ spender: OTHER }), facts(), "PROVIDER")).toMatchObject({
      status: "FAIL",
      code: "UNEXPECTED_SPENDER",
    });
    expect(
      check(
        plan({
          pay: ETH,
          approval: null,
          spender: DIAMOND,
          transaction: { ...call.transaction, value: call.fromAmount },
        }),
        facts(),
        "PROVIDER",
      ),
    ).toMatchObject({ status: "FAIL", code: "SPENDER_ON_NATIVE" });
    expect(planDigest(plan({ spender: OTHER }))).not.toBe(planDigest(plan()));
    // After the approval, the fresh plan must be pulled by exactly the approved spender.
    const a = confirmed(sent(true), "approval");
    expect(a.state).toBe("APPROVAL_CONFIRMED");
    const fresh = {
      quoteId: "q-2",
      quotedAt: NOW + 4,
      expiresAt: NOW + 25004,
      approval: null,
    };
    expect(() =>
      go(a, {
        type: "QUOTE_READ",
        at: NOW + 4,
        plan: plan({ ...fresh, spender: OTHER }),
      }),
    ).toThrow("PLAN_IDENTITY_CHANGED");
    expect(
      go(a, { type: "QUOTE_READ", at: NOW + 4, plan: plan(fresh) }).state,
    ).toBe("QUOTED");
  });
  it("R9 after an approval the fresh quote may not ask for an approval again", () => {
    const a = confirmed(sent(true), "approval");
    expect(() =>
      go(a, {
        type: "QUOTE_READ",
        at: NOW + 4,
        plan: plan({
          quoteId: "q-2",
          quotedAt: NOW + 4,
          expiresAt: NOW + 25004,
        }),
      }),
    ).toThrow("PLAN_IDENTITY_CHANGED");
  });
  it("R2 a provider REFUNDED is recorded only with the refund read on chain; until then it is REFUND_PENDING (needs attention)", () => {
    const m = go(confirmed(sent(), "main"), {
      type: "DESTINATION",
      at: NOW + 4,
      status: "PENDING",
    });
    expect(m.state).toBe("DESTINATION_PENDING");
    const pending = go(
      m,
      routeStatusEvent(
        { status: "REFUNDED", authoritative: true },
        null,
        NOW + 5,
      )!,
    );
    expect(pending.state).toBe("REFUND_PENDING");
    expect(labelOf(pending.state)).toBe("NEEDS_ATTENTION");
    const still = go(
      pending,
      nearStatusEvent({ status: "REFUNDED" }, NOW + 6, null)!,
    );
    expect(still.state).toBe("REFUND_PENDING");
    const done = go(
      still,
      routeStatusEvent(
        { status: "REFUNDED", authoritative: true },
        null,
        NOW + 7,
        "4990000",
      )!,
    );
    expect(done.state).toBe("REFUNDED");
    expect(done.delivered).toBe("4990000");
    expect(labelOf(done.state)).toBe("NEEDS_ATTENTION");
    expect(
      go(m, nearStatusEvent({ status: "REFUNDED" }, NOW + 5, null, "4990000")!)
        .state,
    ).toBe("REFUNDED");
    expect(
      routeStatusEvent(
        { status: "REFUNDED", authoritative: true },
        null,
        NOW,
        "1e6",
      ),
    ).toMatchObject({ status: "REFUND_PENDING" });
  });
  it("R3 reconciliation requires exactly the reviewed transaction value", () => {
    const p = plan();
    const ok = {
      payBefore: "9000000",
      payAfter: "4000000",
      nativeBefore: "1000",
      nativeAfter: "900",
      networkFeePaid: "100",
      txValue: "0",
      deliveredInTransfer: "5007450",
    };
    expect(reconcile(p, ok)).toEqual({
      ok: true,
      detail: "BALANCES_RECONCILED",
    });
    expect(
      reconcile(p, {
        ...ok,
        txValue: "1000000000000000000",
        nativeBefore: "1000000000000001000",
      }).detail,
    ).toBe("TRANSACTION_VALUE_MISMATCH");
    const native = plan({
      pay: ETH,
      spender: null,
      approval: null,
      amountIn: "1000",
      transaction: { ...call.transaction, value: "1000" },
    });
    const n = {
      payBefore: "1000000000000000000000000",
      payAfter: "1",
      nativeBefore: "0",
      nativeAfter: "0",
      networkFeePaid: "7",
      txValue: "1000000000000000000000",
      deliveredInTransfer: "5007450",
    };
    n.payAfter = (BigInt(n.payBefore) - BigInt(n.txValue) - 7n).toString();
    expect(reconcile(native, n).detail).toBe("TRANSACTION_VALUE_MISMATCH");
    expect(reconcile({ ...p, transaction: null }, ok).detail).toBe(
      "NO_REVIEWED_TRANSACTION",
    );
    expect(reconcile({ ...p, amountIn: "5e6" }, ok).detail).toBe(
      "PLAN_INVALID",
    );
  });
  it("N6 a reorged transaction whose nonce another transaction took ends as REPLACED; a same-intent re-mine is tracked again", () => {
    const s = go(confirmed(sent(), "main"), {
      type: "REORG",
      at: NOW + 4,
      role: "main",
      hash: H(1),
    });
    expect(s.state).toBe("REORGED");
    const taken = observeSource({
      role: "main",
      hash: H(1),
      receipt: null,
      canonicalHashAtBlock: null,
      head: "10",
      transactionKnown: false,
      accountNonce: "8",
      txNonce: "7",
      replacement: { hash: H(9), sameIntent: false },
      submittedAt: NOW,
      now: NOW + 5,
    })!;
    const other = go(s, taken);
    expect(other.state).toBe("REPLACED");
    expect(labelOf(other.state)).toBe("NEEDS_ATTENTION");
    const speed = go(s, {
      type: "TX_REPLACED",
      at: NOW + 5,
      role: "main",
      replaced: H(1),
      hash: H(8),
      sameIntent: true,
    });
    expect(speed.state).toBe("SUBMITTED");
    expect(speed.hashes.main).toBe(H(8));
    expect(() =>
      go(s, {
        type: "TX_REPLACED",
        at: NOW + 5,
        role: "main",
        replaced: H(7),
        hash: H(8),
        sameIntent: true,
      }),
    ).toThrow("REPLACEMENT_NOT_EXPECTED");
  });
  it("R7 a malformed plan is refused at QUOTE_READ and as a whole by preflight (never thrown on)", () => {
    for (const bad of [
      plan({ minimumOut: "1e3" }),
      plan({ slippageBps: Number.NaN }),
      plan({ expiresAt: Number.NaN }),
      plan({ amountIn: " 5000000" }),
      plan({ fees: [{ ...plan().fees[0], amount: "1.5" }] }),
    ]) {
      expect(() =>
        go(newRecord("g13-test-0099"), {
          type: "QUOTE_READ",
          at: NOW,
          plan: bad,
        }),
      ).toThrow("PLAN_INVALID");
      const r = preflight(bad, facts());
      expect(r.ready).toBe(false);
      expect(r.checks.length).toBe(13);
      expect(
        r.checks.every((c) => c.status === "FAIL" && c.code === "PLAN_INVALID"),
      ).toBe(true);
    }
  });
  it("N10 the first two arguments must be byte-exact canonical encodings at canonical offsets", () => {
    const appendedEmptyArray = REAL + "0".repeat(64);
    const relocated = patchWord(
      appendedEmptyArray,
      1,
      BigInt((REAL.length - 10) / 2),
    );
    expect(decodeLifiBridgeCall(relocated, "8453")).toBeNull();
    expect(decodeLifiBridgeCall(appendedEmptyArray, "8453")).not.toBeNull(); // facet-data length is not proven (stated)
    expect(
      decodeLifiBridgeCall(patchWord(REAL, 2, word2(REAL) + 32n), "8453"),
    ).toBeNull();
    expect(decodeLifiBridgeCall(REAL, "8453")).not.toBeNull();
  });
  it("N11 / R8 symbols, the quote time and the fee asset details are bound by the plan digest (v3)", () => {
    const base = planDigest(plan());
    expect(
      planDigest(plan({ pay: { ...plan().pay, symbol: "USDT" } })),
    ).not.toBe(base);
    expect(
      planDigest(plan({ receive: { ...plan().receive, symbol: "USDT" } })),
    ).not.toBe(base);
    expect(planDigest(plan({ quotedAt: NOW - 999 }))).not.toBe(base);
    const f = plan().fees;
    expect(
      planDigest(
        plan({
          fees: [{ ...f[0], asset: { ...f[0].asset, decimals: 18 } }, f[1]],
        }),
      ),
    ).not.toBe(base);
    expect(EXECUTION_POLICY.version).toBe("x1.2026-11.2");
  });
});

describe("G13-X round-4 review fixes (evidence/review-p3-round4/REVIEW.md)", () => {
  const MIN = 60_000;
  const obs = (over: Partial<Parameters<typeof observeSource>[0]>) =>
    observeSource({
      role: "main",
      hash: H(1),
      receipt: { status: "success", blockNumber: "105", blockHash: H(105) },
      canonicalHashAtBlock: H(105),
      head: "106",
      transactionKnown: true,
      accountNonce: "8",
      txNonce: "7",
      replacement: null,
      submittedAt: NOW,
      now: NOW + 10,
      ...over,
    })!;
  const confirmedAt100 = () =>
    go(sent(), {
      type: "TX_CONFIRMED",
      at: NOW + 3,
      role: "main",
      hash: H(1),
      block: "100",
      blockHash: H(100),
      confirmations: 10,
    });
  it("S1 a reorged transaction re-mined under the SAME hash is followed again through the real tracker: shallow, deep or reverted", () => {
    const s = confirmedAt100();
    expect(s.state).toBe("SOURCE_CONFIRMED");
    expect(s.sourceBlock).toEqual({ number: "100", hash: H(100) });
    // The same block observed again changes nothing.
    expect(
      go(s, {
        type: "TX_CONFIRMED",
        at: NOW + 4,
        role: "main",
        hash: H(1),
        block: "100",
        blockHash: H(100),
        confirmations: 12,
      }).state,
    ).toBe("SOURCE_CONFIRMED");
    // A fresh receipt in ANOTHER block, read against the recorded block: the tracker reports the reorg.
    const reorg = obs({ confirmedBlockHash: H(100) });
    expect(reorg).toMatchObject({ type: "REORG", hash: H(1) });
    const r = go(s, reorg);
    expect(r.state).toBe("REORGED");
    expect(r.reorgedAt).toBe(NOW + 10);
    // Re-mined, 2 confirmations: tracked as SUBMITTED again; 10 confirmations: SOURCE_CONFIRMED in the new block.
    const shallow = go(r, obs({ now: NOW + 11 }));
    expect(shallow.state).toBe("SUBMITTED");
    const deep = go(shallow, obs({ head: "114", now: NOW + 12 }));
    expect(deep.state).toBe("SOURCE_CONFIRMED");
    expect(deep.sourceBlock).toEqual({ number: "105", hash: H(105) });
    expect(go(r, obs({ head: "114", now: NOW + 11 })).state).toBe(
      "SOURCE_CONFIRMED",
    );
    // Re-mined and reverted this time: SOURCE_FAILED.
    const failed = obs({
      receipt: { status: "reverted", blockNumber: "105", blockHash: H(105) },
      now: NOW + 11,
    });
    expect(go(r, failed).state).toBe("SOURCE_FAILED");
    // A receipt that vanished after confirmation is a reorg too.
    expect(
      obs({
        receipt: null,
        canonicalHashAtBlock: null,
        confirmedBlockHash: H(100),
      }),
    ).toMatchObject({ type: "REORG" });
    // Directly: a different block while confirmed -> REORGED; another hash is refused.
    expect(
      go(s, {
        type: "TX_CONFIRMED",
        at: NOW + 4,
        role: "main",
        hash: H(1),
        block: "101",
        blockHash: H(101),
        confirmations: 10,
      }).state,
    ).toBe("REORGED");
    expect(() =>
      go(s, {
        type: "TX_CONFIRMED",
        at: NOW + 4,
        role: "main",
        hash: H(9),
        block: "101",
        blockHash: H(101),
        confirmations: 10,
      }),
    ).toThrow("CONFIRMATION_NOT_EXPECTED");
    expect(() =>
      go(s, {
        type: "TX_CONFIRMED",
        at: NOW + 4,
        role: "main",
        hash: H(1),
        block: "101",
        blockHash: "nope",
        confirmations: 10,
      }),
    ).toThrow("INVALID_OBSERVATION");
  });
  it("S1 after a reorg the drop window runs from the reorg, not from the submission", () => {
    const at = NOW + 40 * MIN;
    const r = go(confirmedAt100(), {
      type: "REORG",
      at,
      role: "main",
      hash: H(1),
    });
    const gone = {
      receipt: null,
      canonicalHashAtBlock: null,
      transactionKnown: false,
      accountNonce: "7",
      txNonce: "7",
    };
    // 5 s after the reorg (40 min after the submission): no conclusion from the tracker, and the record refuses one.
    expect(obs({ ...gone, since: at, now: at + 5000 })).toBeNull();
    expect(() =>
      go(r, {
        type: "TX_DROPPED",
        at: at + 5000,
        role: "main",
        hash: H(1),
        unseenForMs: 40 * MIN,
      }),
    ).toThrow("NOT_DROPPED_YET");
    // A full window after the reorg: DROPPED (needs attention).
    const late = obs({
      ...gone,
      since: at,
      now: at + EXECUTION_POLICY.dropAfterMs + 1000,
    });
    expect(late).toMatchObject({ type: "TX_DROPPED" });
    const d = go(r, late);
    expect(d.state).toBe("DROPPED");
    expect(labelOf(d.state)).toBe("NEEDS_ATTENTION");
  });
  it("S2 a refund of nothing is not a refund; an incomplete deposit that later completes is followed to delivery", () => {
    const m = go(confirmedAt100(), {
      type: "DESTINATION",
      at: NOW + 4,
      status: "PENDING",
    });
    expect(
      routeStatusEvent(
        { status: "REFUNDED", authoritative: true },
        null,
        NOW + 5,
        "0",
      ),
    ).toMatchObject({ status: "REFUND_PENDING" });
    expect(() =>
      go(m, {
        type: "DESTINATION",
        at: NOW + 5,
        status: "REFUNDED",
        amount: "0",
      }),
    ).toThrow("REFUND_AMOUNT_REQUIRED");
    const incomplete = go(
      m,
      nearStatusEvent({ status: "INCOMPLETE_DEPOSIT" }, NOW + 5, null)!,
    );
    expect(incomplete.state).toBe("REFUND_PENDING");
    expect(
      go(incomplete, nearStatusEvent({ status: "PROCESSING" }, NOW + 6, null)!)
        .state,
    ).toBe("DESTINATION_PENDING");
    const success = {
      status: "SUCCESS",
      swapDetails: { destinationChainTxHashes: [{ hash: H(50) }] },
    };
    expect(
      go(incomplete, nearStatusEvent(success, NOW + 6, "5007450")!).state,
    ).toBe("SETTLED");
  });
  it("S3 an allowance read for another spender proves nothing", () => {
    const noApproval = plan({ approval: null });
    expect(
      check(noApproval, facts({ allowance: "5000000" }), "APPROVAL"),
    ).toMatchObject({ status: "PASS", code: "NO_APPROVAL_NEEDED" });
    expect(
      check(
        noApproval,
        facts({ allowance: "5000000", allowanceSpender: OTHER }),
        "APPROVAL",
      ),
    ).toMatchObject({ status: "UNKNOWN", code: "ALLOWANCE_UNKNOWN" });
    expect(
      check(
        noApproval,
        facts({ allowance: "5000000", allowanceSpender: null }),
        "SIMULATION",
      ),
    ).toMatchObject({ status: "UNKNOWN", code: "ALLOWANCE_AFTER_UNKNOWN" });
  });
  it("S4 structurally malformed plans and facts are refused with a code, never thrown on", () => {
    const broken = { ...plan(), pay: null } as unknown as ExecutionPlan;
    expect(approvalProblem(broken, 0n, () => true)).toBe("PLAN_INVALID");
    expect(
      approvalProblem(
        { ...plan(), approval: { token: 5 } } as unknown as ExecutionPlan,
        0n,
        () => true,
      ),
    ).toBe("PLAN_INVALID");
    expect(() =>
      approvalTransaction({
        ...plan(),
        approval: { token: 5 },
      } as unknown as ExecutionPlan),
    ).toThrow("APPROVAL_NOT_EXACT");
    const ok = {
      payBefore: "9000000",
      payAfter: "4000000",
      nativeBefore: "1000",
      nativeAfter: "900",
      networkFeePaid: "100",
      txValue: "0",
      deliveredInTransfer: "5007450",
    };
    expect(reconcile(broken, ok).detail).toBe("PLAN_INVALID");
    for (const bad of [
      { ...facts(), now: Number.NaN },
      { ...facts(), wallet: undefined },
      { ...facts(), supportedDestinations: undefined },
      undefined,
    ]) {
      const r = preflight(plan(), bad as unknown as PreflightFacts);
      expect(r.ready).toBe(false);
      expect(
        r.checks.every(
          (c) => c.status === "FAIL" && c.code === "FACTS_INVALID",
        ),
      ).toBe(true);
    }
  });
});

describe("G13-X round-5 review fixes (evidence/review-p3-round5/REVIEW.md)", () => {
  const MIN = 60_000;
  const obs = (over: Partial<Parameters<typeof observeSource>[0]>) =>
    observeSource({
      role: "main",
      hash: H(1),
      receipt: { status: "success", blockNumber: "130", blockHash: H(130) },
      canonicalHashAtBlock: H(130),
      head: "131",
      transactionKnown: true,
      accountNonce: "8",
      txNonce: "7",
      replacement: null,
      submittedAt: NOW,
      now: NOW + 10,
      ...over,
    });
  const confirmed = () =>
    go(sent(), {
      type: "TX_CONFIRMED",
      at: NOW + 3,
      role: "main",
      hash: H(1),
      block: "100",
      blockHash: H(100),
      confirmations: 21,
    });
  const gone = {
    receipt: null,
    canonicalHashAtBlock: null,
    transactionKnown: false,
    accountNonce: "7",
    txNonce: "7",
  };
  it("T1 reorg -> shallow re-mine -> gone again: DROPPED only a full window after the record last saw it", () => {
    const at = NOW + 40 * MIN;
    const r = go(
      confirmed(),
      obs({
        ...gone,
        transactionKnown: true,
        accountNonce: "8",
        confirmedBlockHash: H(100),
        now: at,
      })!,
    );
    expect(r.state).toBe("REORGED");
    expect(r.lastSeenAt).toBe(at);
    const shallow = go(r, obs({ now: at + 5000 })!);
    expect(shallow.state).toBe("SUBMITTED");
    expect(shallow.reorgedAt).toBe(at); // the reorg anchor survives a shallow re-mine
    expect(shallow.lastSeenAt).toBe(at + 5000);
    // Gone again 12 s later: the tracker, given the record's last sighting, concludes nothing; the record refuses a drop.
    expect(
      obs({ ...gone, since: shallow.lastSeenAt!, now: at + 17000 }),
    ).toBeNull();
    expect(() =>
      go(shallow, {
        type: "TX_DROPPED",
        at: at + 17000,
        role: "main",
        hash: H(1),
        unseenForMs: 40 * MIN,
      }),
    ).toThrow("NOT_DROPPED_YET");
    const late = obs({
      ...gone,
      since: shallow.lastSeenAt!,
      now: at + 5000 + EXECUTION_POLICY.dropAfterMs + 1000,
    })!;
    expect(late).toMatchObject({ type: "TX_DROPPED" });
    expect(go(shallow, late).state).toBe("DROPPED");
    // Deep re-confirmation clears the anchor.
    const deep = go(shallow, obs({ head: "160", now: at + 6000 })!);
    expect(deep.state).toBe("SOURCE_CONFIRMED");
    expect(deep.reorgedAt).toBeNull();
  });
  it("T2 the confirming block is forgotten on a reorg; a pending refund can see the reorg; a repeated approval read is a no-op", () => {
    const r = go(confirmed(), {
      type: "REORG",
      at: NOW + 4,
      role: "main",
      hash: H(1),
    });
    expect(r.sourceBlock).toBeNull();
    // A caller passing the record's (now empty) confirmed block hash does not wedge: the new receipt confirms.
    expect(
      go(
        r,
        obs({ confirmedBlockHash: r.sourceBlock?.hash ?? null, now: NOW + 5 })!,
      ).state,
    ).toBe("SUBMITTED");
    const refund = go(
      confirmed(),
      nearStatusEvent({ status: "INCOMPLETE_DEPOSIT" }, NOW + 4, null)!,
    );
    expect(refund.state).toBe("REFUND_PENDING");
    expect(
      go(
        refund,
        obs({
          ...gone,
          transactionKnown: true,
          accountNonce: "8",
          confirmedBlockHash: H(100),
          now: NOW + 5,
        })!,
      ).state,
    ).toBe("REORGED");
    const approved = go(sent(true), {
      type: "TX_CONFIRMED",
      at: NOW + 3,
      role: "approval",
      hash: H(1),
      block: "1",
      blockHash: H(1),
      confirmations: 10,
    });
    expect(approved.state).toBe("APPROVAL_CONFIRMED");
    expect(
      go(approved, {
        type: "TX_CONFIRMED",
        at: NOW + 4,
        role: "approval",
        hash: H(1),
        block: "1",
        blockHash: H(1),
        confirmations: 11,
      }).state,
    ).toBe("APPROVAL_CONFIRMED");
  });
  it("T3 only a delivery report can reach SETTLED: an unknown or missing destination status is refused", () => {
    const m = confirmed();
    for (const status of ["COMPLETED", undefined, "settled"])
      expect(() =>
        go(m, {
          type: "DESTINATION",
          at: NOW + 4,
          status,
          amount: "5007450",
          hash: H(50),
        } as unknown as ExecutionEvent),
      ).toThrow("INVALID_OBSERVATION");
  });
  it("T4 malformed events, observations, balances and facts are refused with a code, never thrown on", () => {
    const m = confirmed();
    const bad = (e: Record<string, unknown>) => () =>
      go(m, e as unknown as ExecutionEvent);
    expect(
      bad({
        type: "TX_CONFIRMED",
        at: NOW + 4,
        role: "x",
        hash: H(1),
        block: "1",
        blockHash: H(1),
        confirmations: 10,
      }),
    ).toThrow("INVALID_OBSERVATION");
    expect(
      bad({
        type: "TX_CONFIRMED",
        at: NOW + 4,
        role: "main",
        hash: 7,
        block: "1",
        blockHash: H(1),
        confirmations: 10,
      }),
    ).toThrow("INVALID_OBSERVATION");
    expect(
      bad({
        type: "TX_CONFIRMED",
        at: NOW + 4,
        role: "main",
        hash: H(1),
        block: "1",
        blockHash: [H(1)],
        confirmations: 10,
      }),
    ).toThrow("INVALID_OBSERVATION");
    expect(bad({ type: "NOPE", at: NOW + 4 })).toThrow("UNKNOWN_EVENT");
    expect(bad({ at: NOW + 4 })).toThrow("UNKNOWN_EVENT");
    expect(() => apply(m, null as unknown as ExecutionEvent)).toThrow(
      "INVALID_OBSERVATION",
    );
    expect(
      obs({
        receipt: { status: "success", blockNumber: "130" } as never,
        confirmedBlockHash: H(100),
      }),
    ).toBeNull();
    expect(obs({ hash: 5 as unknown as string })).toBeNull();
    expect(reconcile(plan(), null as never).detail).toBe("BALANCE_UNREADABLE");
    expect(() => approvalTransaction(null as never)).toThrow(
      "APPROVAL_NOT_EXACT",
    );
    const f = facts();
    const r = preflight(plan(), {
      ...f,
      evidence: {
        ...f.evidence,
        pay: { ...f.evidence.pay!, address: [USDC_BASE] as unknown as string },
      },
    });
    expect(r.checks.every((c) => c.code === "FACTS_INVALID")).toBe(true);
  });
});

describe("G13-X round-6 review fixes (evidence/review-p3-round6/REVIEW.md)", () => {
  const MIN = 60_000;
  const W = EXECUTION_POLICY.dropAfterMs;
  const obs = (over: Partial<Parameters<typeof observeSource>[0]>) =>
    observeSource({
      role: "main",
      hash: H(1),
      receipt: null,
      canonicalHashAtBlock: null,
      head: "600",
      transactionKnown: true,
      accountNonce: "7",
      txNonce: "7",
      replacement: null,
      submittedAt: NOW,
      now: NOW + 10,
      ...over,
    });
  it("U1 a long-pending transaction seen in the mempool is not DROPPED on the first poll that misses it", () => {
    let r = sent(); // main submitted at NOW + 2
    for (let m = 1; m <= 31; m += 5) {
      const sighting = obs({ since: r.lastSeenAt!, now: NOW + m * MIN })!;
      expect(sighting).toMatchObject({ type: "REOBSERVED", role: "main" });
      r = go(r, sighting);
      expect(r.state).toBe("SUBMITTED");
    }
    expect(r.lastSeenAt).toBe(NOW + 31 * MIN);
    const missed = {
      transactionKnown: false,
      since: r.lastSeenAt!,
      now: NOW + 31 * MIN + 5000,
    };
    expect(obs(missed)).toBeNull(); // the tracker, given the record's anchor, concludes nothing
    expect(() =>
      go(r, {
        type: "TX_DROPPED",
        at: NOW + 31 * MIN + 5000,
        role: "main",
        hash: H(1),
        unseenForMs: 31 * MIN,
      }),
    ).toThrow("NOT_DROPPED_YET");
    // Mined a minute later: still followed.
    const mined = obs({
      receipt: { status: "success", blockNumber: "580", blockHash: H(580) },
      canonicalHashAtBlock: H(580),
      now: NOW + 32 * MIN,
    })!;
    expect(go(r, mined).state).toBe("SOURCE_CONFIRMED");
    // A REOBSERVED for a hash the record does not track is refused.
    expect(() =>
      go(r, {
        type: "REOBSERVED",
        at: NOW + 32 * MIN,
        role: "main",
        hash: H(9),
      }),
    ).toThrow("REOBSERVE_NOT_EXPECTED");
  });
  it("U2 the approval transaction has its own last-seen anchor", () => {
    const submitted = sent(true); // approval submitted at NOW + 2
    expect(submitted.approvalSeenAt).toBe(NOW + 2);
    expect(() =>
      go(submitted, {
        type: "TX_DROPPED",
        at: NOW + 3,
        role: "approval",
        hash: H(1),
        unseenForMs: W,
      }),
    ).toThrow("NOT_DROPPED_YET");
    const confirmed = go(submitted, {
      type: "TX_CONFIRMED",
      at: NOW + 3,
      role: "approval",
      hash: H(1),
      block: "1",
      blockHash: H(1),
      confirmations: 10,
    });
    const reorged = go(confirmed, {
      type: "REORG",
      at: NOW + 40 * MIN,
      role: "approval",
      hash: H(1),
    });
    expect(reorged.state).toBe("APPROVAL_SUBMITTED");
    expect(reorged.approvalSeenAt).toBe(NOW + 40 * MIN);
    const gone = obs({
      role: "approval",
      transactionKnown: false,
      since: reorged.approvalSeenAt!,
      now: NOW + 40 * MIN + 5000,
    });
    expect(gone).toBeNull();
    expect(() =>
      go(reorged, {
        type: "TX_DROPPED",
        at: NOW + 40 * MIN + 5000,
        role: "approval",
        hash: H(1),
        unseenForMs: 40 * MIN,
      }),
    ).toThrow("NOT_DROPPED_YET");
    const late = obs({
      role: "approval",
      transactionKnown: false,
      since: reorged.approvalSeenAt!,
      now: NOW + 40 * MIN + W + 1000,
    })!;
    expect(go(reorged, late).state).toBe("DROPPED");
  });
  it("U3 malformed reads and events are refused with a code, never thrown on", () => {
    expect(observeSource(null as never)).toBeNull();
    expect(
      obs({
        receipt: { status: "success", blockNumber: "1", blockHash: H(1) },
        canonicalHashAtBlock: 7 as never,
      }),
    ).toBeNull();
    expect(obs({ head: 5n as never })).toBeNull();
    expect(obs({ now: Number.NaN })).toBeNull();
    const s = sent();
    const bad = (e: Record<string, unknown>) => () =>
      go(s, e as unknown as ExecutionEvent);
    expect(
      bad({
        type: "TX_CONFIRMED",
        at: NOW + 3,
        hash: H(1),
        block: "1",
        blockHash: H(1),
        confirmations: 10,
      }),
    ).toThrow("INVALID_OBSERVATION");
    expect(
      bad({
        type: "TX_DROPPED",
        at: NOW + 3,
        role: "main",
        hash: H(1),
        unseenForMs: Number.NaN,
      }),
    ).toThrow("INVALID_OBSERVATION");
    const { r } = reviewed();
    expect(() =>
      go(r, {
        type: "OWNER_AUTHORIZED",
        at: NOW + 1,
        authorization: null,
      } as unknown as ExecutionEvent),
    ).toThrow("INVALID_OBSERVATION");
    expect(() =>
      go(r, {
        type: "BLOCK",
        at: NOW + 1,
        reason: Number.NaN,
      } as unknown as ExecutionEvent),
    ).toThrow("INVALID_OBSERVATION");
  });
  it("U4 strict booleans on the completed and same-intent edges; a raw receipt status is not read as success", () => {
    const s = sent();
    expect(() =>
      go(s, {
        type: "TX_REPLACED",
        at: NOW + 3,
        role: "main",
        replaced: H(1),
        hash: H(2),
        sameIntent: "false",
      } as unknown as ExecutionEvent),
    ).toThrow("INVALID_OBSERVATION");
    expect(
      obs({
        receipt: {
          status: "0x0",
          blockNumber: "580",
          blockHash: H(580),
        } as never,
        canonicalHashAtBlock: H(580),
      }),
    ).toBeNull();
    // A record without the anchor (e.g. read from an older store) fails closed.
    const legacy = {
      ...s,
      lastSeenAt: undefined,
    } as unknown as ExecutionRecord;
    expect(() =>
      go(legacy, {
        type: "TX_DROPPED",
        at: NOW + 3,
        role: "main",
        hash: H(1),
        unseenForMs: W,
      }),
    ).toThrow("NOT_DROPPED_YET");
    // RECONCILED needs ok === true.
    let m = go(s, {
      type: "TX_CONFIRMED",
      at: NOW + 3,
      role: "main",
      hash: H(1),
      block: "1",
      blockHash: H(1),
      confirmations: 10,
    });
    m = go(m, {
      type: "DESTINATION",
      at: NOW + 4,
      status: "DELIVERED",
      hash: H(50),
      amount: "5007450",
    });
    expect(m.state).toBe("SETTLED");
    expect(() =>
      go(m, {
        type: "RECONCILED",
        at: NOW + 5,
        ok: "false",
        detail: "x",
      } as unknown as ExecutionEvent),
    ).toThrow("INVALID_OBSERVATION");
    expect(
      go(m, {
        type: "RECONCILED",
        at: NOW + 5,
        ok: false,
        detail: "SOURCE_DELTA_MISMATCH",
      }).state,
    ).toBe("DISCREPANCY");
  });
});
/** G14 (review N5): a PREFLIGHT event that carries a real all-PASS report; the lifecycle recomputes its digest. */
function PF(planHash: string, at: number) {
  const report = {
    checks: CHECK_IDS.map((id) => ({
      id,
      status: "PASS" as const,
      code: "TEST",
    })),
    now: at,
  };
  return {
    type: "PREFLIGHT" as const,
    at,
    plan: planHash,
    ready: true,
    digest: preflightDigest(planHash, report.checks, report.now),
    failed: [] as string[],
    report,
  };
}
