// V1.7 G7 controlled-pilot PREPARATION tests (prep only: nothing here signs, sends, approves or deploys).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ExecutionEvidence } from "../../src/g7/write-evidence";
import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiParameters,
  type Hex,
} from "viem";
import { G5_ROUTE_PINS } from "../../src/g5/route-pins";
import { deriveSpendableReserve } from "../../src/g5/reserve";
import {
  BRIDGE_TOKEN_SELECTOR,
  CalldataError,
  decodeBridgeTokenIndependent,
  encodeBridgeTokenIndependent,
  selectorOf,
} from "../../src/g7/decoder";
import {
  LEDGER_EVENT_ABI,
  reconcileLedgerDelta,
  type LedgerState,
  type RawLog,
} from "../../src/g7/ledger";
import {
  CROSS,
  ENDPOINTS,
  EXTENDED_PINS,
  NATIVE,
  NEGATIVE_CONTROLS,
  PILOT_EOA,
  ROLE_NAMES,
  TRUST_ACCOUNTS,
} from "../../src/g7/policy";
import {
  encodePilotCalldata,
  evaluateGates,
  expectedFirewallIntent,
  expectedPinsView,
  firewallMutations,
  g7ContractEntry,
  g7Firewall,
  g7TrustedDecoder,
  gasPlan,
  hostileReplay,
  intentDigest,
  normalizedOwnerIntent,
  pinsDigest,
  productionGateStaysClosed,
  quoteFromFees,
  routePinsView,
  verifyCalldata,
  type FirewallContext,
  type PrepInput,
  type SideRead,
  type SimulationRead,
  type UnsignedPackageLike,
} from "../../src/g7/prep";
import {
  G7RpcError,
  ReadOnlyRpc,
  assertReadOnlyRequest,
} from "../../src/g7/rpc";
import * as rpcModule from "../../src/g7/rpc";
import { classifyTracking, type TrackInput } from "../../src/g7/track";

const NOW = 1_790_000_000_000;
const P = G5_ROUTE_PINS;
const E = EXTENDED_PINS;
const roles = (r: Record<string, readonly string[]>) =>
  Object.fromEntries(ROLE_NAMES.map((n) => [n, [...(r[n] ?? [])]]));
const ABI_TRUE = "0x" + "0".repeat(63) + "1";
const HASH_A = "0x" + "aa".repeat(32);
const HASH_B = "0x" + "bb".repeat(32);
const OTHER = "0x1111111111111111111111111111111111111111";
const SEL = {
  BaseBridgeInvalidAmount: selectorOf("BaseBridgeInvalidAmount()"),
  BaseBridgeInvalidValue: selectorOf("BaseBridgeInvalidValue(uint256,uint256)"),
  BaseBridgeCanNotZeroAddress: selectorOf("BaseBridgeCanNotZeroAddress()"),
  RegistryNotExistToken: selectorOf("RegistryNotExistToken(address)"),
} as Record<string, string>;

function oneSide(url: string = ENDPOINTS.one[0]): SideRead {
  return {
    url,
    chainId: 612055,
    block: 45709040,
    blockHash: HASH_A,
    blockTimestamp: Math.floor(NOW / 1000) - 8,
    proxyCodeHash: P.source.proxyCodeHash,
    implementationSlot:
      "0x" + "0".repeat(24) + P.source.implementation.slice(2),
    implementation: P.source.implementation,
    implementationCodeHash: P.source.implementationCodeHash,
    adminSlot: E.one.adminSlot,
    beaconSlot: E.one.beaconSlot,
    paused: false,
    threshold: 2,
    verifier: P.source.verifier,
    verifierCodeHash: P.source.verifierCodeHash,
    executor: E.one.executor,
    dev: E.one.dev,
    maxExtraDataLength: "1024",
    bridgeRoles: roles(E.one.bridgeRoles),
    verifierRoles: roles(E.one.verifierRoles),
    verifierThresholds: { ...E.one.verifierThresholds },
    priceFeed: E.one.priceFeed,
    feeDenominator: "10000",
    pair: {
      localToken: NATIVE.toLowerCase(),
      remoteToken: CROSS.toLowerCase(),
      isOrigin: false,
      paused: false,
      pendingAmount: "0",
      deposited: "0",
      minted: "928704838855791322580189858",
    },
    chainPaused: false,
    finalizePaused: false,
    nextInitiateIndex: "98748",
    nextFinalizeIndex: "40837",
    pending: [],
    trustAccountCodes: Object.fromEntries(
      TRUST_ACCOUNTS.map((a) => [a.toLowerCase(), "0x"]),
    ),
    accountCode: "0x",
    fees: {
      minimum: "5000000000000000000",
      networkFee: "180000000000000000",
      exFee: "0",
      minimumAtAmount: "5000000000000000000",
      networkFeeAtAmount: "180000000000000000",
      configMinimum: "5000000000000000000",
      configNetworkFee: "180000000000000000",
      exFeeRate: "0",
    },
    balance: "6000000000000000000",
    nonce: "0",
  };
}
function bscSide(url: string = ENDPOINTS.bsc[0]): SideRead {
  return {
    ...oneSide(url),
    chainId: 56,
    block: 125824402,
    blockHash: HASH_B,
    proxyCodeHash: P.destination.proxyCodeHash,
    implementationSlot:
      "0x" + "0".repeat(24) + P.destination.implementation.slice(2),
    implementation: P.destination.implementation,
    implementationCodeHash: P.destination.implementationCodeHash,
    verifier: P.destination.verifier,
    verifierCodeHash: P.destination.verifierCodeHash,
    executor: E.bsc.executor,
    bridgeRoles: roles(E.bsc.bridgeRoles),
    verifierRoles: roles(E.bsc.verifierRoles),
    pair: {
      localToken: CROSS.toLowerCase(),
      remoteToken: NATIVE.toLowerCase(),
      isOrigin: true,
      paused: false,
      pendingAmount: "0",
      deposited: "913927728855791322580189858",
      minted: "0",
    },
    nextInitiateIndex: "40837",
    nextFinalizeIndex: "98748",
    pending: [
      {
        index: "20",
        toToken: CROSS.toLowerCase(),
        to: "0x179b7af5db07648bcbff3570f68d764c7471952d",
        value: "0",
        status: 0,
      },
    ],
    fees: undefined,
    balance: undefined,
    nonce: undefined,
    token: {
      address: CROSS.toLowerCase(),
      codeHash: P.destination.tokenCodeHash,
      decimals: 18,
      balanceOfBridge: "913927738855791322580189858",
      symbol: "CROSS",
      name: "Cross",
    },
  };
}
function sim(url: string): SimulationRead {
  return {
    url,
    block: 45709040,
    blockHash: HASH_A,
    blockHashAfter: HASH_A,
    ethCall: { ok: true, result: ABI_TRUE },
    estimateGas: { ok: true, result: "0x1ee57" },
    negatives: NEGATIVE_CONTROLS.map((c) => ({
      name: c.name,
      rejected: true,
      selector: SEL[c.error],
      errorName: c.error,
      decoded: `${c.error}()`,
      expectedError: c.error,
      expectedSelector: SEL[c.error],
    })),
    gasPrice: "4000000000",
    maxPriorityFeePerGas: "3000000000",
    baseFeePerGas: "1000000000",
  };
}
const quietLedger = () => {
  const s: LedgerState = {
    block: 125824402,
    balance: 913927738855791322580189858n,
    deposited: 913927728855791322580189858n,
    pendingAmount: 0n,
    nextFinalize: 98748n,
    nextInitiate: 40837n,
    pending: [{ index: 20n, value: 0n }],
  };
  return reconcileLedgerDelta({ ...s, block: 125745332 }, s, [], [], {
    proxy: P.destination.proxy,
    cross: CROSS,
    dev: E.bsc.dev,
    sourceChainId: 612055n,
  });
};

