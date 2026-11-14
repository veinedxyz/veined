// V1.7 G7 controlled-pilot PREPARATION logic (pure; no network I/O; no signer; no wallet).
// Builds the exact UNSIGNED native ONE -> BSC CROSS transaction from fresh observations, re-decodes it with an
// independent decoder, runs it through the existing transaction firewall plus G7 route checks, evaluates the
// P1-P20 gates and produces deterministic artifacts. The only reachable outcomes are READY_FOR_OWNER_SIGNATURE,
// BLOCKED and OWNER_REAPPROVAL_REQUIRED; none of them signs, approves, broadcasts or enables execution.
import { createHash } from "node:crypto";
import { decodeFunctionData, encodeFunctionData, type Hex } from "viem";
import { bridgeAbi } from "../adapters/onebridge";
import {
  G5_ROUTE_PINS,
  GLOBAL_EXECUTION_ENABLED,
  evaluateRouteDrift,
  isBridgeContract,
  type ObservedRoute,
} from "../g5/route-pins";
import type { ReserveResult } from "../g5/reserve";
import { RoutingError } from "../routing/model";
import {
  SimulationGate,
  compareIntent,
  contractRegistry,
  entryDigest,
  killPolicy,
  type ContractEntry,
  type ExpectedIntent,
  type PreparedTransaction,
  type TrustedDecoder,
} from "../security/firewall";
import {
  BRIDGE_TOKEN_SELECTOR,
  decodeBridgeTokenIndependent,
  encodeBridgeTokenIndependent,
  keccakHex,
  type DecodedBridgeToken,
} from "./decoder";
import type { LedgerDeltaResult } from "./ledger";
import { noWriteReasons, type ExecutionSnapshot } from "./write-evidence";
import {
  CROSS,
  EXTENDED_PINS,
  GAS_MARGIN,
  G7_POLICY_VERSION,
  NATIVE,
  NEGATIVE_CONTROLS,
  OTHERBRIDGE_PLATFORM_FEE_BPS,
  PILOT_EOA,
  QUOTE_MAX_AGE_MS,
  REFERENCE,
  ROLE_NAMES,
  TRUST_ACCOUNTS,
  type PrepStatus,
} from "./policy";

const same = (a: string | null | undefined, b: string | null | undefined) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";

// ---------------------------------------------------------------- canonical JSON / digests
export function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonicalize((value as Record<string, unknown>)[k])]),
    );
  return value;
}
export const canonicalJson = (value: unknown) =>
  JSON.stringify(canonicalize(value));
export const sha256Hex = (text: string) =>
  createHash("sha256").update(text).digest("hex");

// ---------------------------------------------------------------- observations
export interface PairRead {
  localToken: string;
  remoteToken: string;
  isOrigin: boolean;
  paused: boolean;
  pendingAmount: string;
  deposited: string;
  minted: string;
}
export interface SideRead {
  url: string;
  chainId: number;
  block: number;
  blockHash: string;
  blockTimestamp: number;
  proxyCodeHash: string;
  implementationSlot: string;
  implementation: string;
  implementationCodeHash: string;
  adminSlot: string;
  beaconSlot: string;
  paused: boolean;
  threshold: number;
  verifier: string;
  verifierCodeHash: string;
  executor: string;
  dev: string;
  maxExtraDataLength: string;
  bridgeRoles: Record<string, string[]>;
  verifierRoles: Record<string, string[]>;
  verifierThresholds: {
    verificationAmountThreshold: string;
    periodTotalValueThreshold: string;
  };
  priceFeed: string;
  feeDenominator: string;
  pair: PairRead;
  chainPaused: boolean;
  finalizePaused: boolean;
  nextInitiateIndex: string;
  nextFinalizeIndex: string;
  pending: {
    index: string;
    toToken: string;
    to: string;
    value: string;
    status: number;
  }[];
  trustAccountCodes: Record<string, string>;
  accountCode: string;
  // ONE only
  fees?: {
    minimum: string;
    networkFee: string;
    exFee: string;
    minimumAtAmount: string;
    networkFeeAtAmount: string;
    configMinimum: string;
    configNetworkFee: string;
    exFeeRate: string;
  };
  balance?: string;
  nonce?: string;
  // BSC only
  token?: {
    address: string;
    codeHash: string;
    decimals: number;
    balanceOfBridge: string;
    symbol: string;
    name: string;
  };
  finalizedBlock?: number;
}
export interface CallOutcome {
  ok: boolean;
  result?: string;
  error?: { code?: number; message?: string; data?: unknown } | string;
}
export interface NegativeRead {
  name: string;
  rejected: boolean;
  selector: string | null;
  errorName: string | null;
  decoded: string | null;
  expectedError: string;
  expectedSelector: string;
}
export interface SimulationRead {
  url: string;
  block: number;
  blockHash: string;
  blockHashAfter: string;
  ethCall: CallOutcome;
  estimateGas: CallOutcome;
  negatives: NegativeRead[];
  gasPrice: string;
  maxPriorityFeePerGas: string;
  baseFeePerGas: string;
}
export interface DriftScan {
  chain: "one" | "bsc";
  contract: string;
  from: number;
  to: number;
  complete: boolean;
  events: { event: string; block: number; tx: string }[];
}
export interface InFlight {
  enumerated: boolean;
  bscNextFinalize: string;
  oneNextInitiate: string;
  items: {
    index: string;
    found: number;
    value?: string;
    toToken?: string;
    tx?: string;
  }[];
}