type Mut = (i: PrepInput) => void;
function build(mutate?: {
  one?: (s: SideRead) => void;
  bsc?: (s: SideRead) => void;
  input?: Mut;
  observedAt?: number;
}) {
  const ones = [oneSide(), oneSide(ENDPOINTS.one[1])];
  const bscs = [bscSide(), bscSide(ENDPOINTS.bsc[1])];
  if (mutate?.one) ones.forEach(mutate.one);
  if (mutate?.bsc) bscs.forEach(mutate.bsc);
  const one = ones[0],
    bsc = bscs[0];
  const quote = quoteFromFees(
    one.fees!,
    mutate?.observedAt ?? NOW - 10_000,
    one,
  );
  const intent = {
    account: PILOT_EOA,
    recipient: PILOT_EOA,
    amount: quote.amount,
    networkFee: quote.networkFee,
    serviceFee: quote.serviceFee,
  };
  const data = encodePilotCalldata(intent);
  const tx = {
    chainId: "612055",
    from: PILOT_EOA,
    to: P.source.proxy,
    value: quote.value.toString(),
    data,
  };
  const expected = expectedFirewallIntent(quote, "g7-test");
  const entry = g7ContractEntry(one, NOW - 10_000);
  const ctx: FirewallContext = {
    entry,
    quote,
    expectedCalldata: data,
    pinsDigestExpected: pinsDigest(expectedPinsView()),
    pinsDigestObserved: pinsDigest(routePinsView(one, bsc)),
    implementationHashObserved: one.implementationCodeHash,
    platformFeeBps: 0,
    approval: { spender: null, amount: "0" },
  };
  const reserve = deriveSpendableReserve({
    token: CROSS,
    balance: BigInt(bsc.token!.balanceOfBridge),
    deposited: BigInt(bsc.pair.deposited),
    pendingAmount: BigInt(bsc.pair.pendingAmount),
    pending: bsc.pending.map((p) => ({
      index: BigInt(p.index),
      toToken: p.toToken,
      value: BigInt(p.value),
    })),
    pendingComplete: true,
    inFlight: { enumerated: true, expectedCount: 0, values: [] },
    sourceMinted: BigInt(one.pair.minted),
    minimum: quote.amount,
    driftState: "VERIFIED_READ_ONLY",
  });
  const input: PrepInput = {
    g5: {
      decisionStatus: "PASS",
      decisionFileSha256Matches: true,
      manifestFilesVerified: 10,
      manifestFilesTotal: 10,
      g5StatusConstant: "PASS",
      decisionPinsMatchRoutePins: true,
    },
    one: ones,
    bsc: bscs,
    driftScans: [
      {
        chain: "one",
        contract: P.source.proxy,
        from: 1,
        to: 2,
        complete: true,
        events: [],
      },
      {
        chain: "one",
        contract: P.source.verifier,
        from: 1,
        to: 2,
        complete: true,
        events: [],
      },
      {
        chain: "bsc",
        contract: P.destination.proxy,
        from: 1,
        to: 2,
        complete: true,
        events: [],
      },
      {
        chain: "bsc",
        contract: P.destination.verifier,
        from: 1,
        to: 2,
        complete: true,
        events: [],
      },
    ],
    ledger: quietLedger(),
    inFlight: {
      enumerated: true,
      bscNextFinalize: "98748",
      oneNextInitiate: "98748",
      items: [],
    },
    reserve,
    bscBlockFinalized: true,
    simulations: [sim(ENDPOINTS.one[0]), sim(ENDPOINTS.one[1])],
    quote,
    gas: gasPlan(126551n, [4_000_000_000n], [3_000_000_000n], 1_000_000_000n),
    intent,
    calldata: verifyCalldata(data, intent),
    selectorInLiveDispatcher: true,
    firewall: {
      positive: g7Firewall(tx, expected, ctx, NOW),
      mutations: firewallMutations(tx, expected, ctx, intent, NOW),
    },
    writeSafety: {
      execution: new ExecutionEvidence().snapshot(),
      rpcMethodsUsed: {},
      forbiddenMethodCalls: 0,
      stateOverrideCalls: 0,
      staticScanPass: true,
      protectedBaselinePass: true,
      gate: productionGateStaysClosed(tx, expected, entry, NOW),
      feePolicyEnabled: false,
      feePolicyBps: 0,
    },
    decisionAt: NOW,
  };
  mutate?.input?.(input);
  return {
    input,
    tx,
    expected,
    ctx,
    intent,
    quote,
    data,
    result: evaluateGates(input),
  };
}
const failed = (r: ReturnType<typeof evaluateGates>) =>
  r.gates.filter((g) => g.status !== "PASS").map((g) => g.id);

describe("G7 prep — baseline", () => {
  it("all gates pass on a fully consistent fresh observation set", () => {
    const { result } = build();
    expect(failed(result)).toEqual([]);
    expect(result.status).toBe("READY_FOR_OWNER_SIGNATURE");
    expect(result.gates.map((g) => g.id)).toEqual([
      ...Array.from({ length: 20 }, (_, k) => `P${k + 1}`),
      "R1",
    ]);
  });
});

describe("G7 prep — required tests (GOAL §53)", () => {
  it("1. exact calldata positive (viem = independent encoder, golden bytes)", () => {
    const { data, input } = build();
    expect(data).toBe(
      "0x5fd262de" +
        "38".padStart(64, "0") +
        "1".padStart(64, "0") +
        PILOT_EOA.slice(2).padStart(64, "0") +
        "4563918244f40000".padStart(64, "0") +
        "027f7d0bdb920000".padStart(64, "0") +
        "0".padStart(64, "0") +
        "e0".padStart(64, "0") +
        "0".padStart(64, "0"),
    );
    expect(input.calldata.ok).toBe(true);
    expect(input.calldata.checks.viemEqualsIndependentEncoding).toBe(true);
    expect(BRIDGE_TOKEN_SELECTOR).toBe("0x5fd262de");
  });
  it("2. decoded intent equals the expected intent field by field", () => {
    const { data } = build();
    const d = decodeBridgeTokenIndependent(data);
    expect(d).toEqual({
      selector: "0x5fd262de",
      toChainID: 56n,
      fromToken: NATIVE.toLowerCase(),
      to: PILOT_EOA,
      value: 5_000_000_000_000_000_000n,
      networkFee: 180_000_000_000_000_000n,
      exFee: 0n,
      extraData: "0x",
    });
  });
  it("3. one-wei amount mutation is blocked (firewall and gates)", () => {
    const { tx, expected, ctx, intent } = build();
    const data = encodeBridgeTokenIndependent({
      toChainID: 56n,
      fromToken: NATIVE,
      to: PILOT_EOA,
      value: intent.amount + 1n,
      networkFee: intent.networkFee,
      exFee: 0n,
      extraData: "0x",
    });
    expect(
      g7Firewall(
        { ...tx, data, value: (BigInt(tx.value) + 1n).toString() },
        expected,
        ctx,
        NOW,
      ).pass,
    ).toBe(false);
    const r = build({
      input: (i) => (i.quote = { ...i.quote, amount: i.quote.amount + 1n }),
    }).result;
    expect(r.status).toBe("BLOCKED");
    expect(failed(r)).toContain("P7");
  });
  it("4. one-wei msg.value mutation is blocked", () => {
    const { tx, expected, ctx } = build();
    for (const d of [1n, -1n])
      expect(
        g7Firewall(
          { ...tx, value: (BigInt(tx.value) + d).toString() },
          expected,
          ctx,
          NOW,
        ),
      ).toMatchObject({ pass: false, reason: "INTENT_MISMATCH" });
    const r = build({
      input: (i) => (i.quote = { ...i.quote, value: i.quote.value + 1n }),
    }).result;
    expect(failed(r)).toContain("P7");
  });
  it("5. wrong recipient is blocked", () => {
    const { tx, expected, ctx, intent } = build();
    const data = encodeBridgeTokenIndependent({
      toChainID: 56n,
      fromToken: NATIVE,
      to: OTHER,
      value: intent.amount,
      networkFee: intent.networkFee,
      exFee: 0n,
      extraData: "0x",
    });
    expect(g7Firewall({ ...tx, data }, expected, ctx, NOW).pass).toBe(false);
    const r = build({
      input: (i) => (i.intent = { ...i.intent, recipient: OTHER }),
    }).result;
    expect(failed(r)).toContain("P12");
    const code = build({ bsc: (s) => (s.accountCode = "0x6080") }).result;
    expect(failed(code)).toContain("P12");
  });
  it("6. wrong proxy is blocked", () => {
    const { tx, expected, ctx } = build();
    for (const to of [P.destination.proxy, P.source.implementation, OTHER])
      expect(g7Firewall({ ...tx, to }, expected, ctx, NOW).pass).toBe(false);
  });
  it("7. wrong chain is blocked (tx chainId, destination chain, observed chain)", () => {
    const { tx, expected, ctx, intent } = build();
    expect(g7Firewall({ ...tx, chainId: "56" }, expected, ctx, NOW).pass).toBe(
      false,
    );
    const data = encodeBridgeTokenIndependent({
      toChainID: 97n,
      fromToken: NATIVE,
      to: PILOT_EOA,
      value: intent.amount,
      networkFee: intent.networkFee,
      exFee: 0n,
      extraData: "0x",
    });
    expect(g7Firewall({ ...tx, data }, expected, ctx, NOW)).toMatchObject({
      pass: false,
      reason: "UNSUPPORTED_ROUTE",
    });
    expect(failed(build({ one: (s) => (s.chainId = 1) }).result)).toContain(
      "P2",
    );
  });
  it("8. runtime drift is blocked (implementation hash, slot, proxy code, upgrade event)", () => {
    for (const r of [
      build({ one: (s) => (s.implementationCodeHash = "0x" + "11".repeat(32)) })
        .result,
      build({
        one: (s) =>
          (s.implementationSlot = "0x" + "0".repeat(24) + "22".repeat(20)),
      }).result,
      build({ bsc: (s) => (s.proxyCodeHash = "0x" + "33".repeat(32)) }).result,
      build({
        input: (i) =>
          i.driftScans[2].events.push({
            event: "Upgraded(address)",
            block: 9,
            tx: HASH_A,
          }),
      }).result,
    ]) {
      expect(r.status).toBe("BLOCKED");
      expect(r.blockedReasons.join(" ")).toContain("BLOCKED_RUNTIME_DRIFT");
    }
  });
  it("9. validator drift is blocked even when the validator count is unchanged", () => {
    const r = build({
      bsc: (s) =>
        (s.bridgeRoles.VALIDATOR_ROLE = [
          P.destination.settlement.validators[0],
          P.destination.settlement.validators[1],
          OTHER,
        ]),
    }).result;
    expect(r.status).toBe("BLOCKED");
    expect(r.blockedReasons.join(" ")).toContain("BLOCKED_AUTHORITY_DRIFT");
    const verifierRole = build({
      one: (s) => (s.verifierRoles.PRICER_ROLE = [OTHER]),
    }).result;
    expect(failed(verifierRole)).toContain("P4");
    const notEoa = build({
      one: (s) =>
        (s.trustAccountCodes[TRUST_ACCOUNTS[0]] = "0xef0100" + "11".repeat(20)),
    }).result;
    expect(failed(notEoa)).toContain("P4");
  });
  it("10. threshold drift is blocked", () => {
    const r = build({ one: (s) => (s.threshold = 1) }).result;
    expect(r.status).toBe("BLOCKED");
    expect(failed(r)).toContain("P4");
  });
  it("11. any pause is blocked", () => {
    for (const m of [
      (s: SideRead) => (s.paused = true),
      (s: SideRead) => (s.chainPaused = true),
      (s: SideRead) => (s.pair.paused = true),
      (s: SideRead) => (s.finalizePaused = true),
    ]) {
      expect(failed(build({ bsc: m }).result)).toContain("P6");
      expect(failed(build({ one: m }).result)).toContain("P6");
    }
  });
  it("12. insufficient reserve is blocked", () => {
    const r = build({
      input: (i) =>
        (i.reserve = deriveSpendableReserve({
          token: CROSS,
          balance: 4n * 10n ** 18n,
          deposited: 4n * 10n ** 18n,
          pendingAmount: 0n,
          pending: [],
          pendingComplete: true,
          inFlight: { enumerated: true, expectedCount: 0, values: [] },
          sourceMinted: 10n ** 27n,
          minimum: i.quote.amount,
          driftState: "VERIFIED_READ_ONLY",
        })),
    }).result;
    expect(failed(r)).toContain("P8");
    const unenumerated = build({
      input: (i) => (i.inFlight = { ...i.inFlight, enumerated: false }),
    }).result;
    expect(failed(unenumerated)).toContain("P8");
  });
  it("13. a valued active pending CROSS obligation is blocked", () => {
    const r = build({
      bsc: (s) =>
        s.pending.push({
          index: "99",
          toToken: CROSS.toLowerCase(),
          to: OTHER,
          value: "1",
          status: 1,
        }),
    }).result;
    expect(failed(r)).toContain("P9");
  });
  it("14. insufficient wallet balance is blocked (value + gas limit x price cap)", () => {
    const base = build();
    const need = base.quote.value + base.input.gas.maximumGasCost;
    const r = build({
      one: (s) => (s.balance = (need - 1n).toString()),
    }).result;
    expect(failed(r)).toContain("P11");
    expect(
      build({ one: (s) => (s.balance = need.toString()) }).result.status,
    ).toBe("READY_FOR_OWNER_SIGNATURE");
  });
  it("15. a stale quote is blocked (> 60 s) in the gates and in the firewall", () => {
    const r = build({ observedAt: NOW - 60_001 }).result;
    expect(failed(r)).toContain("P19");
    const { tx, expected, ctx } = build();
    expect(g7Firewall(tx, expected, ctx, ctx.quote.expiresAt).pass).toBe(false);
  });
  it("16. a positive eth_call is required (false / revert / single source)", () => {
    expect(
      failed(
        build({
          input: (i) =>
            (i.simulations[1].ethCall = {
              ok: true,
              result: "0x" + "0".repeat(64),
            }),
        }).result,
      ),
    ).toContain("P14");
    expect(
      failed(
        build({
          input: (i) =>
            (i.simulations[0].ethCall = {
              ok: false,
              error: { code: 3, message: "execution reverted" },
            }),
        }).result,
      ),
    ).toContain("P14");
    expect(
      failed(
        build({ input: (i) => (i.simulations = [i.simulations[0]]) }).result,
      ),
    ).toContain("P14");
  });
  it("17. eth_estimateGas is required", () => {
    expect(
      failed(
        build({
          input: (i) =>
            (i.simulations[0].estimateGas = { ok: false, error: "x" }),
        }).result,
      ),
    ).toContain("P15");
    expect(() => gasPlan(0n, [1n], [1n], 1n)).toThrow("ESTIMATE_IMPLAUSIBLE");
  });
  it("18. a non-zero Otherbridge fee is blocked", () => {
    const { tx, expected, ctx } = build();
    expect(
      g7Firewall(tx, expected, { ...ctx, platformFeeBps: 5 }, NOW),
    ).toMatchObject({ pass: false, reason: "PLATFORM_FEE_NONZERO" });
    expect(
      g7Firewall(
        tx,
        { ...expected, platformFeeBps: 1 as unknown as 0 },
        ctx,
        NOW,
      ),
    ).toMatchObject({ pass: false, reason: "SCHEMA_REJECTED" });
    expect(
      failed(build({ input: (i) => (i.writeSafety.feePolicyBps = 5) }).result),
    ).toContain("R1");
  });
  it("19. any approval request is blocked (native route needs none)", () => {
    const { tx, expected, ctx } = build();
    expect(
      g7Firewall(
        tx,
        {
          ...expected,
          approvalSpender: P.source.proxy,
          approvalAmount: expected.inputAmount,
        },
        ctx,
        NOW,
      ).pass,
    ).toBe(false);
    expect(
      g7Firewall(
        tx,
        expected,
        { ...ctx, approval: { spender: P.source.proxy, amount: "1" } },
        NOW,
      ),
    ).toMatchObject({
      pass: false,
      reason: "APPROVAL_NOT_ALLOWED_FOR_NATIVE_ROUTE",
    });
  });
  it("20. signing RPC methods are forbidden before any network I/O", async () => {
    const fetchImpl = vi.fn();
    const client = new ReadOnlyRpc({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    for (const m of [
      "eth_sign",
      "personal_sign",
      "eth_signTypedData",
      "eth_signTypedData_v4",
      "eth_signTransaction",
      "eth_accounts",
      "eth_requestAccounts",
      "wallet_requestPermissions",
      "wallet_switchEthereumChain",
      "wallet_sendCalls",
    ]) {
      expect(() => assertReadOnlyRequest(ENDPOINTS.one[0], m, [])).toThrow(
        G7RpcError,
      );
      await expect(client.raw(ENDPOINTS.one[0], m, [])).rejects.toMatchObject({
        code: "METHOD_NOT_ALLOWED",
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    const exported = Object.keys(rpcModule).join(",");
    expect(exported).not.toMatch(/sign|send|wallet|account/i);
    expect(
      Object.getOwnPropertyNames(ReadOnlyRpc.prototype).join(","),
    ).not.toMatch(/sign|send|wallet/i);
  });
  it("21. broadcast RPC methods, state overrides and unvetted endpoints are forbidden", async () => {
    const fetchImpl = vi.fn();
    const client = new ReadOnlyRpc({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    for (const m of [
      "eth_sendTransaction",
      "eth_sendRawTransaction",
      "eth_sendBundle",
      "debug_traceCall",
      "anvil_setBalance",
      "hardhat_impersonateAccount",
    ])
      await expect(client.raw(ENDPOINTS.one[0], m, [])).rejects.toMatchObject({
        code: "METHOD_NOT_ALLOWED",
      });
    await expect(
      client.raw(ENDPOINTS.one[0], "eth_call", [
        { to: P.source.proxy, data: "0x" },
        "latest",
        { [PILOT_EOA]: { balance: "0xff" } },
      ]),
    ).rejects.toMatchObject({ code: "STATE_OVERRIDE_OR_BAD_ARITY" });
    await expect(
      client.raw(ENDPOINTS.one[0], "eth_estimateGas", [
        { to: P.source.proxy, data: "0x", gasPrice: "0x1" },
      ]),
    ).rejects.toMatchObject({ code: "CALL_FIELD_NOT_ALLOWED" });
    await expect(
      client.raw("https://evil.example", "eth_call", [{ to: P.source.proxy }]),
    ).rejects.toMatchObject({ code: "ENDPOINT_NOT_VETTED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("22. the unsigned package has no signature/tx hash and its intent digest re-verifies", () => {
    const pkg = JSON.parse(
      readFileSync("G7_UNSIGNED_TRANSACTION.json", "utf8"),
    );
    const dig = JSON.parse(readFileSync("G7_INTENT_DIGEST.json", "utf8"));
    const decision = JSON.parse(readFileSync("G7_PREP_DECISION.json", "utf8"));
    expect(pkg.signature).toBeNull();
    expect(pkg.txHash).toBeNull();
    expect(pkg.broadcast).toBe(false);
    expect(pkg.trustModelAccepted).toBe(false);
    expect(decision.trustModelAccepted).toBe(false);
    expect(decision.signature).toBeNull();
    expect(decision.broadcast).toBe(false);
    expect(decision.counters).toEqual({
      realSignatures: 0,
      approvals: 0,
      permits: 0,
      broadcasts: 0,
      deploys: 0,
      feeCollection: 0,
      walletPrompts: 0,
      executionGateChanges: 0,
    });
    const keys =
      JSON.stringify(pkg)
        .match(/"([A-Za-z]+)":/g)
        ?.map((k) => k.slice(1, -2)) ?? [];
    for (const forbidden of [
      "r",
      "s",
      "v",
      "yParity",
      "rawTransaction",
      "signedTransaction",
      "privateKey",
      "mnemonic",
      "seed",
    ])
      expect(keys).not.toContain(forbidden);
    expect(pkg.layers.ephemeralStatus).toBe("MUST_REFRESH_BEFORE_SIGNING");
    expect(pkg.approval).toEqual({
      required: false,
      spender: null,
      amount: "0",
      permit: null,
      allowance: null,
    });
    const recomputed = intentDigest(
      normalizedOwnerIntent(pkg as UnsignedPackageLike),
    );
    expect(recomputed.sha256).toBe(dig.digest.sha256);
    expect(decision.intentDigestSha256).toBe(dig.digest.sha256);
    const mutated = { ...pkg, value: (BigInt(pkg.value) + 1n).toString() };
    expect(intentDigest(normalizedOwnerIntent(mutated)).sha256).not.toBe(
      dig.digest.sha256,
    );
    expect(() =>
      normalizedOwnerIntent({
        ...pkg,
        decodedIntent: { ...pkg.decodedIntent, to: OTHER },
      }),
    ).toThrow("DECODED_INTENT_FIELD_MISMATCH");
    const otherRecipient = encodeBridgeTokenIndependent({
      toChainID: 56n,
      fromToken: NATIVE,
      to: OTHER,
      value: BigInt(pkg.decodedIntent.value),
      networkFee: BigInt(pkg.decodedIntent.networkFee),
      exFee: 0n,
      extraData: "0x",
    });
    expect(() =>
      normalizedOwnerIntent({ ...pkg, data: otherRecipient }),
    ).toThrow("DECODED_INTENT_FIELD_MISMATCH");
  });
});

describe("G7 prep — additional fail-closed controls", () => {
  it("owner re-approval is required when the minimum or fees increased; a lower minimum stays READY", () => {
    const up = build({
      one: (s) => (
        (s.fees = {
          ...s.fees!,
          minimum: "6000000000000000000",
          minimumAtAmount: "6000000000000000000",
        }),
        (s.balance = "10000000000000000000")
      ),
    }).result;
    expect(up.status).toBe("OWNER_REAPPROVAL_REQUIRED");
    expect(up.gates.find((g) => g.id === "P7")!.reasons).toContain(
      "MINIMUM_INCREASED_ABOVE_5_ONE_REFERENCE",
    );
    const fee = build({
      one: (s) =>
        (s.fees = {
          ...s.fees!,
          networkFee: "190000000000000000",
          networkFeeAtAmount: "190000000000000000",
        }),
    }).result;
    expect(fee.status).toBe("OWNER_REAPPROVAL_REQUIRED");
    const down = build({
      one: (s) =>
        (s.fees = {
          ...s.fees!,
          minimum: "4000000000000000000",
          minimumAtAmount: "4000000000000000000",
        }),
    }).result;
    expect(down.status).toBe("READY_FOR_OWNER_SIGNATURE");
  });
  it("dual-RPC disagreement blocks (state, block hash, simulation)", () => {
    expect(
      failed(
        build({
          input: (i) =>
            (i.one[1] = { ...i.one[1], nextInitiateIndex: "98749" }),
        }).result,
      ),
    ).toContain("P18");
    expect(
      failed(
        build({ input: (i) => (i.bsc[1] = { ...i.bsc[1], blockHash: HASH_A }) })
          .result,
      ),
    ).toContain("P18");
    expect(
      failed(
        build({
          input: (i) =>
            (i.simulations[1].estimateGas = { ok: true, result: "0x1ee58" }),
        }).result,
      ),
    ).toEqual(expect.arrayContaining(["P15", "P18"]));
    expect(
      failed(
        build({ input: (i) => (i.simulations[0].blockHashAfter = HASH_B) })
          .result,
      ),
    ).toContain("P18");
  });
  it("an unexpectedly accepted or differently reverting negative control blocks", () => {
    expect(
      failed(
        build({
          input: (i) =>
            (i.simulations[0].negatives[3] = {
              ...i.simulations[0].negatives[3],
              rejected: false,
            }),
        }).result,
      ),
    ).toContain("P16");
    expect(
      failed(
        build({
          input: (i) =>
            (i.simulations[1].negatives[0] = {
              ...i.simulations[1].negatives[0],
              selector: "0xdeadbeef",
            }),
        }).result,
      ),
    ).toContain("P16");
  });
  it("every hostile firewall mutation is rejected and the production gate stays closed", () => {
    const { input, tx, expected } = build();
    expect(input.firewall.positive.pass).toBe(true);
    expect(input.firewall.mutations.length).toBeGreaterThanOrEqual(30);
    expect(input.firewall.mutations.filter((m) => !m.rejected)).toEqual([]);
    const gate = productionGateStaysClosed(
      tx,
      expected,
      g7ContractEntry(oneSide(), NOW),
      NOW,
    );
    expect(gate).toMatchObject({
      globalExecutionEnabled: false,
      killPolicyGlobal: true,
      productionRegistryEntries: 0,
      productionSimulationGate: "EXECUTION_PAUSED",
      closed: true,
    });
    expect(
      failed(
        build({
          input: (i) =>
            (i.writeSafety.gate = { ...i.writeSafety.gate, closed: false }),
        }).result,
      ),
    ).toContain("R1");
    expect(
      failed(
        build({ input: (i) => (i.writeSafety.forbiddenMethodCalls = 1) })
          .result,
      ),
    ).toContain("P20");
  });
  it("the independent decoder rejects non-canonical calldata", () => {
    const { data } = build();
    const bad = [
      data.toUpperCase().replace("0X", "0x"),
      data + "00",
      "0xff" + data.slice(4),
      data.slice(0, 10 + 64 * 6) +
        "e1".padStart(64, "0") +
        data.slice(10 + 64 * 7),
      data.slice(0, 10 + 64) +
        "ff".padStart(24, "f") +
        data.slice(10 + 64 + 24),
      "0x12345678" + data.slice(10),
    ];
    for (const b of bad)
      expect(() => decodeBridgeTokenIndependent(b)).toThrow(CalldataError);
    // A canonical but foreign destination chain decodes, and the trusted route decoder refuses it.
    const hugeChain = data.slice(0, 10) + "ff" + data.slice(12);
    expect(decodeBridgeTokenIndependent(hugeChain).toChainID).not.toBe(56n);
    expect(() => g7TrustedDecoder(hugeChain)).toThrow("UNSUPPORTED_ROUTE");
  });
  it("G5/V1.6 decision problems block P1", () => {
    expect(
      failed(
        build({
          input: (i) => (i.g5 = { ...i.g5, decisionFileSha256Matches: false }),
        }).result,
      ),
    ).toContain("P1");
    expect(
      failed(
        build({ input: (i) => (i.g5 = { ...i.g5, manifestFilesVerified: 9 }) })
          .result,
      ),
    ).toContain("P1");
  });
  it("the incremental ledger reconciles a deposit/payout delta and fails on any unexplained movement", () => {
    const proxy = P.destination.proxy;
    const enc = (
      name: "BridgeInitiated" | "BridgeFinalized" | "Transfer",
      args: Record<string, unknown>,
      nonIndexed: [string, unknown[]],
      tx: string,
      block: number,
      logIndex: number,
      address: string,
    ): RawLog => ({
      address,
      topics: encodeEventTopics({
        abi: LEDGER_EVENT_ABI,
        eventName: name,
        args,
      } as never) as string[],
      data: encodeAbiParameters(
        parseAbiParameters(nonIndexed[0]),
        nonIndexed[1] as never,
      ) as string,
      blockNumber: "0x" + block.toString(16),
      transactionHash: tx,
      logIndex: "0x" + logIndex.toString(16),
    });
    const user = OTHER as Hex;
    const base: LedgerState = {
      block: 100,
      balance: 1000n,
      deposited: 990n,
      pendingAmount: 0n,
      nextFinalize: 50n,
      nextInitiate: 7n,
      pending: [],
    };
    const live: LedgerState = {
      block: 110,
      balance: 1000n + 30n - 20n,
      deposited: 990n + 30n - 20n,
      pendingAmount: 0n,
      nextFinalize: 51n,
      nextInitiate: 8n,
      pending: [],
    };
    const dep = HASH_A,
      pay = HASH_B;
    const proxyLogs = [
      enc(
        "BridgeInitiated",
        { toChainID: 612055n, index: 7n, from: user },
        [
          "address,address,address,uint256,uint256,uint256,bytes,uint256",
          [CROSS, NATIVE, user, 30n, 0n, 0n, "0x", 1n],
        ],
        dep,
        101,
        1,
        proxy,
      ),
      enc(
        "BridgeFinalized",
        { fromChainID: 612055n, index: 50n, toToken: CROSS as Hex },
        ["address,uint256,uint256", [user, 20n, 2n]],
        pay,
        105,
        2,
        proxy,
      ),
    ];
    const transfers = [
      enc(
        "Transfer",
        { from: user, to: proxy as Hex },
        ["uint256", [30n]],
        dep,
        101,
        0,
        CROSS,
      ),
      enc(
        "Transfer",
        { from: proxy as Hex, to: user },
        ["uint256", [20n]],
        pay,
        105,
        1,
        CROSS,
      ),
    ];
    const c = { proxy, cross: CROSS, dev: E.bsc.dev, sourceChainId: 612055n };
    const ok = reconcileLedgerDelta(base, live, proxyLogs, transfers, c);
    expect(ok.reconciled).toBe(true);
    expect(ok.deposits).toEqual({ count: 1, sum: 30n });
    expect(ok.payouts).toEqual({ count: 1, sum: 20n });
    const missingEvent = reconcileLedgerDelta(
      base,
      live,
      [proxyLogs[0]],
      transfers,
      c,
    );
    expect(missingEvent.reconciled).toBe(false);
    expect(missingEvent.checks.NO_UNCLASSIFIED_TRANSFERS).toBe(false);
    const wrongLive = reconcileLedgerDelta(
      base,
      { ...live, deposited: live.deposited + 1n },
      proxyLogs,
      transfers,
      c,
    );
    expect(wrongLive.checks.DEPOSITED_EXACT).toBe(false);
    const watched: RawLog = {
      ...proxyLogs[0],
      topics: [
        "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b",
        "0x" + "0".repeat(24) + "11".repeat(20),
      ],
      data: "0x",
    };
    expect(
      reconcileLedgerDelta(base, live, [...proxyLogs, watched], transfers, c)
        .checks.NO_WATCHED_CONFIG_OR_PRIVILEGED_EVENTS,
    ).toBe(false);
  });
  it("extended pins equal the V1.6 route snapshot (roles, dev, executor, thresholds, price feed)", () => {
    const snap = JSON.parse(
      readFileSync(
        "evidence/otherbridge-v1-6/v16-20261004T190436Z-210476/reserve/route-snapshot-final.json",
        "utf8",
      ),
    );
    for (const [chain, ext] of [
      ["one", E.one],
      ["bsc", E.bsc],
    ] as const) {
      const st = snap.chains[chain].sources.find(
        (s: { error?: string }) => !s.error,
      ).state;
      const lc = (xs: string[]) => xs.map((x) => x.toLowerCase()).sort();
      for (const r of ROLE_NAMES) {
        expect(lc(st.roles[r])).toEqual(lc([...ext.bridgeRoles[r]]));
        expect(lc(st.verifier.roles[r])).toEqual(lc([...ext.verifierRoles[r]]));
      }
      expect(st.dev.toLowerCase()).toBe(ext.dev);
      expect(st.bridgeExecutor.toLowerCase()).toBe(ext.executor);
      expect(st.maxExtraDataLength).toBe(ext.maxExtraDataLength);
      expect(st.verifier.priceFeed.toLowerCase()).toBe(ext.priceFeed);
      expect(st.verifier.getVerificationAmountThreshold).toBe(
        ext.verifierThresholds.verificationAmountThreshold,
      );
      expect(st.verifier.getPeriodTotalValueThreshold).toBe(
        ext.verifierThresholds.periodTotalValueThreshold,
      );
    }
  });
});

describe("G7 prep — post-send observer classification", () => {
  const base = (): TrackInput => ({
    elapsedSeconds: 20,
    expected: {
      account: PILOT_EOA,
      recipient: PILOT_EOA,
      amount: "5000000000000000000",
    },
    source: {
      found: true,
      endpointsAgree: true,
      status: "0x1",
      canonical: true,
      decoded: {
        index: "98800",
        recipient: PILOT_EOA,
        amount: "5000000000000000000",
        destinationChain: 56,
      },
    },
    destination: {
      searched: true,
      event: "BridgeFinalized",
      receiptSuccess: true,
      finalized: true,
      payoutExact: true,
      implementationConsistent: true,
    },
  });
  it("follows the status progression and never retries or releases", () => {
    expect(classifyTracking(base()).status).toBe("COMPLETED");
    expect(
      classifyTracking({
        ...base(),
        source: { ...base().source, found: false },
      }).status,
    ).toBe("SOURCE_PENDING");
    expect(
      classifyTracking({
        ...base(),
        source: { ...base().source, canonical: false },
      }).status,
    ).toBe("SOURCE_PENDING");
    expect(classifyTracking({ ...base(), destination: undefined }).status).toBe(
      "SOURCE_CONFIRMED",
    );
    expect(
      classifyTracking({
        ...base(),
        destination: { searched: true, event: null },
      }).status,
    ).toBe("SETTLEMENT_PENDING");
    expect(
      classifyTracking({
        ...base(),
        destination: { ...base().destination!, finalized: false },
      }).status,
    ).toBe("DESTINATION_PENDING");
    expect(
      classifyTracking({
        ...base(),
        destination: { searched: true, event: "BridgePending" },
      }).status,
    ).toBe("DESTINATION_PENDING");
    for (const r of [
      classifyTracking({
        ...base(),
        source: { ...base().source, status: "0x0" },
      }),
      classifyTracking({
        ...base(),
        source: {
          ...base().source,
          decoded: { ...base().source.decoded!, amount: "1" },
        },
      }),
      classifyTracking({
        ...base(),
        source: { ...base().source, endpointsAgree: false },
      }),
      classifyTracking({
        ...base(),
        destination: { ...base().destination!, payoutExact: false },
      }),
      classifyTracking({
        ...base(),
        destination: {
          ...base().destination!,
          implementationConsistent: false,
        },
      }),
    ]) {
      expect(r.status).toBe("MANUAL_REVIEW_REQUIRED");
      expect(r.autoRetry).toBe(false);
      expect(r.autoRelease).toBe(false);
    }
  });
  it("elapsed time alone escalates to manual review, never to failed", () => {
    const late = classifyTracking({
      ...base(),
      elapsedSeconds: 7200,
      destination: { searched: true, event: null },
    });
    expect(late.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(late.reasons.join(" ")).toContain("not failed");
    expect(late.nextStep).toMatch(/Do NOT resend/);
  });
});

describe("G7 prep — code-level no-signing / no-broadcast audit", () => {
  const files = [
    ...readdirSync("src/g7").map((f) => join("src/g7", f)),
    "scripts/g7-prepare.ts",
    "scripts/g7-track.ts",
    "scripts/g7-docs.ts",
    "scripts/g7-preserve.mjs",
  ];
  it("G7 runtime sources contain no signing, broadcasting, wallet, key-material or approval surface", () => {
    const forbidden =
      /eth_sendTransaction|eth_sendRawTransaction|\beth_sign\b|eth_signTransaction|eth_signTypedData|personal_sign|\bwallet_[A-Za-z]|eth_requestAccounts|\b(signTransaction|signMessage|signTypedData|sendTransaction|sendRawTransaction|writeContract|deployContract|privateKeyToAccount|mnemonicToAccount|createWalletClient)\b|window\.ethereum|\bapprove\s*\(|\bpermit\s*\(|process\.env|PRIVATE_?KEY|MNEMONIC/;
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(forbidden.test(text), f).toBe(false);
    }
  });
  it("the application never imports the G7 tools", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (!p.replaceAll("\\", "/").endsWith("src/g7")) walk(p);
        } else if (
          /\.(ts|tsx)$/.test(e.name) &&
          /["'][./@]*\/?g7\//.test(readFileSync(p, "utf8"))
        )
          hits.push(p);
      }
    };
    walk("src");
    expect(hits).toEqual([]);
  });
  it("the read allowlist is read-only", () => {
    const policy = readFileSync("src/g7/policy.ts", "utf8");
    const list = policy.slice(
      policy.indexOf("G7_READ_METHODS = ["),
      policy.indexOf("] as const;", policy.indexOf("G7_READ_METHODS = [")),
    );
    expect(list).not.toMatch(
      /send|sign|wallet|personal|debug|admin|anvil|hardhat/i,
    );
  });
});

describe("G7 prep — hostile replay self-test", () => {
  it("every hostile mutation of a READY observation set leaves READY", () => {
    const { input, result } = build();
    expect(result.status).toBe("READY_FOR_OWNER_SIGNATURE");
    const h = hostileReplay(input);
    expect(h.cases).toBeGreaterThanOrEqual(20);
    expect(h.results.filter((r) => !r.failClosed)).toEqual([]);
    expect(h.allFailClosed).toBe(true);
    // the replay works on deep copies: the original input is untouched
    expect(evaluateGates(input).status).toBe("READY_FOR_OWNER_SIGNATURE");
  });
});
describe("V1.12.1 release configuration is independently enforced", () => {
  it.each(["static", "protected", "missing", "production", "fee", "override"])(
    "%s blocks R1 while P20 remains truthful",
    (kind) => {
      const r = build({
        input: (i) => {
          if (kind === "static") i.writeSafety.staticScanPass = false;
          if (kind === "protected") i.writeSafety.protectedBaselinePass = false;
          if (kind === "missing")
            i.writeSafety.protectedBaselinePass = undefined as never;
          if (kind === "production") i.writeSafety.gate.closed = false;
          if (kind === "fee") i.writeSafety.feePolicyEnabled = true;
          if (kind === "override") i.writeSafety.stateOverrideCalls = 1;
        },
      }).result;
      expect(r.status).toBe("BLOCKED");
      expect(failed(r)).toContain("R1");
      expect(failed(r)).not.toContain("P20");
    },
  );
});