// ---------------------------------------------------------------- quote, gas, exposure
export interface Quote {
  amount: bigint;
  networkFee: bigint;
  serviceFee: bigint;
  value: bigint;
  observedAt: number;
  expiresAt: number;
  sourceBlock: number;
  sourceBlockHash: string;
  sourceBlockTimestamp: number;
}
export function quoteFromFees(
  fees: NonNullable<SideRead["fees"]>,
  observedAt: number,
  side: Pick<SideRead, "block" | "blockHash" | "blockTimestamp">,
): Quote {
  const amount = BigInt(fees.minimum);
  const networkFee = BigInt(fees.networkFee);
  const serviceFee = BigInt(fees.exFee);
  return {
    amount,
    networkFee,
    serviceFee,
    value: amount + networkFee + serviceFee, // integer base units only
    observedAt,
    expiresAt: observedAt + QUOTE_MAX_AGE_MS,
    sourceBlock: side.block,
    sourceBlockHash: side.blockHash,
    sourceBlockTimestamp: side.blockTimestamp,
  };
}
export interface GasPlan {
  estimate: bigint;
  recommendedGasLimit: bigint;
  marginPercent: number;
  legacyGasPrice: bigint;
  baseFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  priceCap: bigint;
  estimatedGasCost: bigint;
  marginGasCost: bigint;
  maximumGasCost: bigint;
}
export function gasPlan(
  estimate: bigint,
  gasPrices: bigint[],
  priorityFees: bigint[],
  baseFeePerGas: bigint,
): GasPlan {
  if (estimate <= 21000n) throw new Error("ESTIMATE_IMPLAUSIBLE");
  const legacyGasPrice = gasPrices.reduce((a, b) => (a > b ? a : b));
  const maxPriorityFeePerGas = priorityFees.reduce((a, b) => (a > b ? a : b));
  // EIP-1559 cap: 2 x base fee of the pinned block + suggested tip (common wallet policy).
  const maxFeePerGas = 2n * baseFeePerGas + maxPriorityFeePerGas;
  const priceCap =
    legacyGasPrice > maxFeePerGas ? legacyGasPrice : maxFeePerGas;
  const recommendedGasLimit =
    (estimate * GAS_MARGIN.numerator + GAS_MARGIN.denominator - 1n) /
    GAS_MARGIN.denominator;
  return {
    estimate,
    recommendedGasLimit,
    marginPercent: Number(
      ((GAS_MARGIN.numerator - GAS_MARGIN.denominator) * 100n) /
        GAS_MARGIN.denominator,
    ),
    legacyGasPrice,
    baseFeePerGas,
    maxPriorityFeePerGas,
    maxFeePerGas,
    priceCap,
    estimatedGasCost: estimate * legacyGasPrice,
    marginGasCost: (recommendedGasLimit - estimate) * priceCap,
    maximumGasCost: recommendedGasLimit * priceCap,
  };
}
export function exposure(q: Quote, g: GasPlan) {
  return {
    principal: q.amount,
    bridgeNetworkFee: q.networkFee,
    serviceFee: q.serviceFee,
    otherbridgeFee: 0n,
    exactMsgValue: q.value,
    estimatedGasCost: g.estimatedGasCost,
    gasMarginCost: g.marginGasCost,
    maximumGasCost: g.maximumGasCost,
    maximumExpectedWalletDebit: q.value + g.maximumGasCost,
    // Exact G5-proven semantics: BSC finalize pays `value` (the principal); fees are paid separately on ONE.
    expectedDestinationPrincipal: q.amount,
  };
}
export function formatUnits18(v: bigint) {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / 10n ** 18n;
  const frac = (a % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

// ---------------------------------------------------------------- calldata
export interface PilotIntent {
  account: string;
  recipient: string;
  amount: bigint;
  networkFee: bigint;
  serviceFee: bigint;
}
export function encodePilotCalldata(i: PilotIntent): Hex {
  return encodeFunctionData({
    abi: bridgeAbi,
    functionName: "bridgeToken",
    args: [
      56n,
      NATIVE,
      i.recipient as Hex,
      i.amount,
      i.networkFee,
      i.serviceFee,
      "0x",
    ],
  });
}
export function decodedIntentView(d: DecodedBridgeToken) {
  return {
    function: "bridgeToken",
    selector: d.selector,
    toChainID: d.toChainID.toString(),
    fromToken: d.fromToken.toLowerCase(),
    to: d.to.toLowerCase(),
    value: d.value.toString(),
    networkFee: d.networkFee.toString(),
    exFee: d.exFee.toString(),
    extraData: d.extraData,
  };
}
export function verifyCalldata(data: string, i: PilotIntent) {
  const independent = encodeBridgeTokenIndependent({
    toChainID: 56n,
    fromToken: NATIVE,
    to: i.recipient,
    value: i.amount,
    networkFee: i.networkFee,
    exFee: i.serviceFee,
    extraData: "0x",
  });
  const decoded = decodeBridgeTokenIndependent(data);
  const viemDecoded = decodeFunctionData({ abi: bridgeAbi, data: data as Hex });
  const checks = {
    viemEqualsIndependentEncoding: data === independent,
    selector: decoded.selector === BRIDGE_TOKEN_SELECTOR,
    chain: decoded.toChainID === 56n,
    sourceToken: same(decoded.fromToken, NATIVE),
    recipient: same(decoded.to, i.recipient),
    amount: decoded.value === i.amount,
    networkFee: decoded.networkFee === i.networkFee,
    serviceFee: decoded.exFee === i.serviceFee,
    extraData: decoded.extraData === "0x",
    length260Bytes: (data.length - 2) / 2 === 260,
    viemDecodeAgrees:
      viemDecoded.functionName === "bridgeToken" &&
      viemDecoded.args[0] === decoded.toChainID &&
      same(viemDecoded.args[1], decoded.fromToken) &&
      same(viemDecoded.args[2], decoded.to) &&
      viemDecoded.args[3] === decoded.value &&
      viemDecoded.args[4] === decoded.networkFee &&
      viemDecoded.args[5] === decoded.exFee &&
      viemDecoded.args[6] === decoded.extraData,
  };
  return {
    calldata: data,
    calldataKeccak256: keccakHex(data),
    decoded: decodedIntentView(decoded),
    checks,
    ok: Object.values(checks).every(Boolean),
  };
}

// ---------------------------------------------------------------- firewall
// Prep-only candidate entry. It is NOT added to the production registry (which stays frozen empty) and its
// status is REVIEW_REQUIRED, so the production SimulationGate/routeHealth can never accept it.
export function g7ContractEntry(
  side: Pick<SideRead, "proxyCodeHash" | "implementationCodeHash" | "block">,
  verifiedAt: number,
): ContractEntry {
  return {
    chainId: "612055",
    protocol: "ONEbridge native ONE->BSC CROSS",
    provider: "to-nexus/bridge-contracts (CrossBridge @ b3b0258)",
    contract: G5_ROUTE_PINS.source.proxy,
    spender: null,
    token: NATIVE,
    selector: BRIDGE_TOKEN_SELECTOR,
    runtimeHash: side.proxyCodeHash,
    implementationHash: side.implementationCodeHash,
    verifiedAt,
    verifiedBlock: String(side.block),
    provenance: `G5 V1.6 exact build + G7 prep fresh pins (${G7_POLICY_VERSION})`,
    status: "REVIEW_REQUIRED",
  };
}
export function expectedFirewallIntent(
  q: Quote,
  quoteId: string,
  account = PILOT_EOA,
): ExpectedIntent {
  return {
    chainId: "612055",
    from: account,
    toContract: G5_ROUTE_PINS.source.proxy,
    value: q.value.toString(),
    calldataSelector: BRIDGE_TOKEN_SELECTOR,
    inputToken: NATIVE,
    inputAmount: q.amount.toString(),
    outputToken: CROSS,
    minimumOutput: q.amount.toString(),
    recipient: account,
    approvalSpender: null,
    approvalAmount: "0",
    platformFeeBps: 0,
    quoteId,
    expiresAt: q.expiresAt,
  };
}
// Trusted decoder = the independent codec + the pinned route mapping (56, native sentinel) -> canonical CROSS.
export const g7TrustedDecoder: TrustedDecoder = (data) => {
  const d = decodeBridgeTokenIndependent(data);
  if (d.toChainID !== 56n || !same(d.fromToken, NATIVE))
    throw new RoutingError("UNSUPPORTED_ROUTE");
  return {
    inputToken: d.fromToken,
    inputAmount: d.value.toString(),
    outputToken: CROSS,
    minimumOutput: d.value.toString(),
    recipient: d.to,
    approvalSpender: null,
    approvalAmount: "0",
    platformFeeBps: 0,
  };
};
export interface FirewallContext {
  entry: ContractEntry;
  quote: Quote;
  expectedCalldata: string;
  pinsDigestExpected: string;
  pinsDigestObserved: string;
  implementationHashObserved: string;
  platformFeeBps: number;
  approval: { spender: string | null; amount: string };
}
export interface FirewallVerdict {
  pass: boolean;
  reason: string | null;
  intentDigest?: string;
  transactionDigest?: string;
}
export function g7Firewall(
  tx: PreparedTransaction,
  expected: ExpectedIntent,
  ctx: FirewallContext,
  now: number,
): FirewallVerdict {
  try {
    // 1) existing Otherbridge transaction firewall (strict schemas, registry/intent/decoder binding, expiry)
    const digests = compareIntent(
      expected,
      tx,
      ctx.entry,
      g7TrustedDecoder,
      now,
    );
    // 2) G7 route-specific fields the generic intent does not carry
    const d = decodeBridgeTokenIndependent(tx.data);
    const fail = (code: string): FirewallVerdict => ({
      pass: false,
      reason: code,
    });
    if (ctx.platformFeeBps !== OTHERBRIDGE_PLATFORM_FEE_BPS)
      return fail("PLATFORM_FEE_NONZERO");
    if (ctx.approval.spender !== null || ctx.approval.amount !== "0")
      return fail("APPROVAL_NOT_ALLOWED_FOR_NATIVE_ROUTE");
    if (tx.chainId !== "612055") return fail("CHAIN_MISMATCH");
    if (!same(tx.to, G5_ROUTE_PINS.source.proxy))
      return fail("NOT_PINNED_PROXY");
    if (d.toChainID !== 56n) return fail("DESTINATION_CHAIN_MISMATCH");
    if (!same(d.to, tx.from)) return fail("RECIPIENT_NOT_SOURCE_EOA");
    if (d.value !== ctx.quote.amount) return fail("AMOUNT_MISMATCH");
    if (d.networkFee !== ctx.quote.networkFee)
      return fail("NETWORK_FEE_MISMATCH");
    if (d.exFee !== ctx.quote.serviceFee) return fail("SERVICE_FEE_MISMATCH");
    if (d.extraData !== "0x") return fail("EXTRA_DATA_NOT_EMPTY");
    if (BigInt(tx.value) !== d.value + d.networkFee + d.exFee)
      return fail("MSG_VALUE_NOT_EXACT");
    if (tx.data.toLowerCase() !== ctx.expectedCalldata.toLowerCase())
      return fail("CALLDATA_NOT_EXACT");
    if (ctx.pinsDigestObserved !== ctx.pinsDigestExpected)
      return fail("ROUTE_PINS_DRIFT");
    if (
      !same(
        ctx.implementationHashObserved,
        G5_ROUTE_PINS.source.implementationCodeHash,
      ) ||
      !same(
        ctx.entry.implementationHash,
        G5_ROUTE_PINS.source.implementationCodeHash,
      ) ||
      !same(ctx.entry.runtimeHash, G5_ROUTE_PINS.source.proxyCodeHash)
    )
      return fail("IMPLEMENTATION_HASH_DRIFT");
    if (
      now - ctx.quote.observedAt > QUOTE_MAX_AGE_MS ||
      now < ctx.quote.observedAt ||
      now >= ctx.quote.expiresAt
    )
      return fail("QUOTE_STALE");
    return { pass: true, reason: null, ...digests };
  } catch (e) {
    const code =
      e instanceof RoutingError
        ? e.code
        : e instanceof Error && "code" in e && typeof e.code === "string"
          ? e.code
          : e instanceof Error && e.name === "ZodError"
            ? "SCHEMA_REJECTED"
            : "REJECTED";
    return { pass: false, reason: code };
  }
}
// Adversarial mutations of the prepared payload / intent / context. Every one must be rejected.
export function firewallMutations(
  tx: PreparedTransaction,
  expected: ExpectedIntent,
  ctx: FirewallContext,
  intent: PilotIntent,
  now: number,
) {
  const reencode = (
    p: Partial<{
      chain: bigint;
      to: string;
      amount: bigint;
      networkFee: bigint;
      exFee: bigint;
      extra: string;
      token: string;
    }>,
  ) =>
    encodeBridgeTokenIndependent({
      toChainID: p.chain ?? 56n,
      fromToken: p.token ?? NATIVE,
      to: p.to ?? intent.recipient,
      value: p.amount ?? intent.amount,
      networkFee: p.networkFee ?? intent.networkFee,
      exFee: p.exFee ?? intent.serviceFee,
      extraData: p.extra ?? "0x",
    });
  const OTHER = "0x1111111111111111111111111111111111111111";
  const v = BigInt(tx.value);
  const cases: {
    name: string;
    tx?: PreparedTransaction;
    expected?: ExpectedIntent;
    ctx?: FirewallContext;
    now?: number;
  }[] = [
    {
      name: "to=BSC bridge proxy",
      tx: { ...tx, to: G5_ROUTE_PINS.destination.proxy },
    },
    {
      name: "to=ONE implementation (proxy bypass)",
      tx: { ...tx, to: G5_ROUTE_PINS.source.implementation },
    },
    { name: "to=unrelated address", tx: { ...tx, to: OTHER } },
    { name: "value+1wei", tx: { ...tx, value: (v + 1n).toString() } },
    { name: "value-1wei", tx: { ...tx, value: (v - 1n).toString() } },
    {
      name: "recipient=third party",
      tx: { ...tx, data: reencode({ to: OTHER }) },
    },
    {
      name: "recipient=BSC bridge (CBU-09)",
      tx: { ...tx, data: reencode({ to: G5_ROUTE_PINS.destination.proxy }) },
    },
    {
      name: "destinationChain=97",
      tx: { ...tx, data: reencode({ chain: 97n }) },
    },
    {
      name: "destinationChain=1",
      tx: { ...tx, data: reencode({ chain: 1n }) },
    },
    {
      name: "amount+1wei (value adjusted)",
      tx: {
        ...tx,
        value: (v + 1n).toString(),
        data: reencode({ amount: intent.amount + 1n }),
      },
    },
    {
      name: "amount-1wei (value unchanged)",
      tx: { ...tx, data: reencode({ amount: intent.amount - 1n }) },
    },
    {
      name: "networkFee-1wei (value adjusted)",
      tx: {
        ...tx,
        value: (v - 1n).toString(),
        data: reencode({ networkFee: intent.networkFee - 1n }),
      },
    },
    {
      name: "networkFee+1wei (value adjusted)",
      tx: {
        ...tx,
        value: (v + 1n).toString(),
        data: reencode({ networkFee: intent.networkFee + 1n }),
      },
    },
    {
      name: "serviceFee+1wei (value adjusted)",
      tx: {
        ...tx,
        value: (v + 1n).toString(),
        data: reencode({ exFee: intent.serviceFee + 1n }),
      },
    },
    {
      name: "selector flipped",
      tx: {
        ...tx,
        data:
          "0x" +
          (tx.data.slice(2, 4) === "ff" ? "fe" : "ff") +
          tx.data.slice(4),
      },
    },
    {
      name: "extraData=0x01",
      tx: { ...tx, data: reencode({ extra: "0x01" }) },
    },
    {
      name: "sourceToken=CROSS",
      tx: { ...tx, data: reencode({ token: CROSS }) },
    },
    { name: "trailing calldata byte", tx: { ...tx, data: tx.data + "00" } },
    { name: "chainId=56", tx: { ...tx, chainId: "56" } },
    { name: "from=other account", tx: { ...tx, from: OTHER } },
    {
      name: "platformFeeBps=1 (intent)",
      expected: { ...expected, platformFeeBps: 1 as unknown as 0 },
    },
    { name: "platformFeeBps=5 (context)", ctx: { ...ctx, platformFeeBps: 5 } },
    {
      name: "approval requested (spender=proxy)",
      expected: {
        ...expected,
        approvalSpender: G5_ROUTE_PINS.source.proxy,
        approvalAmount: expected.inputAmount,
      },
    },
    {
      name: "approval requested (context)",
      ctx: {
        ...ctx,
        approval: { spender: G5_ROUTE_PINS.source.proxy, amount: "1" },
      },
    },
    {
      name: "minimumOutput+1",
      expected: {
        ...expected,
        minimumOutput: (BigInt(expected.minimumOutput) + 1n).toString(),
      },
    },
    {
      name: "outputToken=wrapped substitute",
      expected: {
        ...expected,
        outputToken: "0x55d398326f99059ff775485246999027b3197955",
      },
    },
    { name: "quote expired (now=expiresAt)", now: ctx.quote.expiresAt },
    { name: "quote age>60s", now: ctx.quote.observedAt + QUOTE_MAX_AGE_MS + 1 },
    {
      name: "route pins digest drift",
      ctx: { ...ctx, pinsDigestObserved: "0".repeat(64) },
    },
    {
      name: "implementation hash drift",
      ctx: { ...ctx, implementationHashObserved: "0x" + "11".repeat(32) },
    },
    {
      name: "registry entry runtime hash drift",
      ctx: {
        ...ctx,
        entry: { ...ctx.entry, runtimeHash: "0x" + "22".repeat(32) },
      },
    },
  ];
  return cases.map((c) => {
    const verdict = g7Firewall(
      c.tx ?? tx,
      c.expected ?? expected,
      c.ctx ?? ctx,
      c.now ?? now,
    );
    return { name: c.name, rejected: !verdict.pass, reason: verdict.reason };
  });
}
// The production gate must stay closed: global kill ON, empty registry, execution disabled.
export function productionGateStaysClosed(
  tx: PreparedTransaction,
  expected: ExpectedIntent,
  entry: ContractEntry,
  now: number,
) {
  let gateResult = "ACCEPTED";
  try {
    new SimulationGate(killPolicy).review(
      expected,
      tx,
      entry,
      g7TrustedDecoder,
      {
        success: true,
        transactionDigest: "0".repeat(64),
        intentDigest: "0".repeat(64),
        chainId: "612055",
        block: entry.verifiedBlock,
        observedAt: now,
        registryDigest: entryDigest(entry),
      },
      now,
    );
  } catch (e) {
    gateResult = e instanceof RoutingError ? e.code : "REJECTED";
  }
  return {
    globalExecutionEnabled: GLOBAL_EXECUTION_ENABLED,
    killPolicyGlobal: killPolicy.global,
    productionRegistryEntries: contractRegistry.length,
    productionSimulationGate: gateResult,
    closed:
      GLOBAL_EXECUTION_ENABLED === false &&
      killPolicy.global === true &&
      contractRegistry.length === 0 &&
      gateResult === "EXECUTION_PAUSED",
  };
}

// ---------------------------------------------------------------- pins digest
export function routePinsView(one: SideRead, bsc: SideRead) {
  const roles = (r: Record<string, string[]>) =>
    Object.fromEntries(
      ROLE_NAMES.map((n) => [
        n,
        (r[n] ?? []).map((a) => a.toLowerCase()).sort(),
      ]),
    );
  const side = (s: SideRead) => ({
    chainId: s.chainId,
    proxyCodeHash: s.proxyCodeHash.toLowerCase(),
    implementation: s.implementation.toLowerCase(),
    implementationCodeHash: s.implementationCodeHash.toLowerCase(),
    adminSlot: s.adminSlot.toLowerCase(),
    beaconSlot: s.beaconSlot.toLowerCase(),
    verifier: s.verifier.toLowerCase(),
    verifierCodeHash: s.verifierCodeHash.toLowerCase(),
    threshold: s.threshold,
    executor: s.executor.toLowerCase(),
    dev: s.dev.toLowerCase(),
    maxExtraDataLength: s.maxExtraDataLength,
    bridgeRoles: roles(s.bridgeRoles),
    verifierRoles: roles(s.verifierRoles),
    verifierThresholds: s.verifierThresholds,
    priceFeed: s.priceFeed.toLowerCase(),
    feeDenominator: s.feeDenominator,
    pair: {
      localToken: s.pair.localToken.toLowerCase(),
      remoteToken: s.pair.remoteToken.toLowerCase(),
      isOrigin: s.pair.isOrigin,
    },
  });
  return {
    one: side(one),
    bsc: {
      ...side(bsc),
      tokenCodeHash: bsc.token?.codeHash.toLowerCase() ?? null,
      tokenDecimals: bsc.token?.decimals ?? null,
    },
  };
}
// The pinned expectation (G5 pins + extended G7 pins), in the same shape as routePinsView.
export function expectedPinsView() {
  const s = G5_ROUTE_PINS.source,
    d = G5_ROUTE_PINS.destination;
  const roles = (r: Record<string, readonly string[]>) =>
    Object.fromEntries(
      ROLE_NAMES.map((n) => [
        n,
        [...(r[n] ?? [])].map((a) => a.toLowerCase()).sort(),
      ]),
    );
  const side = (
    p: typeof s | typeof d,
    e: (typeof EXTENDED_PINS)["one"] | (typeof EXTENDED_PINS)["bsc"],
  ) => ({
    chainId: p.chainId,
    proxyCodeHash: p.proxyCodeHash,
    implementation: p.implementation,
    implementationCodeHash: p.implementationCodeHash,
    adminSlot: e.adminSlot,
    beaconSlot: e.beaconSlot,
    verifier: p.verifier,
    verifierCodeHash: p.verifierCodeHash,
    threshold: p.settlement.threshold,
    executor: e.executor,
    dev: e.dev,
    maxExtraDataLength: e.maxExtraDataLength,
    bridgeRoles: roles(e.bridgeRoles),
    verifierRoles: roles(e.verifierRoles),
    verifierThresholds: e.verifierThresholds,
    priceFeed: e.priceFeed,
    feeDenominator: e.feeDenominator,
    pair: {
      localToken: p.pair.localToken.toLowerCase(),
      remoteToken: p.pair.remoteToken.toLowerCase(),
      isOrigin: p.pair.isOrigin,
    },
  });
  return {
    one: side(s, EXTENDED_PINS.one),
    bsc: {
      ...side(d, EXTENDED_PINS.bsc),
      tokenCodeHash: d.tokenCodeHash,
      tokenDecimals: EXTENDED_PINS.bsc.tokenDecimals,
    },
  };
}
export const pinsDigest = (view: unknown) => sha256Hex(canonicalJson(view));

// ---------------------------------------------------------------- gates
export type GateStatus = "PASS" | "FAIL" | "OWNER_REAPPROVAL_REQUIRED";
export interface Gate {
  id: string;
  name: string;
  status: GateStatus;
  reasons: string[];
}
export interface G5DecisionCheck {
  decisionStatus: string;
  decisionFileSha256Matches: boolean;
  manifestFilesVerified: number;
  manifestFilesTotal: number;
  g5StatusConstant: string;
  decisionPinsMatchRoutePins: boolean;
}
export interface WriteSafety {
  execution: ExecutionSnapshot;
  rpcMethodsUsed: Record<string, number>;
  forbiddenMethodCalls: number;
  stateOverrideCalls: number;
  staticScanPass: boolean;
  protectedBaselinePass: boolean;
  gate: ReturnType<typeof productionGateStaysClosed>;
  feePolicyEnabled: boolean;
  feePolicyBps: number;
}
export interface PrepInput {
  g5: G5DecisionCheck;
  one: SideRead[];
  bsc: SideRead[];
  driftScans: DriftScan[];
  ledger: LedgerDeltaResult;
  inFlight: InFlight;
  reserve: ReserveResult;
  bscBlockFinalized: boolean;
  simulations: SimulationRead[];
  quote: Quote;
  gas: GasPlan;
  intent: PilotIntent;
  calldata: ReturnType<typeof verifyCalldata>;
  selectorInLiveDispatcher: boolean;
  firewall: {
    positive: FirewallVerdict;
    mutations: { name: string; rejected: boolean; reason: string | null }[];
  };
  writeSafety: WriteSafety;
  decisionAt: number;
}

const ABI_TRUE = "0x" + "0".repeat(63) + "1";
const strip = (s: SideRead) => {
  const { url, ...rest } = s;
  void url;
  return canonicalJson(rest);
};
const roleSetEq = (a: readonly string[] | undefined, b: readonly string[]) =>
  [...(a ?? [])]
    .map((x) => x.toLowerCase())
    .sort()
    .join(",") ===
  [...b]
    .map((x) => x.toLowerCase())
    .sort()
    .join(",");

export function observedRoute(one: SideRead, bsc: SideRead): ObservedRoute {
  const trust = (s: SideRead) => ({
    threshold: s.threshold,
    validators: s.bridgeRoles.VALIDATOR_ROLE ?? [],
    admins: [
      ...new Set(
        [
          ...(s.bridgeRoles.DEFAULT_ADMIN_ROLE ?? []),
          ...(s.bridgeRoles.ADMIN_ROLE ?? []),
        ].map((a) => a.toLowerCase()),
      ),
    ],
    verifierRole: s.bridgeRoles.VERIFIER_ROLE ?? [],
  });
  const side = (s: SideRead) => ({
    chainId: s.chainId,
    trust: trust(s),
    proxyCodeHash: s.proxyCodeHash,
    implementation: s.implementation,
    implementationCodeHash: s.implementationCodeHash,
    verifier: s.verifier,
    verifierCodeHash: s.verifierCodeHash,
    pair: {
      localToken: s.pair.localToken,
      remoteToken: s.pair.remoteToken,
      isOrigin: s.pair.isOrigin,
      paused: s.pair.paused,
    },
    paused: s.paused || s.chainPaused,
    finalizePaused: s.finalizePaused,
  });
  return {
    source: side(one),
    destination: { ...side(bsc), tokenCodeHash: bsc.token?.codeHash ?? "0x" },
  };
}

export function evaluateGates(i: PrepInput): {
  status: PrepStatus;
  gates: Gate[];
  blockedReasons: string[];
} {
  const gates: Gate[] = [];
  const add = (
    id: string,
    name: string,
    reasons: string[],
    reapproval: string[] = [],
  ) =>
    gates.push({
      id,
      name,
      status: reasons.length
        ? "FAIL"
        : reapproval.length
          ? "OWNER_REAPPROVAL_REQUIRED"
          : "PASS",
      reasons: [...reasons, ...reapproval],
    });
  const one = i.one[0],
    bsc = i.bsc[0];
  const haveBoth =
    i.one.length === 2 && i.bsc.length === 2 && i.simulations.length === 2;
  const drift = one && bsc ? evaluateRouteDrift(observedRoute(one, bsc)) : null;
  const driftReasons = drift?.state === "REVIEW_REQUIRED" ? drift.reasons : [];
  const events = (chain: "one" | "bsc", re: RegExp) =>
    i.driftScans
      .filter((s) => s.chain === chain)
      .flatMap((s) => s.events.filter((e) => re.test(e.event)));
  const scansComplete =
    i.driftScans.length >= 2 && i.driftScans.every((s) => s.complete);

  // P1
  {
    const r: string[] = [];
    if (i.g5.decisionStatus !== "PASS") r.push("G5_DECISION_NOT_PASS");
    if (!i.g5.decisionFileSha256Matches) r.push("G5_DECISION_FILE_MODIFIED");
    if (
      i.g5.manifestFilesVerified !== i.g5.manifestFilesTotal ||
      i.g5.manifestFilesTotal === 0
    )
      r.push("G5_MANIFEST_MISMATCH");
    if (i.g5.g5StatusConstant !== "PASS") r.push("G5_STATUS_CONSTANT_NOT_PASS");
    if (!i.g5.decisionPinsMatchRoutePins)
      r.push("G5_DECISION_PINS_DIFFER_FROM_ROUTE_PINS");
    add("P1", "G5_CURRENT_DECISION_STILL_VALID", r);
  }
  // P2 / P3 runtime
  const runtime = (
    name: "SOURCE" | "DESTINATION",
    reads: SideRead[],
    pins: typeof G5_ROUTE_PINS.source | typeof G5_ROUTE_PINS.destination,
    ext: (typeof EXTENDED_PINS)["one"] | (typeof EXTENDED_PINS)["bsc"],
    chain: "one" | "bsc",
  ) => {
    const r: string[] = [];
    if (reads.length !== 2) r.push(`${name}_READS_MISSING`);
    for (const s of reads) {
      if (s.chainId !== pins.chainId) r.push(`${name}_CHAIN_MISMATCH`);
      if (
        !same("0x" + s.implementationSlot.slice(-40), pins.implementation) ||
        !same(s.implementation, pins.implementation)
      )
        r.push(`${name}_IMPLEMENTATION_CHANGED`);
      if (!/^0x0{24}/.test(s.implementationSlot))
        r.push(`${name}_IMPLEMENTATION_SLOT_DIRTY`);
      if (!same(s.implementationCodeHash, pins.implementationCodeHash))
        r.push(`${name}_IMPLEMENTATION_CODE_CHANGED`);
      if (!same(s.proxyCodeHash, pins.proxyCodeHash))
        r.push(`${name}_PROXY_CODE_CHANGED`);
      if (
        !same(s.adminSlot, ext.adminSlot) ||
        !same(s.beaconSlot, ext.beaconSlot)
      )
        r.push(`${name}_PROXY_ADMIN_OR_BEACON_SLOT_CHANGED`);
      if (!same(s.verifier, pins.verifier)) r.push(`${name}_VERIFIER_CHANGED`);
      if (!same(s.verifierCodeHash, pins.verifierCodeHash))
        r.push(`${name}_VERIFIER_CODE_CHANGED`);
    }
    if (chain === "bsc")
      for (const s of reads) {
        if (!s.token || !same(s.token.address, G5_ROUTE_PINS.destination.token))
          r.push("DESTINATION_TOKEN_ADDRESS_MISMATCH");
        if (
          !s.token ||
          !same(s.token.codeHash, G5_ROUTE_PINS.destination.tokenCodeHash)
        )
          r.push("DESTINATION_TOKEN_CODE_CHANGED");
      }
    r.push(
      ...driftReasons.filter(
        (x) =>
          x.startsWith(name) &&
          /IMPLEMENTATION|PROXY|VERIFIER_CODE|TOKEN_CODE|CHAIN/.test(x),
      ),
    );
    if (!scansComplete) r.push(`${name}_DRIFT_EVENT_SCAN_INCOMPLETE`);
    for (const e of events(
      chain,
      /^(Upgraded|AdminChanged|BeaconUpgraded|Initialized)\(/,
    ))
      r.push(`${name}_UPGRADE_EVENT_${e.event.split("(")[0]}@${e.block}`);
    return [...new Set(r)];
  };
  add(
    "P2",
    "SOURCE_RUNTIME_DRIFT_FREE",
    runtime("SOURCE", i.one, G5_ROUTE_PINS.source, EXTENDED_PINS.one, "one"),
  );
  add(
    "P3",
    "DESTINATION_RUNTIME_DRIFT_FREE",
    runtime(
      "DESTINATION",
      i.bsc,
      G5_ROUTE_PINS.destination,
      EXTENDED_PINS.bsc,
      "bsc",
    ),
  );
  // P4 authority
  {
    const r: string[] = [];
    r.push(
      ...driftReasons.filter((x) =>
        /THRESHOLD|VALIDATORS|ADMINS|VERIFIER_ROLE|VERIFIER_CHANGED/.test(x),
      ),
    );
    for (const [name, reads, ext] of [
      ["SOURCE", i.one, EXTENDED_PINS.one],
      ["DESTINATION", i.bsc, EXTENDED_PINS.bsc],
    ] as const)
      for (const s of reads) {
        for (const role of ROLE_NAMES) {
          if (!roleSetEq(s.bridgeRoles[role], ext.bridgeRoles[role]))
            r.push(`${name}_BRIDGE_${role}_CHANGED`);
          if (!roleSetEq(s.verifierRoles[role], ext.verifierRoles[role]))
            r.push(`${name}_VERIFIER_${role}_CHANGED`);
        }
        if (!same(s.dev, ext.dev)) r.push(`${name}_DEV_FEE_RECIPIENT_CHANGED`);
        if (!same(s.executor, ext.executor)) r.push(`${name}_EXECUTOR_CHANGED`);
        if (!same(s.priceFeed, ext.priceFeed))
          r.push(`${name}_PRICE_FEED_CHANGED`);
        for (const a of TRUST_ACCOUNTS)
          if (s.trustAccountCodes[a.toLowerCase()] !== "0x")
            r.push(`${name}_TRUST_ACCOUNT_NOT_PLAIN_EOA_${a}`);
      }
    for (const chain of ["one", "bsc"] as const)
      for (const e of events(
        chain,
        /^(RoleGranted|RoleRevoked|RoleAdminChanged|ThresholdChanged|BridgeVerifierSet|DevSet|BridgeExecutorSet|EIP712DomainChanged)\(/,
      ))
        r.push(
          `${chain.toUpperCase()}_AUTHORITY_EVENT_${e.event.split("(")[0]}@${e.block}`,
        );
    if (!scansComplete) r.push("AUTHORITY_EVENT_SCAN_INCOMPLETE");
    add("P4", "AUTHORITY_SET_DRIFT_FREE", [...new Set(r)]);
  }
  // P5 route registration
  {
    const r: string[] = [];
    r.push(...driftReasons.filter((x) => /PAIR_CHANGED/.test(x)));
    for (const s of i.one) {
      if (
        !same(s.pair.localToken, NATIVE) ||
        !same(s.pair.remoteToken, CROSS) ||
        s.pair.isOrigin !== false
      )
        r.push("SOURCE_PAIR_INVALID");
      if (s.maxExtraDataLength !== EXTENDED_PINS.one.maxExtraDataLength)
        r.push("SOURCE_MAX_EXTRA_DATA_CHANGED");
    }
    for (const s of i.bsc) {
      if (
        !same(s.pair.localToken, CROSS) ||
        !same(s.pair.remoteToken, NATIVE) ||
        s.pair.isOrigin !== true
      )
        r.push("DESTINATION_PAIR_INVALID");
      if (s.token?.decimals !== EXTENDED_PINS.bsc.tokenDecimals)
        r.push("DESTINATION_TOKEN_DECIMALS_NOT_18");
      if (s.maxExtraDataLength !== EXTENDED_PINS.bsc.maxExtraDataLength)
        r.push("DESTINATION_MAX_EXTRA_DATA_CHANGED");
    }
    for (const chain of ["one", "bsc"] as const)
      for (const e of events(
        chain,
        /^(TokenPairRegistered|TokenPairUnregistered|CrossMintableERC20CodeSet|MaxExtraDataLengthSet|PostCallGasReserveSet)\(/,
      ))
        r.push(
          `${chain.toUpperCase()}_ROUTE_EVENT_${e.event.split("(")[0]}@${e.block}`,
        );
    add("P5", "ROUTE_REGISTRATION_VALID", [...new Set(r)]);
  }
  // P6 pause / circuit breakers
  {
    const r: string[] = [];
    if (drift?.state === "PAUSED") r.push(...drift.reasons);
    for (const [name, reads, ext] of [
      ["SOURCE", i.one, EXTENDED_PINS.one],
      ["DESTINATION", i.bsc, EXTENDED_PINS.bsc],
    ] as const)
      for (const s of reads) {
        if (s.paused) r.push(`${name}_GLOBAL_PAUSED`);
        if (s.chainPaused) r.push(`${name}_CHAIN_PAUSED`);
        if (s.pair.paused) r.push(`${name}_PAIR_PAUSED`);
        if (s.finalizePaused) r.push(`${name}_FINALIZE_PAUSED`);
        if (
          canonicalJson(s.verifierThresholds) !==
          canonicalJson(ext.verifierThresholds)
        )
          r.push(`${name}_CIRCUIT_BREAKER_CONFIG_CHANGED`);
      }
    for (const chain of ["one", "bsc"] as const)
      for (const e of events(
        chain,
        /^(Paused|Unpaused|TokenPauseSet|ChainPauseSet|VerificationDelaySet|VerificationDelayExpirationSet)\(/,
      ))
        r.push(
          `${chain.toUpperCase()}_PAUSE_EVENT_${e.event.split("(")[0]}@${e.block}`,
        );
    add("P6", "ROUTE_UNPAUSED", [...new Set(r)]);
  }
  // P7 fees / minimum (re-approval when exposure increased versus the reference the owner saw)
  {
    const r: string[] = [],
      re: string[] = [];
    const f = one?.fees;
    if (!f) r.push("FEES_NOT_READ");
    else {
      for (const s of i.one)
        if (canonicalJson(s.fees) !== canonicalJson(f))
          r.push("FEE_READS_DISAGREE");
      if (BigInt(f.minimum) <= 0n) r.push("MINIMUM_NOT_POSITIVE");
      if (
        f.minimumAtAmount !== f.minimum ||
        f.networkFeeAtAmount !== f.networkFee
      )
        r.push("FEE_FUNCTION_INCONSISTENT");
      if (
        BigInt(f.exFee) !==
        (BigInt(f.minimum) * BigInt(f.exFeeRate)) / BigInt(one.feeDenominator)
      )
        r.push("SERVICE_FEE_FORMULA_MISMATCH");
      if (i.quote.amount !== BigInt(f.minimum))
        r.push("PILOT_AMOUNT_NOT_LIVE_MINIMUM");
      if (
        i.quote.networkFee !== BigInt(f.networkFee) ||
        i.quote.serviceFee !== BigInt(f.exFee)
      )
        r.push("QUOTE_NOT_FROM_LIVE_FEES");
      if (
        i.quote.value !==
        i.quote.amount + i.quote.networkFee + i.quote.serviceFee
      )
        r.push("VALUE_NOT_INTEGER_SUM");
      if (i.quote.sourceBlock !== one.block)
        r.push("QUOTE_BLOCK_NOT_PINNED_BLOCK");
      if (i.quote.amount > REFERENCE.minimum)
        re.push("MINIMUM_INCREASED_ABOVE_5_ONE_REFERENCE");
      if (
        i.quote.networkFee + i.quote.serviceFee >
        REFERENCE.networkFee + REFERENCE.serviceFee
      )
        re.push("FEES_INCREASED_ABOVE_0_18_ONE_REFERENCE");
      if (i.quote.value > REFERENCE.msgValue)
        re.push("MSG_VALUE_ABOVE_5_18_ONE_REFERENCE");
    }
    add("P7", "FEE_AND_MINIMUM_FRESH", [...new Set(r)], [...new Set(re)]);
  }
  // P8 reserve
  {
    const r: string[] = [];
    if (!i.ledger.reconciled)
      r.push(
        ...Object.entries(i.ledger.checks)
          .filter(([, v]) => !v)
          .map(([k]) => `LEDGER_${k}`),
      );
    if (!i.reserve.verified)
      r.push(
        ...i.reserve.reasons.map((x) => `RESERVE_${x}`),
        "RESERVE_NOT_VERIFIED",
      );
    if (!i.inFlight.enumerated) r.push("IN_FLIGHT_NOT_ENUMERATED");
    if (i.reserve.spendable < i.quote.amount)
      r.push("SPENDABLE_BELOW_PILOT_AMOUNT");
    if (i.reserve.effectiveMaximum < i.quote.amount)
      r.push("EFFECTIVE_MAXIMUM_BELOW_PILOT_AMOUNT");
    if (!i.bscBlockFinalized) r.push("BSC_RESERVE_PIN_NOT_FINALIZED");
    if (bsc && i.ledger.to !== bsc.block) r.push("LEDGER_NOT_AT_RESERVE_PIN");
    add("P8", "RESERVE_FRESH_AND_VERIFIED", [...new Set(r)]);
  }
  // P9 pending obligations (conservative: any valued active CROSS pending record blocks)
  {
    const r: string[] = [];
    for (const s of i.bsc) {
      const valued = s.pending.filter(
        (p) => same(p.toToken, CROSS) && BigInt(p.value) > 0n,
      );
      if (valued.length)
        r.push(
          `VALUED_ACTIVE_PENDING_CROSS:${valued.map((p) => p.index).join(",")}`,
        );
      if (BigInt(s.pair.pendingAmount) !== 0n) r.push("PENDING_AMOUNT_NONZERO");
    }
    add("P9", "PENDING_OBLIGATIONS_ACCEPTABLE", [...new Set(r)]);
  }
  // P10 source EOA
  {
    const r: string[] = [];
    if (!same(i.intent.account, PILOT_EOA))
      r.push("SOURCE_NOT_OWNER_SUPPLIED_EOA");
    if (
      !/^0x[0-9a-fA-F]{40}$/.test(i.intent.account) ||
      same(i.intent.account, ZERO)
    )
      r.push("SOURCE_ADDRESS_INVALID");
    if (isBridgeContract(i.intent.account)) r.push("SOURCE_IS_KNOWN_CONTRACT");
    for (const s of i.one)
      if (s.accountCode !== "0x") r.push("SOURCE_HAS_CODE_ON_ONE");
    add("P10", "SOURCE_EOA_VALID", [...new Set(r)]);
  }
  // P11 funded
  {
    const r: string[] = [];
    const balances = new Set(i.one.map((s) => s.balance));
    if (balances.size !== 1 || !one?.balance)
      r.push("BALANCE_READS_DISAGREE_OR_MISSING");
    else if (BigInt(one.balance) < i.quote.value + i.gas.maximumGasCost)
      r.push("INSUFFICIENT_BALANCE_FOR_VALUE_PLUS_GAS_BUDGET");
    add("P11", "SOURCE_EOA_FUNDED", r);
  }
  // P12 recipient
  {
    const r: string[] = [];
    if (!same(i.intent.recipient, i.intent.account))
      r.push("RECIPIENT_NOT_SOURCE_EOA");
    if (same(i.intent.recipient, ZERO)) r.push("RECIPIENT_ZERO");
    if (isBridgeContract(i.intent.recipient))
      r.push("RECIPIENT_IS_BRIDGE_TOKEN_OR_VERIFIER");
    for (const s of i.bsc)
      if (s.accountCode !== "0x") r.push("RECIPIENT_HAS_CODE_ON_BSC");
    add("P12", "RECIPIENT_VALID", [...new Set(r)]);
  }
  // P13 calldata
  {
    const r = Object.entries(i.calldata.checks)
      .filter(([, v]) => !v)
      .map(([k]) => `CALLDATA_${k}`);
    if (!i.selectorInLiveDispatcher) r.push("SELECTOR_NOT_IN_LIVE_DISPATCHER");
    add("P13", "UNSIGNED_CALLDATA_EXACT", r);
  }
  // P14 / P15 / P16 simulation
  {
    const r: string[] = [];
    for (const s of i.simulations)
      if (!s.ethCall.ok || s.ethCall.result !== ABI_TRUE)
        r.push(`ETH_CALL_NOT_TRUE@${s.url}`);
    if (!haveBoth) r.push("ETH_CALL_SINGLE_SOURCE");
    add("P14", "ETH_CALL_POSITIVE", r);
  }
  {
    const r: string[] = [];
    for (const s of i.simulations)
      if (!s.estimateGas.ok || !s.estimateGas.result)
        r.push(`ESTIMATE_GAS_FAILED@${s.url}`);
    if (new Set(i.simulations.map((s) => s.estimateGas.result)).size !== 1)
      r.push("ESTIMATE_GAS_DISAGREE");
    if (
      i.gas.estimate !== BigInt(i.simulations[0]?.estimateGas.result ?? "0x0")
    )
      r.push("GAS_PLAN_NOT_FROM_ESTIMATE");
    add("P15", "ESTIMATE_GAS_POSITIVE", r);
  }
  {
    const r: string[] = [];
    for (const s of i.simulations) {
      if (s.negatives.length !== NEGATIVE_CONTROLS.length)
        r.push(`NEGATIVE_CONTROLS_INCOMPLETE@${s.url}`);
      for (const n of s.negatives)
        if (
          !n.rejected ||
          n.errorName !== n.expectedError ||
          n.selector !== n.expectedSelector
        )
          r.push(`NEGATIVE_CONTROL_UNEXPECTED:${n.name}@${s.url}`);
    }
    add("P16", "NEGATIVE_CONTROLS_PASS", r);
  }
  // P17 firewall
  {
    const r: string[] = [];
    if (!i.firewall.positive.pass)
      r.push(`FIREWALL_POSITIVE_REJECTED:${i.firewall.positive.reason}`);
    for (const m of i.firewall.mutations)
      if (!m.rejected) r.push(`MUTATION_ACCEPTED:${m.name}`);
    if (i.firewall.mutations.length < 10) r.push("MUTATION_SUITE_TOO_SMALL");
    add("P17", "TRANSACTION_FIREWALL_PASS", r);
  }
  // P18 dual RPC consensus
  {
    const r: string[] = [];
    if (!haveBoth) r.push("DUAL_SOURCES_MISSING");
    if (i.one.length === 2 && strip(i.one[0]) !== strip(i.one[1]))
      r.push("ONE_ENDPOINTS_DISAGREE");
    if (i.bsc.length === 2 && strip(i.bsc[0]) !== strip(i.bsc[1]))
      r.push("BSC_SOURCES_DISAGREE");
    if (i.simulations.length === 2) {
      const [a, b] = i.simulations;
      if (
        canonicalJson([
          a.block,
          a.blockHash,
          a.ethCall,
          a.estimateGas,
          a.negatives,
        ]) !==
        canonicalJson([
          b.block,
          b.blockHash,
          b.ethCall,
          b.estimateGas,
          b.negatives,
        ])
      )
        r.push("SIMULATIONS_DISAGREE");
      for (const s of i.simulations)
        if (s.blockHash !== s.blockHashAfter || s.blockHash !== one?.blockHash)
          r.push(`PINNED_BLOCK_HASH_CHANGED@${s.url}`);
    }
    add("P18", "DUAL_RPC_CONSENSUS_PASS", [...new Set(r)]);
  }
  // P19 quote freshness at artifact creation
  {
    const r: string[] = [];
    const age = i.decisionAt - i.quote.observedAt;
    if (age > QUOTE_MAX_AGE_MS || age < 0) r.push(`QUOTE_AGE_${age}MS`);
    if (i.decisionAt >= i.quote.expiresAt) r.push("QUOTE_EXPIRED");
    if (i.decisionAt - i.quote.sourceBlockTimestamp * 1000 > QUOTE_MAX_AGE_MS)
      r.push("SOURCE_BLOCK_OLDER_THAN_60S");
    add("P19", "QUOTE_FRESHNESS_PASS", r);
  }
  // P20 reports execution evidence only. Release/configuration checks remain independently blocking below.
  {
    const r: string[] = noWriteReasons(i.writeSafety.execution);
    const w = i.writeSafety;
    if (w.forbiddenMethodCalls !== 0) r.push("FORBIDDEN_RPC_METHOD_USED");
    add("P20", "NO_WRITE_PATH_EXECUTED", r);
  }
  {
    const r: string[] = [];
    const w = i.writeSafety;
    if (w.stateOverrideCalls !== 0 || w.execution.stateOverrides !== 0)
      r.push("STATE_OVERRIDE_USED");
    if (w.protectedBaselinePass !== true)
      r.push(
        w.protectedBaselinePass === false
          ? "PROTECTED_BASELINE_MISMATCH"
          : "PROTECTED_BASELINE_EVIDENCE_MISSING_OR_INVALID",
      );
    if (!w.staticScanPass) r.push("STATIC_SAFETY_SCAN_FAILED");
    if (!w.gate.closed) r.push("PRODUCTION_EXECUTION_GATE_NOT_CLOSED");
    if (w.feePolicyEnabled || w.feePolicyBps !== 0)
      r.push("FEE_COLLECTION_ENABLED");
    add("R1", "RELEASE_SECURITY_CONTROLS_PASS", r);
  }
  const failed = gates.filter((g) => g.status === "FAIL");
  const reapproval = gates.filter(
    (g) => g.status === "OWNER_REAPPROVAL_REQUIRED",
  );
  const status: PrepStatus = failed.length
    ? "BLOCKED"
    : reapproval.length
      ? "OWNER_REAPPROVAL_REQUIRED"
      : "READY_FOR_OWNER_SIGNATURE";
  const blockedReasons = failed.map((g) => {
    const code =
      g.id === "P2" || g.id === "P3"
        ? "BLOCKED_RUNTIME_DRIFT"
        : g.id === "P4"
          ? "BLOCKED_AUTHORITY_DRIFT"
          : `BLOCKED_${g.name}`;
    return `${code} (${g.id}: ${g.reasons.join("; ")})`;
  });
  return { status, gates, blockedReasons };
}

// ---------------------------------------------------------------- intent digest
// The owner-visible intent is derived ONLY from the unsigned package itself (calldata re-decoded independently),
// so anyone can recompute the digest from G7_UNSIGNED_TRANSACTION.json right before signing and detect mutation.
export interface UnsignedPackageLike {
  chainId: number;
  from: string;
  to: string;
  value: string;
  data: string;
  decodedIntent: Record<string, unknown>;
  gasEstimate: string;
  recommendedGasLimit: string;
  feeModel: {
    baseFeePerGas: string;
    maxPriorityFeePerGas: string;
    maxFeePerGas: string;
    legacyGasPrice: string;
    gasMarginPercent: number;
  };
  quoteObservedAt: string;
  quoteExpiresAt: string;
  sourceBlock: { number: number; hash: string };
  routePins: {
    source: Record<string, unknown>;
    destination: Record<string, unknown>;
    authority: {
      one: { threshold: number; bridgeRoles: Record<string, string[]> };
      bsc: { threshold: number; bridgeRoles: Record<string, string[]> };
    };
  };
  approval: { required: boolean; spender: string | null; amount: string };
  otherbridgeFee: { bps: number; amount: string };
  trustModelAccepted: boolean;
}
export function normalizedOwnerIntent(pkg: UnsignedPackageLike) {
  const d = decodeBridgeTokenIndependent(pkg.data);
  const view = decodedIntentView(d);
  for (const [k, v] of Object.entries(view))
    if (String(pkg.decodedIntent[k]).toLowerCase() !== String(v).toLowerCase())
      throw new Error(`DECODED_INTENT_FIELD_MISMATCH ${k}`);
  const trust = (a: {
    threshold: number;
    bridgeRoles: Record<string, string[]>;
  }) => ({
    threshold: a.threshold,
    validators: [...(a.bridgeRoles.VALIDATOR_ROLE ?? [])]
      .map((x) => x.toLowerCase())
      .sort(),
    admins: [
      ...new Set(
        [
          ...(a.bridgeRoles.DEFAULT_ADMIN_ROLE ?? []),
          ...(a.bridgeRoles.ADMIN_ROLE ?? []),
        ].map((x) => x.toLowerCase()),
      ),
    ].sort(),
    verifierRole: [...(a.bridgeRoles.VERIFIER_ROLE ?? [])]
      .map((x) => x.toLowerCase())
      .sort(),
  });
  const lc = (x: unknown) => (typeof x === "string" ? x.toLowerCase() : x);
  const s = pkg.routePins.source,
    t = pkg.routePins.destination;
  return {
    schema: "otherbridge.g7.owner-intent.v2",
    chainId: pkg.chainId,
    destinationChainId: Number(d.toChainID),
    from: pkg.from.toLowerCase(),
    to: pkg.to.toLowerCase(),
    recipient: d.to.toLowerCase(),
    source: {
      proxy: lc(s.proxy),
      proxyCodeHash: lc(s.proxyCodeHash),
      implementation: lc(s.implementation),
      implementationCodeHash: lc(s.implementationCodeHash),
      verifier: lc(s.verifier),
      verifierCodeHash: lc(s.verifierCodeHash),
      trust: trust(pkg.routePins.authority.one),
    },
    destination: {
      proxy: lc(t.proxy),
      proxyCodeHash: lc(t.proxyCodeHash),
      implementation: lc(t.implementation),
      implementationCodeHash: lc(t.implementationCodeHash),
      token: lc(t.token),
      tokenCodeHash: lc(t.tokenCodeHash),
      trust: trust(pkg.routePins.authority.bsc),
    },
    sourceToken: d.fromToken.toLowerCase(),
    amount: d.value.toString(),
    networkFee: d.networkFee.toString(),
    serviceFee: d.exFee.toString(),
    extraData: d.extraData,
    otherbridgeFee: pkg.otherbridgeFee.amount,
    otherbridgeFeeBps: pkg.otherbridgeFee.bps,
    value: BigInt(pkg.value).toString(),
    selector: d.selector,
    calldataKeccak256: keccakHex(pkg.data.toLowerCase()),
    gasPolicy: {
      estimate: pkg.gasEstimate,
      marginPercent: pkg.feeModel.gasMarginPercent,
      recommendedGasLimit: pkg.recommendedGasLimit,
      legacyGasPrice: pkg.feeModel.legacyGasPrice,
      baseFeePerGas: pkg.feeModel.baseFeePerGas,
      maxPriorityFeePerGas: pkg.feeModel.maxPriorityFeePerGas,
      maxFeePerGas: pkg.feeModel.maxFeePerGas,
    },
    quote: {
      sourceBlock: pkg.sourceBlock.number,
      sourceBlockHash: pkg.sourceBlock.hash,
      observedAt: pkg.quoteObservedAt,
      expiresAt: pkg.quoteExpiresAt,
    },
    expectedReceive: {
      token: CROSS.toLowerCase(),
      amount: d.value.toString(),
    },
    approval: pkg.approval.required
      ? { spender: pkg.approval.spender, amount: pkg.approval.amount }
      : null,
    trustModelAccepted: pkg.trustModelAccepted,
  };
}
export function intentDigest(normalized: unknown) {
  const json = canonicalJson(normalized);
  return {
    algorithm:
      "sha256(canonical JSON, keys sorted recursively, bigint as decimal string)",
    sha256: sha256Hex(json),
    keccak256: keccakHex("0x" + Buffer.from(json, "utf8").toString("hex")),
    canonicalJson: json,
  };
}

// ---------------------------------------------------------------- hostile replay (self-test on real data)
// Applies hostile mutations to deep copies of the FINAL fresh observation set; every one must leave READY.
export function hostileReplay(input: PrepInput) {
  const OTHER = "0x1111111111111111111111111111111111111111";
  const cases: [string, (i: PrepInput) => void][] = [
    [
      "source implementation code hash drift",
      (i) =>
        i.one.forEach(
          (s) => (s.implementationCodeHash = "0x" + "11".repeat(32)),
        ),
    ],
    [
      "destination implementation slot drift",
      (i) =>
        i.bsc.forEach(
          (s) =>
            (s.implementationSlot = "0x" + "0".repeat(24) + "22".repeat(20)),
        ),
    ],
    [
      "destination CROSS token code drift",
      (i) =>
        i.bsc.forEach(
          (s) => (s.token = { ...s.token!, codeHash: "0x" + "33".repeat(32) }),
        ),
    ],
    [
      "validator replaced (same count)",
      (i) =>
        i.bsc.forEach(
          (s) =>
            (s.bridgeRoles.VALIDATOR_ROLE = [
              ...(s.bridgeRoles.VALIDATOR_ROLE ?? []).slice(0, 2),
              OTHER,
            ]),
        ),
    ],
    ["threshold lowered to 1", (i) => i.one.forEach((s) => (s.threshold = 1))],
    [
      "additional admin",
      (i) =>
        i.one.forEach(
          (s) =>
            (s.bridgeRoles.ADMIN_ROLE = [
              ...(s.bridgeRoles.ADMIN_ROLE ?? []),
              OTHER,
            ]),
        ),
    ],
    [
      "destination finalize paused",
      (i) => i.bsc.forEach((s) => (s.finalizePaused = true)),
    ],
    [
      "source pair paused",
      (i) => i.one.forEach((s) => (s.pair = { ...s.pair, paused: true })),
    ],
    [
      "valued active pending CROSS record",
      (i) =>
        i.bsc.forEach((s) =>
          s.pending.push({
            index: "999999",
            toToken: CROSS.toLowerCase(),
            to: OTHER,
            value: "1",
            status: 1,
          }),
        ),
    ],
    [
      "spendable reserve below pilot amount",
      (i) => (i.reserve = { ...i.reserve, spendable: i.quote.amount - 1n }),
    ],
    [
      "in-flight not enumerated",
      (i) => (i.inFlight = { ...i.inFlight, enumerated: false }),
    ],
    [
      "wallet balance short by 1 wei",
      (i) =>
        i.one.forEach(
          (s) =>
            (s.balance = (
              i.quote.value +
              i.gas.maximumGasCost -
              1n
            ).toString()),
        ),
    ],
    [
      "quote older than 60 s",
      (i) => (i.decisionAt = i.quote.observedAt + QUOTE_MAX_AGE_MS + 1),
    ],
    [
      "eth_call false on one endpoint",
      (i) =>
        (i.simulations[1].ethCall = {
          ok: true,
          result: "0x" + "0".repeat(64),
        }),
    ],
    [
      "estimateGas disagreement",
      (i) =>
        (i.simulations[1].estimateGas = {
          ok: true,
          result:
            "0x" +
            (
              BigInt(i.simulations[1].estimateGas.result ?? "0x0") + 1n
            ).toString(16),
        }),
    ],
    [
      "negative control unexpectedly accepted",
      (i) =>
        (i.simulations[0].negatives[0] = {
          ...i.simulations[0].negatives[0],
          rejected: false,
        }),
    ],
    [
      "official ONE endpoints disagree on fees",
      (i) => (i.one[1].fees = { ...i.one[1].fees!, networkFee: "1" }),
    ],
    [
      "minimum increased to 6 ONE",
      (i) =>
        i.one.forEach(
          (s) =>
            (s.fees = {
              ...s.fees!,
              minimum: "6000000000000000000",
              minimumAtAmount: "6000000000000000000",
            }),
        ),
    ],
    [
      "upgrade event after the V1.6 pin",
      (i) =>
        i.driftScans[0].events.push({
          event: "Upgraded(address)",
          block: 1,
          tx: "0x" + "00".repeat(32),
        }),
    ],
    [
      "V1.6 decision file modified",
      (i) => (i.g5 = { ...i.g5, decisionFileSha256Matches: false }),
    ],
    [
      "production execution gate open",
      (i) =>
        (i.writeSafety = {
          ...i.writeSafety,
          gate: { ...i.writeSafety.gate, closed: false },
        }),
    ],
    [
      "recipient replaced",
      (i) => (i.intent = { ...i.intent, recipient: OTHER }),
    ],
    [
      "firewall mutation accepted",
      (i) =>
        i.firewall.mutations.push({
          name: "hostile",
          rejected: false,
          reason: null,
        }),
    ],
    [
      "source EOA has code",
      (i) => i.one.forEach((s) => (s.accountCode = "0x6080")),
    ],
  ];
  const results = cases.map(([name, mutate]) => {
    const copy = structuredClone(input);
    mutate(copy);
    const r = evaluateGates(copy);
    return {
      name,
      status: r.status,
      failClosed: r.status !== "READY_FOR_OWNER_SIGNATURE",
      gates: r.gates.filter((g) => g.status !== "PASS").map((g) => g.id),
    };
  });
  return {
    cases: results.length,
    allFailClosed: results.every((r) => r.failClosed),
    results,
  };
}
