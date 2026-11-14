// G7 pilot fresh mainnet preflight (READ-ONLY). Same observations, pins and P1-P20 gate logic as the reviewed
// V1.7 preparation (scripts/g7-prepare.ts + src/g7/prep.ts), restructured for repeated use inside one session:
//   baseline(): phase A once per run — dual-RPC pins, drift-event scans and the incremental BSC CROSS ledger from
//               the accepted V1.6 pins, in-flight enumeration.
//   run():      phase B for every initial/refresh/final preflight — BSC reserve side FIRST (fresh finalized pin,
//               ledger extension, pending, in-flight), then the ONE quote side LAST (fresh pin, pins/roles/pauses,
//               fees at the fixed 5 ONE principal, balance, eth_call + eth_estimateGas + 6 negative controls on both
//               official endpoints), firewall + mutations, gates P1-P20, owner-scope gates S1-S7, hostile replay.
// Every request goes through the allowlisted ReadOnlyRpc (src/g7/rpc.ts): there is no signer and no write method.
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  pad,
  parseAbi,
  toHex,
  type Abi,
  type Hex,
} from "viem";
import { G5_ROUTE_PINS, evaluateRouteDrift } from "../../src/g5/route-pins";
import { G5_STATUS } from "../../src/g5/status";
import { deriveSpendableReserve } from "../../src/g5/reserve";
import { platformFeePolicy } from "../../src/routing/fee-policy";
import { ReadOnlyRpc, type RpcAuditRecord } from "../../src/g7/rpc";
import { probeWitnessPool } from "../../src/g7/witness-pool";
import { validateLogs } from "../../src/g7/witness-logs";
import {
  FileG7Cache,
  cacheDigest,
  type G7CacheStore,
  type G7Checkpoint,
} from "../../src/data/store/g7-cache";
import {
  PinError,
  selectCommonPin,
  type CommonPin,
  type PinDiagnostics,
} from "../../src/g7/common-pin";
import {
  BSC_PIN_POLICY,
  BSC_STATE_SOURCES,
  CROSS,
  ENDPOINTS,
  EXTENDED_PINS,
  NATIVE,
  NEGATIVE_CONTROLS,
  ONE_PIN_LAG,
  PILOT_EOA,
  ROLE_NAMES,
  SLOTS,
  TRUST_ACCOUNTS,
  V16,
  WATCHED_EVENTS,
} from "../../src/g7/policy";
import {
  LEDGER_EVENT_ABI,
  reconcileLedgerDelta,
  type LedgerDeltaResult,
  type LedgerState,
  type RawLog,
} from "../../src/g7/ledger";
import { BRIDGE_TOKEN_SELECTOR, selectorOf } from "../../src/g7/decoder";
import {
  canonicalJson,
  encodePilotCalldata,
  evaluateGates,
  expectedFirewallIntent,
  expectedPinsView,
  firewallMutations,
  formatUnits18,
  g7ContractEntry,
  g7Firewall,
  gasPlan,
  hostileReplay,
  observedRoute,
  pinsDigest,
  productionGateStaysClosed,
  routePinsView,
  verifyCalldata,
  type DriftScan,
  type G5DecisionCheck,
  type Gate,
  type InFlight,
  type NegativeRead,
  type PrepInput,
  type SideRead,
  type SimulationRead,
} from "../../src/g7/prep";
import { scanG7Sources, type CandidateBaseline } from "../g7-safety-scan";
import {
  ExecutionEvidence,
  noWriteReasons,
  type ExecutionSnapshot,
} from "../../src/g7/write-evidence";
import { tokenInFlight } from "../../src/g7/in-flight-reserve";
import {
  pilotIntent,
  pilotIntentDigest,
  pilotQuote,
  pilotScopeGates,
  walletTx,
  type PilotFees,
  type PilotIntent,
  type WalletTx,
} from "./intent";
import { PILOT_SCOPE } from "./policy";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const V16_ROOT = join(REPO, V16.evidence);
const sha256 = (b: string | Buffer) =>
  createHash("sha256").update(b).digest("hex");
const hx = (n: number | bigint) => "0x" + n.toString(16);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// ------------------------------------------------------------------ outcome model
export type PreflightKind = "initial" | "refresh" | "final";
export type PreflightStatus = "READY" | "BLOCKED" | "OWNER_REAPPROVAL_REQUIRED";
export interface Review {
  intent: PilotIntent;
  intentDigest: string;
  tx: WalletTx;
  // Informational (not digest-bound): eth_estimateGas x current gas price of the fresh quote.
  estimatedGas: { gas: string; gasPrice: string; cost: string };
  quote: {
    observedAt: number;
    sourceBlock: number;
    sourceBlockHash: string;
    sourceBlockTimestamp: number;
    destinationBlock: number;
    destinationBlockHash: string;
  };
}
export interface PreflightSummary {
  g5: string;
  runtimeDrift: string;
  authorityDrift: string;
  routeRegistration: string;
  pauses: string;
  feesAndMinimum: string;
  ownerScope: string;
  reserve: {
    status: string;
    verified: boolean;
    spendable: string;
    block: number;
    blockHash: string;
    finalized: boolean;
  };
  pending: {
    status: string;
    pendingAmount: string;
    activeRecords: number;
    valuedActivePendingCross: number;
    inFlightCount: number;
    inFlightEnumerated: boolean;
    inFlightSum: string;
  };
  simulation: {
    status: string;
    ethCall: string[];
    estimateGas: string[];
    negativeControls: string;
  };
  firewall: {
    status: string;
    positive: boolean;
    mutationsRejected: string;
    hostileReplay: string;
    productionGateClosed: boolean;
  };
  dualRpc: string;
  // V1.11: the BSC common finalized pin of this preflight (owner-facing "Safety details").
  bscPin?: {
    block: number;
    ageSec: number;
    operatorGroups: string[];
    hosts: string[];
  } | null;
  quoteFreshness: string;
  noWritePath: string;
  balance: string;
  nonce: string;
  minimum: string;
  nextInitiateIndex: string;
}
export interface PreflightOutcome {
  id: string;
  kind: PreflightKind;
  startedAt: number;
  decisionAt: number;
  status: PreflightStatus;
  gates: Gate[];
  blockedReasons: string[];
  reapprovalReasons: string[];
  review: Review | null;
  summary: PreflightSummary | null;
  error?: string;
  // V1.11: why a preflight could not reach a verdict (RPC consensus unavailable); never a pass.
  diagnostics?: PinDiagnostics | null;
}
export interface PreflightSource {
  baselineScope?: "accepted" | "dry-validation" | "fixture-validation";
  execution?: ExecutionEvidence;
  baseline(): Promise<void>;
  run(kind: PreflightKind): Promise<PreflightOutcome>;
}

// Final status: any owner-bound excess => OWNER_REAPPROVAL_REQUIRED (no wallet request, owner must re-approve),
// otherwise any failed gate => BLOCKED, otherwise READY.
export function combineGates(gates: Gate[]) {
  const failed = gates.filter((g) => g.status === "FAIL");
  const reapproval = gates.filter(
    (g) => g.status === "OWNER_REAPPROVAL_REQUIRED",
  );
  const status: PreflightStatus = reapproval.length
    ? "OWNER_REAPPROVAL_REQUIRED"
    : failed.length
      ? "BLOCKED"
      : "READY";
  return {
    status,
    blockedReasons: failed.map(
      (g) => `${g.id} ${g.name}: ${g.reasons.join("; ")}`,
    ),
    reapprovalReasons: reapproval.flatMap((g) =>
      g.reasons.map((r) => `${g.id}: ${r}`),
    ),
  };
}
export function failedOutcome(
  kind: PreflightKind,
  startedAt: number,
  error: unknown,
  execution?: ExecutionSnapshot,
): PreflightOutcome {
  const message = String((error as Error)?.message ?? error).slice(0, 400);
  const gates: Gate[] = [
    {
      id: "X0",
      name: "PREFLIGHT_EXECUTION",
      status: "FAIL",
      reasons: [message],
    },
  ];
  const reasons = noWriteReasons(execution as ExecutionSnapshot);
  gates.push({
    id: "P20",
    name: "NO_WRITE_PATH_EXECUTED",
    status: reasons.length ? "FAIL" : "PASS",
    reasons,
  });
  return {
    id: `pf-${randomBytes(4).toString("hex")}`,
    kind,
    startedAt,
    decisionAt: Date.now(),
    gates,
    ...combineGates(gates),
    review: null,
    summary: null,
    error: message,
    diagnostics: error instanceof PinError ? error.diagnostics : null,
  };
}

type Pair = SideRead["pair"];
export type PilotSide = SideRead & {
  dispatcherHasBridgeToken?: boolean;
  pilotFees?: {
    amount: string;
    minimum: string;
    networkFee: string;
    exFee: string;
  };
};

// The pilot calldata ABI must be the bridgeToken entry of the V1.6 exact-build ABI (CrossBridge @ b3b0258).
export function abiFromExactBuild(
  liveAbi: Abi,
  calldata: string,
  fees: PilotFees,
): Gate {
  const r: string[] = [];
  const fn = liveAbi.filter(
    (x) => x.type === "function" && x.name === "bridgeToken",
  ) as unknown as {
    inputs: { type: string }[];
    stateMutability: string;
  }[];
  if (fn.length !== 1) r.push(`BRIDGE_TOKEN_OVERLOADS:${fn.length}`);
  else {
    const sig = `bridgeToken(${fn[0].inputs.map((i) => i.type).join(",")})`;
    if (sig !== PILOT_SCOPE.signature) r.push(`SIGNATURE_DIFFERS:${sig}`);
    if (selectorOf(sig) !== PILOT_SCOPE.selector) r.push("SELECTOR_DIFFERS");
    if (fn[0].stateMutability !== "payable") r.push("NOT_PAYABLE");
    const exact = encodeFunctionData({
      abi: liveAbi,
      functionName: "bridgeToken",
      args: [
        56n,
        NATIVE,
        PILOT_SCOPE.recipient,
        PILOT_SCOPE.principal,
        fees.networkFee,
        fees.serviceFee,
        "0x",
      ],
    });
    if (exact.toLowerCase() !== calldata.toLowerCase())
      r.push("CALLDATA_DIFFERS_FROM_EXACT_BUILD_ENCODING");
  }
  return {
    id: "S7",
    name: "BRIDGE_TOKEN_ABI_FROM_V16_EXACT_BUILD",
    status: r.length ? "FAIL" : "PASS",
    reasons: r,
  };
}

export interface Observations {
  g5: G5DecisionCheck;
  liveAbi: Abi;
  selectorInLiveDispatcher: boolean;
  one: PilotSide[];
  bsc: SideRead[];
  bscFinalizedOk: boolean;
  bscPin?: CommonPin | null;
  sims: SimulationRead[];
  simulatedCalldata: string;
  ledger: LedgerDeltaResult;
  inFlight: InFlight;
  driftScans: DriftScan[];
  quoteObservedAt: number;
  rpcMethodsUsed: Record<string, number>;
  methodLog: { method: string; params: number }[];
}
// Pure composition shared by the live and the fixture source: the fresh observations go through the reviewed
// P1-P20 gates unchanged, then the owner-scope gates S1-S8, then the owner review (intent + digest + wallet tx).
export function composeOutcome(
  obs: Observations,
  kind: PreflightKind,
  id: string,
  startedAt: number,
  clock: () => number = Date.now,
  context: {
    candidateBaseline?: CandidateBaseline;
    execution?: ExecutionEvidence;
  } = {},
) {
  const one = obs.one[0],
    bsc = obs.bsc[0];
  const pf = one.pilotFees;
  if (!pf || !one.fees) throw new Error("PILOT_FEES_NOT_READ");
  const fees: PilotFees = {
    minimum: BigInt(one.fees.minimum),
    networkFee: BigInt(pf.networkFee),
    serviceFee: BigInt(pf.exFee),
  };
  const quote = pilotQuote(fees, obs.quoteObservedAt, one);
  const intentArgs = {
    account: PILOT_EOA,
    recipient: PILOT_EOA,
    amount: quote.amount,
    networkFee: quote.networkFee,
    serviceFee: quote.serviceFee,
  };
  const data = encodePilotCalldata(intentArgs);
  const driftScans = obs.driftScans;
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
    pendingComplete: obs.bsc.every(
      (s) => canonicalJson(s.pending) === canonicalJson(bsc.pending),
    ),
    inFlight: tokenInFlight(obs.inFlight, CROSS),
    sourceMinted: BigInt(one.pair.minted),
    minimum: BigInt(one.fees!.minimum),
    driftState: evaluateRouteDrift(observedRoute(one, bsc)).state,
  });
  const calldata = verifyCalldata(data, intentArgs);
  const estimate = obs.sims[0].estimateGas.ok
    ? BigInt(obs.sims[0].estimateGas.result!)
    : 0n;
  let gas;
  try {
    gas = gasPlan(
      estimate,
      obs.sims.map((s) => BigInt(s.gasPrice)),
      obs.sims.map((s) => BigInt(s.maxPriorityFeePerGas)),
      BigInt(obs.sims[0].baseFeePerGas),
    );
  } catch {
    gas = gasPlan(21001n, [0n], [0n], 0n); // placeholder only; P15 fails closed on the missing estimate
  }
  const fwTx = {
    chainId: "612055",
    from: PILOT_EOA,
    to: G5_ROUTE_PINS.source.proxy,
    value: quote.value.toString(),
    data,
  };
  const quoteId = `g7-pilot-${id}-${one.block}`;
  const expected = expectedFirewallIntent(quote, quoteId);
  const entry = g7ContractEntry(one, obs.quoteObservedAt);
  const observedPins = routePinsView(one, bsc);
  const ctx = {
    entry,
    quote,
    expectedCalldata: data,
    pinsDigestExpected: pinsDigest(expectedPinsView()),
    pinsDigestObserved: pinsDigest(observedPins),
    implementationHashObserved: one.implementationCodeHash,
    platformFeeBps: platformFeePolicy.bps,
    approval: { spender: null, amount: "0" },
  };
  const now = clock();
  const positive = g7Firewall(fwTx, expected, ctx, now);
  const mutations = firewallMutations(fwTx, expected, ctx, intentArgs, now);
  const gate = productionGateStaysClosed(fwTx, expected, entry, now);
  const scan = scanG7Sources(context.candidateBaseline);
  const writeSafety = {
    execution: (context.execution ?? new ExecutionEvidence()).snapshot(),
    rpcMethodsUsed: obs.rpcMethodsUsed,
    forbiddenMethodCalls: obs.methodLog.filter(
      (r) =>
        !/^(eth_(chainId|blockNumber|getBlockByNumber|getBlockByHash|getCode|getStorageAt|call|estimateGas|getLogs|getBalance|getTransactionCount|getTransactionByHash|getTransactionReceipt|gasPrice|maxPriorityFeePerGas|feeHistory))$/.test(
          r.method,
        ),
    ).length,
    stateOverrideCalls: obs.methodLog.filter(
      (r) =>
        (r.method === "eth_call" || r.method === "eth_estimateGas") &&
        r.params > 2,
    ).length,
    staticScanPass: scan.contentPass,
    protectedBaselinePass: scan.protectedBaselinePass,
    gate,
    feePolicyEnabled: platformFeePolicy.enabled,
    feePolicyBps: platformFeePolicy.bps,
  };
  const decisionAt = clock();
  const prepInput: PrepInput = {
    g5: obs.g5,
    one: obs.one,
    bsc: obs.bsc,
    driftScans,
    ledger: obs.ledger,
    inFlight: obs.inFlight,
    reserve,
    bscBlockFinalized: obs.bscFinalizedOk,
    simulations: obs.sims,
    quote,
    gas,
    intent: intentArgs,
    calldata,
    selectorInLiveDispatcher:
      obs.selectorInLiveDispatcher &&
      obs.one.every((s) => s.dispatcherHasBridgeToken === true),
    firewall: { positive, mutations },
    writeSafety,
    decisionAt,
  };
  const prep = evaluateGates(prepInput);
  const hostile = hostileReplay(prepInput);
  if (!hostile.allFailClosed) {
    const p17 = prep.gates.find((g) => g.id === "P17")!;
    p17.status = "FAIL";
    p17.reasons.push(
      ...hostile.results
        .filter((r) => !r.failClosed)
        .map((r) => `HOSTILE_REPLAY_NOT_FAIL_CLOSED:${r.name}`),
    );
  }
  const tx = walletTx(quote, gas, data);
  const gates = [
    ...prep.gates,
    ...pilotScopeGates({ fees, quote, gas, tx }),
    abiFromExactBuild(obs.liveAbi, data, fees),
    {
      id: "S8",
      name: "SIMULATED_EXACT_PILOT_CALLDATA",
      status: same(obs.simulatedCalldata, data) ? "PASS" : "FAIL",
      reasons: same(obs.simulatedCalldata, data)
        ? []
        : ["SIMULATED_CALLDATA_DIFFERS"],
    } satisfies Gate,
  ];
  // The 60 s P19 window of the prep becomes the stricter 20 s pilot window through quote.expiresAt.
  const combined = combineGates(gates);
  const intent = pilotIntent(tx, gas, one, bsc);
  const review: Review = {
    intent,
    intentDigest: pilotIntentDigest(intent),
    tx,
    estimatedGas: {
      gas: gas.estimate.toString(),
      gasPrice: gas.legacyGasPrice.toString(),
      cost: gas.estimatedGasCost.toString(),
    },
    quote: {
      observedAt: quote.observedAt,
      sourceBlock: one.block,
      sourceBlockHash: one.blockHash,
      sourceBlockTimestamp: one.blockTimestamp,
      destinationBlock: bsc.block,
      destinationBlockHash: bsc.blockHash,
    },
  };
  const status = (...ids: string[]) =>
    ids.every((x) => gates.find((g) => g.id === x)?.status === "PASS")
      ? "PASS"
      : "FAIL";
  const summary: PreflightSummary = {
    g5: status("P1"),
    runtimeDrift: status("P2", "P3"),
    authorityDrift: status("P4"),
    routeRegistration: status("P5"),
    pauses: status("P6"),
    feesAndMinimum: status("P7"),
    ownerScope: status("S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"),
    reserve: {
      status: status("P8"),
      verified: reserve.verified,
      spendable: formatUnits18(reserve.spendable),
      block: bsc.block,
      blockHash: bsc.blockHash,
      finalized: obs.bscFinalizedOk,
    },
    pending: {
      status: status("P9"),
      pendingAmount: bsc.pair.pendingAmount,
      activeRecords: bsc.pending.length,
      valuedActivePendingCross: bsc.pending.filter(
        (p) => p.toToken === CROSS.toLowerCase() && BigInt(p.value) > 0n,
      ).length,
      inFlightCount: obs.inFlight.items.length,
      inFlightEnumerated: obs.inFlight.enumerated,
      inFlightSum: obs.inFlight.items
        .reduce((s, i) => s + BigInt(i.value ?? "0"), 0n)
        .toString(),
    },
    simulation: {
      status: status("P14", "P15", "P16"),
      ethCall: obs.sims.map(
        (s) =>
          `${new URL(s.url).host}: ${s.ethCall.ok && s.ethCall.result === ABI_TRUE}`,
      ),
      estimateGas: obs.sims.map(
        (s) =>
          `${new URL(s.url).host}: ${s.estimateGas.ok ? BigInt(s.estimateGas.result!).toString() : "FAILED"}`,
      ),
      negativeControls: `${obs.sims.reduce(
        (n, s) =>
          n +
          s.negatives.filter(
            (x) =>
              x.rejected &&
              x.errorName === x.expectedError &&
              x.selector === x.expectedSelector,
          ).length,
        0,
      )}/${obs.sims.length * NEGATIVE_CONTROLS.length}`,
    },
    firewall: {
      status: status("P17"),
      positive: positive.pass,
      mutationsRejected: `${mutations.filter((m) => m.rejected).length}/${mutations.length}`,
      hostileReplay: `${hostile.results.filter((r) => r.failClosed).length}/${hostile.cases}`,
      productionGateClosed: gate.closed,
    },
    dualRpc: status("P18"),
    bscPin: obs.bscPin
      ? {
          block: obs.bscPin.number,
          ageSec: obs.bscPin.ageSec,
          operatorGroups: [...obs.bscPin.operatorGroups],
          hosts: obs.bscPin.sources.map((x) => new URL(x.url).host),
        }
      : null,
    quoteFreshness: status("P19"),
    noWritePath: status("P20"),
    balance: one.balance ?? "",
    nonce: one.nonce ?? "",
    minimum: one.fees!.minimum,
    nextInitiateIndex: one.nextInitiateIndex,
  };
  const outcome: PreflightOutcome = {
    id,
    kind,
    startedAt,
    decisionAt,
    status: combined.status,
    gates,
    blockedReasons: combined.blockedReasons,
    reapprovalReasons: combined.reapprovalReasons,
    review,
    summary,
  };
  return {
    outcome,
    details: {
      reserve,
      quote,
      gas,
      calldata,
      firewall: {
        fwTx,
        expected,
        entry,
        positive,
        mutations,
        gate,
        pins: observedPins,
      },
      scan: {
        pass: scan.pass,
        findings: scan.findings,
        protectedUnchanged: scan.protectedUnchanged,
        baselineScope: scan.baselineScope,
        baselineSelection: scan.baselineSelection,
      },
      writeSafety,
      hostile,
    },
  };
}

// ------------------------------------------------------------------ live read-only implementation
export interface LiveIo {
  candidateBaseline?: CandidateBaseline;
  execution?: ExecutionEvidence;
  audit: (record: RpcAuditRecord) => void;
  record: (name: string, value: unknown) => void;
  log: (message: string) => void;
  cache?: G7CacheStore;
}
const VIEW_ABI = parseAbi([
  "function paused() view returns (bool)",
  "function threshold() view returns (uint8)",
  "function bridgeVerifier() view returns (address)",
  "function bridgeExecutor() view returns (address)",
  "function dev() view returns (address)",
  "function maxExtraDataLength() view returns (uint256)",
  "function getTokenPair(uint256,address) view returns ((address localToken,address remoteToken,bool isOrigin,bool paused,uint256 pendingAmount,uint256 deposited,uint256 minted))",
  "function allPendingIndex(uint256) view returns (uint256[])",
  "function getPendingArguments(uint256,uint256) view returns (((uint256 fromChainID,uint256 index,address toToken,address to,uint256 value,bytes extraData) args,uint8 status,uint256 delayExpiration))",
  "function getNextInitiateIndex(uint256) view returns (uint256)",
  "function getNextFinalizeIndex(uint256) view returns (uint256)",
  "function isTokenFinalizePaused(uint256,address) view returns (bool)",
  "function getRoleMembers(bytes32) view returns (address[])",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function getVerificationAmountThreshold() view returns (uint256)",
  "function getPeriodTotalValueThreshold() view returns (uint256)",
  "function priceFeed() view returns (address)",
  "function denominator() pure returns (uint256)",
  "function getTokenConfig(uint256,address) view returns (uint256 minimumValue,uint256 networkFee,uint256 exFeeRate)",
  "function calculateFee(uint256,address,uint256) view returns (uint256 minimumValue,uint256 networkFee,uint256 exFee)",
]) as Abi;
const WATCHED_TOPICS = WATCHED_EVENTS.map((s) => keccak256(toHex(s)));
const TOPIC_NAME = Object.fromEntries(
  WATCHED_EVENTS.map((s) => [keccak256(toHex(s)), s]),
);
const TRANSFER = keccak256(toHex("Transfer(address,address,uint256)"));
const INITIATED = keccak256(
  toHex(
    "BridgeInitiated(uint256,uint256,address,address,address,address,uint256,uint256,uint256,bytes,uint256)",
  ),
);
const ABI_TRUE = "0x" + "0".repeat(63) + "1";

export function livePreflight(io: LiveIo): PreflightSource {
  if (io.candidateBaseline && io.candidateBaseline.scope !== "dry-validation")
    throw new Error("CANDIDATE_ONLY_FOR_DRY_VALIDATION");
  const execution = io.execution ?? new ExecutionEvidence();
  const cache =
    io.cache ??
    new FileG7Cache(join(REPO, ".otherbridge", "data-cache", "g7-ledger.json"));
  let checkpoint = cache.load();
  let witnessCandidates: Awaited<ReturnType<typeof probeWitnessPool>> | null =
    null;
  const excludedWitnesses = new Set<string>();
  const methodLog: { method: string; params: number }[] = [];
  const rpc = new ReadOnlyRpc({
    execution,
    timeoutMs: 30000,
    // Measured cold initial+final session: 845 wire requests. At most three bounded full attempts are permitted.
    requestBudget: 845 * 3,
    audit: (r) => {
      methodLog.push({ method: r.method, params: r.params.length });
      io.audit(r);
    },
  });
  function limiter(n: number) {
    let active = 0;
    const queue: (() => void)[] = [];
    return async <T>(fn: () => Promise<T>): Promise<T> => {
      if (active >= n) await new Promise<void>((r) => queue.push(r));
      active++;
      try {
        return await fn();
      } finally {
        active--;
        queue.shift()?.();
      }
    };
  }
  const limits = new Map<string, ReturnType<typeof limiter>>();
  const lim = (url: string) => {
    if (!limits.has(url)) limits.set(url, limiter(6));
    return limits.get(url)!;
  };
  const call = <T>(url: string, method: string, params: unknown[]) =>
    lim(url)(() => rpc.retry<T>(url, method, params));
  const logLimit = limiter(1);
  let lastLogRequestAt = 0;
  const raw = (url: string, method: string, params: unknown[]) =>
    method !== "eth_getLogs"
      ? lim(url)(() => rpc.raw(url, method, params))
      : logLimit(async () => {
          // The measured four-way historical-log burst hit the public quota. Serialize heavy ranges and pace them.
          const wait = Math.max(0, 1000 - (Date.now() - lastLogRequestAt));
          if (wait) await new Promise((r) => setTimeout(r, wait));
          lastLogRequestAt = Date.now();
          return lim(url)(() => rpc.raw(url, method, params));
        });
  async function view<T>(
    url: string,
    to: string,
    fn: string,
    args: unknown[],
    block: string,
  ) {
    const data = encodeFunctionData({ abi: VIEW_ABI, functionName: fn, args });
    const out = await call<Hex>(url, "eth_call", [{ to, data }, block]);
    return decodeFunctionResult({
      abi: VIEW_ABI,
      functionName: fn,
      data: out,
    }) as T;
  }
  const roleId = (r: string) =>
    r === "DEFAULT_ADMIN_ROLE" ? pad("0x00") : keccak256(toHex(r));
  const mapSlot = (key: bigint, slot: bigint) =>
    keccak256(
      encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }],
        [key, slot],
      ),
    );
  const plus = (h: string, n: bigint) => toHex(BigInt(h) + n, { size: 32 });

  // ---------------------------------------------------------------- one side of the route at one pinned block
  async function readSide(
    chain: "one" | "bsc",
    url: string,
    block: string,
  ): Promise<PilotSide> {
    const side =
      chain === "one" ? G5_ROUTE_PINS.source : G5_ROUTE_PINS.destination;
    const remote = chain === "one" ? 56n : 612055n;
    const token = chain === "one" ? NATIVE : CROSS;
    const v = <T>(to: string, fn: string, args: unknown[] = []) =>
      view<T>(url, to, fn, args, block);
    const code = (a: string) => call<string>(url, "eth_getCode", [a, block]);
    const slot = (s: string) =>
      call<string>(url, "eth_getStorageAt", [side.proxy, s, block]);
    const [head, chainIdHex, implSlot, adminSlot, beaconSlot, proxyCode] =
      await Promise.all([
        call<{ hash: string; timestamp: string; number: string }>(
          url,
          "eth_getBlockByNumber",
          [block, false],
        ),
        call<string>(url, "eth_chainId", []),
        slot(SLOTS.implementation),
        slot(SLOTS.admin),
        slot(SLOTS.beacon),
        code(side.proxy),
      ]);
    const implementation = "0x" + implSlot.slice(-40);
    const [
      implCode,
      paused,
      threshold,
      verifier,
      executor,
      dev,
      maxExtra,
      pair,
      finalizePaused,
      nextInit,
      nextFin,
      pendingIdx,
      chainPausedRaw,
    ] = await Promise.all([
      code(implementation),
      v<boolean>(side.proxy, "paused"),
      v<number>(side.proxy, "threshold"),
      v<string>(side.proxy, "bridgeVerifier"),
      v<string>(side.proxy, "bridgeExecutor"),
      v<string>(side.proxy, "dev"),
      v<bigint>(side.proxy, "maxExtraDataLength"),
      v<Record<string, unknown>>(side.proxy, "getTokenPair", [remote, token]),
      v<boolean>(side.proxy, "isTokenFinalizePaused", [remote, token]),
      v<bigint>(side.proxy, "getNextInitiateIndex", [remote]),
      v<bigint>(side.proxy, "getNextFinalizeIndex", [remote]),
      v<bigint[]>(side.proxy, "allPendingIndex", [remote]),
      // _chainData mapping at slot 4, `paused` at struct offset +3 (V1.6 layout, exact build)
      call<string>(url, "eth_getStorageAt", [
        side.proxy,
        plus(mapSlot(remote, 4n), 3n),
        block,
      ]),
    ]);
    const [
      verifierCode,
      bridgeRoles,
      verifierRoles,
      vt1,
      vt2,
      priceFeed,
      denom,
    ] = await Promise.all([
      code(verifier),
      Promise.all(
        ROLE_NAMES.map((r) =>
          v<string[]>(side.proxy, "getRoleMembers", [roleId(r)]),
        ),
      ),
      Promise.all(
        ROLE_NAMES.map((r) =>
          v<string[]>(verifier, "getRoleMembers", [roleId(r)]),
        ),
      ),
      v<bigint>(verifier, "getVerificationAmountThreshold"),
      v<bigint>(verifier, "getPeriodTotalValueThreshold"),
      v<string>(verifier, "priceFeed"),
      v<bigint>(verifier, "denominator"),
    ]);
    const pending = await Promise.all(
      pendingIdx.map(async (i) => {
        const p = await v<{
          args: { toToken: string; to: string; value: bigint };
          status: number;
        }>(side.proxy, "getPendingArguments", [remote, i]);
        return {
          index: i.toString(),
          toToken: p.args.toToken.toLowerCase(),
          to: p.args.to.toLowerCase(),
          value: p.args.value.toString(),
          status: Number(p.status),
        };
      }),
    );
    const trustCodes = await Promise.all(TRUST_ACCOUNTS.map((a) => code(a)));
    const accountCode = await code(PILOT_EOA);
    const lc = (xs: string[]) => xs.map((x) => x.toLowerCase());
    const p = pair as unknown as Record<string, string | boolean | bigint>;
    const out: PilotSide = {
      url,
      chainId: Number(BigInt(chainIdHex)),
      block: Number(BigInt(block)),
      blockHash: head.hash,
      blockTimestamp: Number(BigInt(head.timestamp)),
      proxyCodeHash: keccak256(proxyCode as Hex),
      implementationSlot: implSlot.toLowerCase(),
      implementation: implementation.toLowerCase(),
      implementationCodeHash: keccak256(implCode as Hex),
      adminSlot: adminSlot.toLowerCase(),
      beaconSlot: beaconSlot.toLowerCase(),
      paused,
      threshold: Number(threshold),
      verifier: verifier.toLowerCase(),
      verifierCodeHash: keccak256(verifierCode as Hex),
      executor: executor.toLowerCase(),
      dev: dev.toLowerCase(),
      maxExtraDataLength: maxExtra.toString(),
      bridgeRoles: Object.fromEntries(
        ROLE_NAMES.map((r, k) => [r, lc(bridgeRoles[k])]),
      ),
      verifierRoles: Object.fromEntries(
        ROLE_NAMES.map((r, k) => [r, lc(verifierRoles[k])]),
      ),
      verifierThresholds: {
        verificationAmountThreshold: vt1.toString(),
        periodTotalValueThreshold: vt2.toString(),
      },
      priceFeed: priceFeed.toLowerCase(),
      feeDenominator: denom.toString(),
      pair: {
        localToken: String(p.localToken).toLowerCase(),
        remoteToken: String(p.remoteToken).toLowerCase(),
        isOrigin: Boolean(p.isOrigin),
        paused: Boolean(p.paused),
        pendingAmount: String(p.pendingAmount),
        deposited: String(p.deposited),
        minted: String(p.minted),
      } satisfies Pair,
      chainPaused: BigInt(chainPausedRaw) !== 0n,
      finalizePaused,
      nextInitiateIndex: nextInit.toString(),
      nextFinalizeIndex: nextFin.toString(),
      pending,
      trustAccountCodes: Object.fromEntries(
        TRUST_ACCOUNTS.map((a, k) => [a.toLowerCase(), trustCodes[k]]),
      ),
      accountCode,
    };
    // The pinned bridgeToken selector must still be dispatched by the live implementation (PUSH4 <selector>).
    out.dispatcherHasBridgeToken =
      chain === "one"
        ? implCode.toLowerCase().includes("63" + BRIDGE_TOKEN_SELECTOR.slice(2))
        : undefined;
    if (chain === "one") {
      const [minimum, networkFee] = await v<[bigint, bigint, bigint]>(
        verifier,
        "calculateFee",
        [56n, NATIVE, 0n],
      );
      const [
        [m2, n2, exFee],
        [cfgMin, cfgNf, rate],
        [m5, n5, ex5],
        balance,
        nonce,
      ] = await Promise.all([
        v<[bigint, bigint, bigint]>(verifier, "calculateFee", [
          56n,
          NATIVE,
          minimum,
        ]),
        v<[bigint, bigint, bigint]>(verifier, "getTokenConfig", [56n, NATIVE]),
        // Fees at the fixed pilot principal (5 ONE): the values that go into the calldata.
        v<[bigint, bigint, bigint]>(verifier, "calculateFee", [
          56n,
          NATIVE,
          PILOT_SCOPE.principal,
        ]),
        call<string>(url, "eth_getBalance", [PILOT_EOA, block]),
        call<string>(url, "eth_getTransactionCount", [PILOT_EOA, block]),
      ]);
      out.fees = {
        minimum: minimum.toString(),
        networkFee: networkFee.toString(),
        exFee: exFee.toString(),
        minimumAtAmount: m2.toString(),
        networkFeeAtAmount: n2.toString(),
        configMinimum: cfgMin.toString(),
        configNetworkFee: cfgNf.toString(),
        exFeeRate: rate.toString(),
      };
      out.pilotFees = {
        amount: PILOT_SCOPE.principal.toString(),
        minimum: m5.toString(),
        networkFee: n5.toString(),
        exFee: ex5.toString(),
      };
      out.balance = BigInt(balance).toString();
      out.nonce = BigInt(nonce).toString();
    } else {
      const [tokenCode, decimals, bal, symbol, name] = await Promise.all([
        code(CROSS),
        v<number>(CROSS, "decimals"),
        v<bigint>(CROSS, "balanceOf", [side.proxy]),
        v<string>(CROSS, "symbol"),
        v<string>(CROSS, "name"),
      ]);
      out.token = {
        address: CROSS.toLowerCase(),
        codeHash: keccak256(tokenCode as Hex),
        decimals: Number(decimals),
        balanceOfBridge: bal.toString(),
        symbol,
        name,
      };
    }
    return out;
  }
  // Pins: ONE = head - lag (load-balanced public backends); BSC = the canonical COMMON finalized block of one
  // independent pair (V1.11, src/g7/common-pin.ts): the highest finalized block both sources can serve with the
  // identical hash (and the logs witness too), recent, never below `floor`. Both sources must serve the identical
  // block hash. A pruned-state answer re-pins (bounded), it is never ignored.
  async function pinOne() {
    const head = Number(
      BigInt(await call<string>(ENDPOINTS.one[0], "eth_blockNumber", [])),
    );
    return hx(head - ONE_PIN_LAG);
  }
  const probe = <T>(
    url: string,
    method: string,
    params: unknown[],
    timeoutMs?: number,
  ) => lim(url)(() => rpc.call<T>(url, method, params, timeoutMs));
  async function pinBsc(floor?: number) {
    if (!witnessCandidates) {
      witnessCandidates = await probeWitnessPool(
        probe,
        (checkpoint?.acceptedThroughBlock ?? V16.ledgerPin) + 1,
        G5_ROUTE_PINS.destination.proxy,
      );
      io.record("witness-pool", witnessCandidates);
    }
    const candidates = witnessCandidates
      .filter(
        (w) =>
          w.healthScore > 0 &&
          w.capabilities.logs &&
          w.capabilities.historicalLogs &&
          !excludedWitnesses.has(w.source.url),
      )
      .map((w) => w.source);
    if (!candidates.length)
      throw new PinError({
        code: "RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE",
        chain: "bsc",
        health: witnessCandidates.map((w) => ({
          ...w.source,
          host: new URL(w.source.url).host,
          role: "witness" as const,
          ok: false,
          chainId: w.chainId,
          finalized: null,
          finalizedHash: null,
          finalizedTimestamp: null,
          head: null,
          lagBlocks: null,
          failure:
            w.cooldownUntil > Date.now()
              ? ("RATE_LIMITED" as const)
              : ("WITNESS_UNAVAILABLE" as const),
          error: w.error,
          cooldownUntil: w.cooldownUntil,
        })),
        attempts: [
          {
            a: BSC_STATE_SOURCES[0].url,
            b: BSC_STATE_SOURCES[1].url,
            candidate: null,
            tried: [],
            outcome: "WITNESS_UNAVAILABLE",
            detail: "No independently classified log-capable source available",
          },
        ],
        observedAt: Date.now(),
      });
    const pin = await selectCommonPin(BSC_STATE_SOURCES, probe, {
      ...BSC_PIN_POLICY,
      floor,
      witnessCandidates: candidates,
    });
    io.log(
      `bsc common pin ${pin.number} (age ${pin.ageSec}s) via ${pin.operatorGroups.join(" + ")}`,
    );
    return pin;
  }
  // The pin is already within each source's own finalized head; a load-balanced backend that has not seen the
  // finality yet is re-asked (bounded) instead of failing the check spuriously.
  async function stillFinalized(url: string, block: string) {
    for (let i = 0; i < 3; i++) {
      const f = await call<{ number: string } | null>(
        url,
        "eth_getBlockByNumber",
        ["finalized", false],
      );
      if (f && BigInt(f.number) >= BigInt(block)) return true;
      await new Promise((r) => setTimeout(r, 600));
    }
    return false;
  }
  async function readBoth(chain: "one" | "bsc", floor?: number) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      let pin: CommonPin | null = null;
      try {
        if (chain === "bsc") pin = await pinBsc(floor);
        const block = pin ? pin.block : await pinOne();
        const urls = pin ? pin.sources.map((s) => s.url) : ENDPOINTS.one;
        const reads = await Promise.all(
          urls.map((u) => readSide(chain, u, block)),
        );
        let finalizedOk = true;
        if (chain === "bsc")
          for (const u of urls)
            if (!(await stillFinalized(u, block))) finalizedOk = false;
        return { block, reads, attempts: attempt, finalizedOk, pin };
      } catch (e) {
        lastError = e;
        io.log(
          `${chain} read attempt ${attempt} failed: ${String((e as Error).message).slice(0, 200)}`,
        );
        // A finalized-hash disagreement is a consensus fault: never re-pinned around.
        if (
          e instanceof PinError &&
          (e.diagnostics.code === "RPC_FINALIZED_HASH_DISAGREEMENT" ||
            e.diagnostics.code === "RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE")
        )
          break;
      }
    }
    throw lastError;
  }

  // ---------------------------------------------------------------- logs
  async function getLogs(
    url: string,
    filter: Record<string, unknown>,
    from: number,
    to: number,
    span: number,
  ): Promise<RawLog[]> {
    const out: RawLog[] = [];
    for (let a = from; a <= to; a += span) {
      const b = Math.min(a + span - 1, to);
      out.push(...(await getRange(url, filter, a, b)));
    }
    return out;
  }
  async function getRange(
    url: string,
    filter: Record<string, unknown>,
    a: number,
    b: number,
  ): Promise<RawLog[]> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await raw(url, "eth_getLogs", [
        { ...filter, fromBlock: hx(a), toBlock: hx(b) },
      ]);
      const res = (r.json as { result?: RawLog[] } | null)?.result;
      if (r.rateLimited) {
        excludedWitnesses.add(url);
        throw new Error(`RATE_LIMITED_LOG_WITNESS ${new URL(url).host}`);
      }
      if (r.status === 200 && Array.isArray(res))
        return validateLogs(res, filter, a, b);
      const msg = JSON.stringify(
        (r.json as { error?: unknown } | null)?.error ?? r.error ?? r.status,
      );
      if (
        /block range|response size|more than \d+ results|maximum.*range|range.*limit/i.test(
          msg,
        ) &&
        b > a
      ) {
        const m = Math.floor((a + b) / 2);
        return [
          ...(await getRange(url, filter, a, m)),
          ...(await getRange(url, filter, m + 1, b)),
        ];
      }
      if (attempt < 2)
        await new Promise((res2) =>
          setTimeout(
            res2,
            1500 * 2 ** attempt + Math.floor(Math.random() * 300),
          ),
        );
    }
    excludedWitnesses.add(url);
    throw new Error(`LOGS_UNAVAILABLE ${new URL(url).host} ${a}-${b}`);
  }
  function driftScan(
    chain: "one" | "bsc",
    contract: string,
    from: number,
    to: number,
    logs: RawLog[],
  ): DriftScan {
    return {
      chain,
      contract,
      from,
      to,
      complete: true,
      events: logs
        .filter((l) => TOPIC_NAME[l.topics[0]])
        .map((l) => ({
          event: TOPIC_NAME[l.topics[0]],
          block: Number(BigInt(l.blockNumber)),
          tx: l.transactionHash,
        })),
    };
  }
  function decodeInitiated(l: RawLog) {
    try {
      const d = decodeEventLog({
        abi: LEDGER_EVENT_ABI,
        data: l.data as Hex,
        topics: l.topics as [Hex, ...Hex[]],
        strict: true,
      });
      return d.eventName === "BridgeInitiated" ? d.args : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- V1.6 accepted baseline (hash-verified)
  function g5Check(): {
    check: G5DecisionCheck;
    baseline: LedgerState;
    selectorInLiveDispatcher: boolean;
    liveAbi: Abi;
  } {
    const manifest = Object.entries(
      JSON.parse(
        readFileSync(
          join(V16_ROOT, "manifests", "SHA256_MANIFEST.json"),
          "utf8",
        ),
      ) as Record<string, string>,
    );
    let verified = 0;
    for (const [f, h] of manifest)
      if (sha256(readFileSync(join(V16_ROOT, "manifests", f))) === h)
        verified++;
    const decisionText = readFileSync(
      join(V16_ROOT, "manifests", "G5_DECISION.json"),
      "utf8",
    );
    const decision = JSON.parse(decisionText);
    const entry = manifest.find(([f]) => f === "G5_DECISION.json");
    const rec = JSON.parse(
      readFileSync(
        join(V16_ROOT, "manifests", "reserve-reconciliation.json"),
        "utf8",
      ),
    );
    const snap = JSON.parse(
      readFileSync(
        join(V16_ROOT, "manifests", "G5_CURRENT_ROUTE_SNAPSHOT.json"),
        "utf8",
      ),
    );
    if (
      rec.pinnedBlock !== V16.ledgerPin ||
      snap.bsc.block !== V16.ledgerPin ||
      rec.ledgerReconciled !== true
    )
      throw new Error("V16_BASELINE_INCONSISTENT");
    const baseline: LedgerState = {
      block: rec.pinnedBlock,
      balance: BigInt(rec.physicalCrossBaseUnits),
      deposited: BigInt(rec.deposited),
      pendingAmount: BigInt(rec.pendingAmount),
      nextFinalize: BigInt(snap.bsc.nextFinalizeIndex),
      nextInitiate: BigInt(snap.bsc.nextInitiateIndex),
      pending: rec.activePendingRecords.map(
        (p: { index: string; value: string }) => ({
          index: BigInt(p.index),
          value: BigInt(p.value),
        }),
      ),
    };
    const matrix = JSON.parse(
      readFileSync(
        join(V16_ROOT, "security", "abi-selector-matrix.json"),
        "utf8",
      ),
    );
    const row = matrix.chains.one.rows.find(
      (r: { selector: string }) => r.selector === BRIDGE_TOKEN_SELECTOR,
    );
    const built = JSON.parse(
      readFileSync(
        join(V16_ROOT, "build", "one", "standard-json-output-native.json"),
        "utf8",
      ),
    );
    const liveAbi = built.contracts["src/CrossBridge.sol"].CrossBridge
      .abi as Abi;
    return {
      check: {
        decisionStatus: decision.status,
        decisionFileSha256Matches: !!entry && sha256(decisionText) === entry[1],
        manifestFilesVerified: verified,
        manifestFilesTotal: manifest.length,
        g5StatusConstant: G5_STATUS,
        decisionPinsMatchRoutePins:
          decision.source.implementation ===
            G5_ROUTE_PINS.source.implementation &&
          decision.source.runtimeHash ===
            G5_ROUTE_PINS.source.implementationCodeHash &&
          decision.destination.implementation ===
            G5_ROUTE_PINS.destination.implementation &&
          decision.destination.runtimeHash ===
            G5_ROUTE_PINS.destination.implementationCodeHash,
      },
      baseline,
      selectorInLiveDispatcher:
        row?.inLiveDispatcher === true &&
        row.signature.startsWith("bridgeToken("),
      liveAbi,
    };
  }
  function expectedErrorSelector(liveAbi: Abi, name: string) {
    const item = liveAbi.find((x) => x.type === "error" && x.name === name) as
      { inputs: { type: string }[] } | undefined;
    if (!item) throw new Error(`ERROR_NOT_IN_EXACT_ABI ${name}`);
    return selectorOf(`${name}(${item.inputs.map((i) => i.type).join(",")})`);
  }
  // ---------------------------------------------------------------- simulation of the exact pilot transaction
  async function simulate(
    url: string,
    block: string,
    data: string,
    amount: bigint,
    nf: bigint,
    ex: bigint,
    liveAbi: Abi,
  ): Promise<SimulationRead> {
    const value = amount + nf + ex;
    const tx = {
      from: PILOT_EOA,
      to: G5_ROUTE_PINS.source.proxy,
      data,
      value: hx(value),
    };
    const outcome = (r: Awaited<ReturnType<typeof raw>>) => {
      const j = r.json as {
        result?: string;
        error?: { code?: number; message?: string; data?: unknown };
      } | null;
      return j && "result" in j && j.result !== undefined
        ? { ok: true, result: j.result }
        : { ok: false, error: j?.error ?? r.error ?? `HTTP ${r.status}` };
    };
    const [ethCall, estimate, gasPrice, prio, header] = await Promise.all([
      raw(url, "eth_call", [tx, block]),
      raw(url, "eth_estimateGas", [tx, block]),
      call<string>(url, "eth_gasPrice", []),
      call<string>(url, "eth_maxPriorityFeePerGas", []),
      call<{ baseFeePerGas?: string; hash: string }>(
        url,
        "eth_getBlockByNumber",
        [block, false],
      ),
    ]);
    const enc = (args: {
      chain?: bigint;
      token?: string;
      to?: string;
      amount?: bigint;
      nf?: bigint;
    }) =>
      encodeFunctionData({
        abi: parseAbi([
          "function bridgeToken(uint256,address,address,uint256,uint256,uint256,bytes) payable returns (bool)",
        ]),
        functionName: "bridgeToken",
        args: [
          args.chain ?? 56n,
          (args.token ?? NATIVE) as Hex,
          (args.to ?? PILOT_EOA) as Hex,
          args.amount ?? amount,
          args.nf ?? nf,
          ex,
          "0x",
        ],
      });
    const controls: Record<string, { data: string; value: bigint }> = {
      belowMinimumByOneWei: {
        data: enc({ amount: amount - 1n }),
        value: value - 1n,
      },
      msgValueMinusOneWei: { data, value: value - 1n },
      networkFeeBelowRequiredByOneWei: {
        data: enc({ nf: nf - 1n }),
        value: value - 1n,
      },
      zeroRecipient: {
        data: enc({ to: "0x0000000000000000000000000000000000000000" }),
        value,
      },
      unsupportedTokenCrossOnOne: { data: enc({ token: CROSS }), value },
      unsupportedDestinationChain97: { data: enc({ chain: 97n }), value },
    };
    const negatives: NegativeRead[] = await Promise.all(
      NEGATIVE_CONTROLS.map(async (c) => {
        const r = await raw(url, "eth_call", [
          {
            from: PILOT_EOA,
            to: G5_ROUTE_PINS.source.proxy,
            data: controls[c.name].data,
            value: hx(controls[c.name].value),
          },
          block,
        ]);
        const err = (r.json as { error?: { data?: unknown } } | null)?.error;
        const errData = typeof err?.data === "string" ? err.data : null;
        let errorName: string | null = null,
          decoded: string | null = null;
        if (errData)
          try {
            const e = decodeErrorResult({ abi: liveAbi, data: errData as Hex });
            errorName = e.errorName;
            decoded = `${e.errorName}(${(e.args ?? []).map(String).join(",")})`;
          } catch {
            decoded = "UNDECODED";
          }
        return {
          name: c.name,
          rejected: Boolean(err),
          selector: errData ? errData.slice(0, 10) : null,
          errorName,
          decoded,
          expectedError: c.error,
          expectedSelector: expectedErrorSelector(liveAbi, c.error),
        };
      }),
    );
    // exact-argument check for the msg.value control: BaseBridgeInvalidValue(expected, provided)
    const mv = negatives.find((n) => n.name === "msgValueMinusOneWei");
    if (mv && mv.decoded !== `BaseBridgeInvalidValue(${value},${value - 1n})`)
      mv.errorName = `UNEXPECTED_ARGS:${mv.decoded}`;
    const after = await call<{ hash: string }>(url, "eth_getBlockByNumber", [
      block,
      false,
    ]);
    return {
      url,
      block: Number(BigInt(block)),
      blockHash: header.hash,
      blockHashAfter: after.hash,
      ethCall: outcome(ethCall),
      estimateGas: outcome(estimate),
      negatives,
      gasPrice: BigInt(gasPrice).toString(),
      maxPriorityFeePerGas: BigInt(prio).toString(),
      baseFeePerGas: BigInt(header.baseFeePerGas ?? "0x0").toString(),
    };
  }

  // ---------------------------------------------------------------- in-flight (ONE initiated, not BSC finalized)
  async function inFlight(
    oneLogs: RawLog[],
    bscNextFinalize: bigint,
    oneNextInitiate: bigint,
    oneBlock: number,
  ): Promise<InFlight> {
    const items: InFlight["items"] = [];
    let enumerated = true;
    for (let i = bscNextFinalize; i < oneNextInitiate; i++) {
      let found = oneLogs.filter(
        (l) =>
          l.topics[0] === INITIATED &&
          BigInt(l.topics[1]) === 56n &&
          BigInt(l.topics[2]) === i,
      );
      if (found.length === 0)
        found = await getLogs(
          ENDPOINTS.one[0],
          {
            address: G5_ROUTE_PINS.source.proxy,
            topics: [INITIATED, pad(toHex(56n)), pad(toHex(i))],
          },
          Math.max(0, oneBlock - 200000),
          oneBlock,
          300000,
        );
      const a = found.length === 1 ? decodeInitiated(found[0]) : null;
      if (!a) {
        enumerated = false;
        items.push({ index: i.toString(), found: found.length });
        continue;
      }
      items.push({
        index: i.toString(),
        found: 1,
        value: a.value.toString(),
        toToken: a.toToken.toLowerCase(),
        tx: found[0].transactionHash,
      });
    }
    return {
      enumerated,
      bscNextFinalize: bscNextFinalize.toString(),
      oneNextInitiate: oneNextInitiate.toString(),
      items,
    };
  }

  // ---------------------------------------------------------------- phase A (once per run)
  type Baseline = {
    g5: ReturnType<typeof g5Check>;
    bscA: Awaited<ReturnType<typeof readBoth>>;
    oneA: Awaited<ReturnType<typeof readBoth>>;
    Fa: number;
    Aa: number;
    noderealHashA: string;
    bscProxyLogs: RawLog[];
    crossIn: RawLog[];
    crossOut: RawLog[];
    bscVerifierLogs: RawLog[];
    oneProxyLogs: RawLog[];
    oneVerifierLogs: RawLog[];
    ledgerA: LedgerDeltaResult;
  };
  let base: Baseline | null = null;
  const PAD_PROXY = pad(G5_ROUTE_PINS.destination.proxy as Hex);
  const liveState = (s: SideRead, block: number): LedgerState => ({
    block,
    balance: BigInt(s.token!.balanceOfBridge),
    deposited: BigInt(s.pair.deposited),
    pendingAmount: BigInt(s.pair.pendingAmount),
    nextFinalize: BigInt(s.nextFinalizeIndex),
    nextInitiate: BigInt(s.nextInitiateIndex),
    pending: s.pending
      .filter((p) => p.toToken === CROSS.toLowerCase())
      .map((p) => ({ index: BigInt(p.index), value: BigInt(p.value) })),
  });
  const consts = {
    proxy: G5_ROUTE_PINS.destination.proxy,
    cross: CROSS,
    dev: EXTENDED_PINS.bsc.dev,
    sourceChainId: 612055n,
  };

  async function performBaseline() {
    const g5 = g5Check();
    if (
      checkpoint &&
      (checkpoint.routeDigest !== cacheDigest(G5_ROUTE_PINS) ||
        checkpoint.acceptedThroughBlock < V16.ledgerPin ||
        checkpoint.oneThroughBlock < V16.snapshotPin.one)
    )
      checkpoint = null;
    io.log("phase A: BSC pin (finalized) + dual-source state");
    const bscA = await readBoth("bsc", checkpoint?.acceptedThroughBlock);
    io.log("phase A: ONE pin (head-3) + dual-source state");
    const oneA = await readBoth("one");
    const Fa = Number(BigInt(bscA.block)),
      Aa = Number(BigInt(oneA.block));
    const witness = bscA.pin!.witnesses[0].url;
    if (checkpoint) {
      const cp = checkpoint;
      // Cache checksums detect corruption, not authenticity. Validate each saved event against
      // its exact contract, topic filter and accepted range before replay or delta extension.
      validateLogs(
        cp.logs.bscProxyLogs,
        { address: G5_ROUTE_PINS.destination.proxy },
        V16.ledgerPin + 1,
        cp.acceptedThroughBlock,
      );
      validateLogs(
        cp.logs.crossIn,
        { address: CROSS, topics: [TRANSFER, null, PAD_PROXY] },
        V16.ledgerPin + 1,
        cp.acceptedThroughBlock,
      );
      validateLogs(
        cp.logs.crossOut,
        { address: CROSS, topics: [TRANSFER, PAD_PROXY] },
        V16.ledgerPin + 1,
        cp.acceptedThroughBlock,
      );
      validateLogs(
        cp.logs.bscVerifierLogs,
        {
          address: G5_ROUTE_PINS.destination.verifier,
          topics: [WATCHED_TOPICS],
        },
        V16.ledgerPin + 1,
        cp.acceptedThroughBlock,
      );
      validateLogs(
        cp.logs.oneProxyLogs,
        { address: G5_ROUTE_PINS.source.proxy },
        V16.snapshotPin.one + 1,
        cp.oneThroughBlock,
      );
      validateLogs(
        cp.logs.oneVerifierLogs,
        { address: G5_ROUTE_PINS.source.verifier, topics: [WATCHED_TOPICS] },
        V16.snapshotPin.one + 1,
        cp.oneThroughBlock,
      );
      const anchors = await Promise.all([
        ...bscA.pin!.sources.map((s) =>
          call<{ hash: string }>(s.url, "eth_getBlockByNumber", [
            hx(cp.acceptedThroughBlock),
            false,
          ]),
        ),
        call<{ hash: string }>(witness, "eth_getBlockByNumber", [
          hx(cp.acceptedThroughBlock),
          false,
        ]),
        ...ENDPOINTS.one.map((url) =>
          call<{ hash: string }>(url, "eth_getBlockByNumber", [
            hx(cp.oneThroughBlock),
            false,
          ]),
        ),
      ]);
      const hashes = anchors.map((h) => h?.hash?.toLowerCase());
      if (
        hashes.slice(0, 3).some((h) => h !== hashes[0]) ||
        hashes[3] !== hashes[4]
      )
        throw new Error("CHECKPOINT_CANONICAL_SOURCE_HASH_DISAGREEMENT");
      const cachedLedger = reconcileLedgerDelta(
        g5.baseline,
        {
          block: cp.acceptedThroughBlock,
          balance: BigInt(cp.reserveBalance),
          deposited: BigInt(cp.deposited),
          pendingAmount: BigInt(cp.pendingAmount),
          nextFinalize: BigInt(cp.nextIndexes.finalize),
          nextInitiate: BigInt(cp.nextIndexes.initiate),
          pending: cp.openPending.map((p) => ({
            index: BigInt(p.index),
            value: BigInt(p.value),
          })),
        },
        cp.logs.bscProxyLogs,
        [...cp.logs.crossIn, ...cp.logs.crossOut],
        consts,
      );
      if (
        !cachedLedger.reconciled ||
        hashes[0] !== cp.acceptedThroughBlockHash.toLowerCase() ||
        hashes[3] !== cp.oneThroughBlockHash.toLowerCase() ||
        Aa < cp.oneThroughBlock
      ) {
        io.log(
          "cached checkpoint invalidated; reconstructing from accepted V1.6 evidence",
        );
        checkpoint = null;
      }
      io.record("checkpoint-validation", {
        hit: !!checkpoint,
        bscAnchor: hashes[0],
        oneAnchor: hashes[3],
        accounting: cachedLedger.checks,
      });
    }
    const bscFrom = (checkpoint?.acceptedThroughBlock ?? V16.ledgerPin) + 1;
    const oneFrom = (checkpoint?.oneThroughBlock ?? V16.snapshotPin.one) + 1;
    const noderealHashA = (
      await call<{ hash: string }>(witness, "eth_getBlockByNumber", [
        bscA.block,
        false,
      ])
    ).hash;
    io.log(
      `phase A: ${checkpoint ? "incremental checkpoint" : "accepted V1.6"} logs from BSC ${bscFrom}, ONE ${oneFrom}`,
    );
    const [
      bscProxyLogs,
      crossIn,
      crossOut,
      bscVerifierLogs,
      oneProxyLogs,
      oneVerifierLogs,
    ] = await Promise.all([
      getLogs(
        witness,
        { address: G5_ROUTE_PINS.destination.proxy },
        bscFrom,
        Fa,
        50000,
      ),
      getLogs(
        witness,
        { address: CROSS, topics: [TRANSFER, null, PAD_PROXY] },
        bscFrom,
        Fa,
        50000,
      ),
      getLogs(
        witness,
        { address: CROSS, topics: [TRANSFER, PAD_PROXY] },
        bscFrom,
        Fa,
        50000,
      ),
      getLogs(
        witness,
        {
          address: G5_ROUTE_PINS.destination.verifier,
          topics: [WATCHED_TOPICS],
        },
        bscFrom,
        Fa,
        50000,
      ),
      getLogs(
        ENDPOINTS.one[0],
        { address: G5_ROUTE_PINS.source.proxy },
        oneFrom,
        Aa,
        300000,
      ),
      getLogs(
        ENDPOINTS.one[0],
        { address: G5_ROUTE_PINS.source.verifier, topics: [WATCHED_TOPICS] },
        oneFrom,
        Aa,
        300000,
      ),
    ]).then((windows) =>
      windows.map((logs, i) => [
        ...(checkpoint?.logs[
          (
            [
              "bscProxyLogs",
              "crossIn",
              "crossOut",
              "bscVerifierLogs",
              "oneProxyLogs",
              "oneVerifierLogs",
            ] as const
          )[i]
        ] ?? []),
        ...logs,
      ]),
    );
    const ledgerA = reconcileLedgerDelta(
      g5.baseline,
      liveState(bscA.reads[0], Fa),
      bscProxyLogs,
      [...crossIn, ...crossOut],
      consts,
    );
    base = {
      g5,
      bscA,
      oneA,
      Fa,
      Aa,
      noderealHashA,
      bscProxyLogs,
      crossIn,
      crossOut,
      bscVerifierLogs,
      oneProxyLogs,
      oneVerifierLogs,
      ledgerA,
    };
    io.record("baseline", {
      g5: g5.check,
      bscA,
      oneA,
      noderealHashA,
      logs: {
        bscProxyLogs,
        crossIn,
        crossOut,
        bscVerifierLogs,
        oneProxyLogs,
        oneVerifierLogs,
      },
      ledgerA,
    });
    io.log(
      `phase A: ledger reconciled=${ledgerA.reconciled} BSC ${Fa} ONE ${Aa}`,
    );
  }

  // ---------------------------------------------------------------- phase B (every preflight)
  async function performRun(kind: PreflightKind): Promise<PreflightOutcome> {
    const startedAt = Date.now();
    const id = `pf-${kind}-${new Date(startedAt).toISOString().replace(/[-:.]/g, "")}-${randomBytes(2).toString("hex")}`;
    try {
      if (!base) await baseline();
      const B = base!;
      // BSC reserve side first (never pinned below the phase-A pin: the ledger delta only moves forward)
      const bscB = await readBoth("bsc", B.Fa);
      const Fb = Number(BigInt(bscB.block));
      const bsc = bscB.reads[0];
      const witness = bscB.pin!.witnesses[0].url;
      const extFrom = B.Fa + 1;
      const ext = (filter: Record<string, unknown>) =>
        Fb >= extFrom
          ? getLogs(witness, filter, extFrom, Fb, 50000)
          : Promise.resolve([]);
      const [pB, inB, outB, vB, noderealHashB] = await Promise.all([
        ext({ address: G5_ROUTE_PINS.destination.proxy }),
        ext({ address: CROSS, topics: [TRANSFER, null, PAD_PROXY] }),
        ext({ address: CROSS, topics: [TRANSFER, PAD_PROXY] }),
        ext({
          address: G5_ROUTE_PINS.destination.verifier,
          topics: [WATCHED_TOPICS],
        }),
        call<{ hash: string }>(witness, "eth_getBlockByNumber", [
          bscB.block,
          false,
        ]).then((b) => b.hash),
      ]);
      const ledgerB = reconcileLedgerDelta(
        liveState(B.bscA.reads[0], B.Fa),
        liveState(bsc, Fb),
        pB,
        [...inB, ...outB],
        consts,
      );
      // The phase-B ledger is valid only when the phase-A ledger (from the accepted V1.6 pin) also reconciled.
      const ledger: LedgerDeltaResult = {
        ...ledgerB,
        from: B.ledgerA.from,
        checks: {
          ...ledgerB.checks,
          PHASE_A_FROM_V16_PIN_RECONCILED: B.ledgerA.reconciled,
          LOG_SOURCE_BLOCK_HASH_MATCHES_PIN:
            B.noderealHashA === B.bscA.reads[0].blockHash &&
            noderealHashB === bsc.blockHash,
        },
      };
      ledger.reconciled = Object.values(ledger.checks).every(Boolean);

      // ONE quote side last: the quote is observed here, immediately before the fresh ONE pin.
      const quoteObservedAt = Date.now();
      const oneB = await readBoth("one");
      const Ab = Number(BigInt(oneB.block));
      const one = oneB.reads[0] as PilotSide;
      const pf = one.pilotFees!;
      const fees: PilotFees = {
        minimum: BigInt(one.fees!.minimum),
        networkFee: BigInt(pf.networkFee),
        serviceFee: BigInt(pf.exFee),
      };
      const quote = pilotQuote(fees, quoteObservedAt, one);
      const intentArgs = {
        account: PILOT_EOA,
        recipient: PILOT_EOA,
        amount: quote.amount,
        networkFee: quote.networkFee,
        serviceFee: quote.serviceFee,
      };
      const data = encodePilotCalldata(intentArgs);
      const oneExt = (filter: Record<string, unknown>) =>
        Ab > B.Aa
          ? getLogs(ENDPOINTS.one[0], filter, B.Aa + 1, Ab, 300000)
          : Promise.resolve([]);
      const [sims, oB, ovB] = await Promise.all([
        Promise.all(
          ENDPOINTS.one.map((u) =>
            simulate(
              u,
              oneB.block,
              data,
              quote.amount,
              quote.networkFee,
              quote.serviceFee,
              B.g5.liveAbi,
            ),
          ),
        ),
        oneExt({ address: G5_ROUTE_PINS.source.proxy }),
        oneExt({
          address: G5_ROUTE_PINS.source.verifier,
          topics: [WATCHED_TOPICS],
        }),
      ]);
      const inFlightB = await inFlight(
        [...B.oneProxyLogs, ...oB],
        BigInt(bsc.nextFinalizeIndex),
        BigInt(one.nextInitiateIndex),
        Ab,
      );
      const driftScans: DriftScan[] = [
        driftScan(
          "one",
          G5_ROUTE_PINS.source.proxy,
          V16.snapshotPin.one + 1,
          Ab,
          [...B.oneProxyLogs, ...oB],
        ),
        driftScan(
          "one",
          G5_ROUTE_PINS.source.verifier,
          V16.snapshotPin.one + 1,
          Ab,
          [...B.oneVerifierLogs, ...ovB],
        ),
        driftScan(
          "bsc",
          G5_ROUTE_PINS.destination.proxy,
          V16.snapshotPin.bsc + 1,
          Fb,
          [...B.bscProxyLogs, ...pB],
        ),
        driftScan(
          "bsc",
          G5_ROUTE_PINS.destination.verifier,
          V16.snapshotPin.bsc + 1,
          Fb,
          [...B.bscVerifierLogs, ...vB],
        ),
      ];
      const { outcome, details } = composeOutcome(
        {
          g5: B.g5.check,
          liveAbi: B.g5.liveAbi,
          selectorInLiveDispatcher: B.g5.selectorInLiveDispatcher,
          one: oneB.reads,
          bsc: bscB.reads,
          bscFinalizedOk: bscB.finalizedOk,
          bscPin: bscB.pin,
          sims,
          simulatedCalldata: data,
          ledger,
          inFlight: inFlightB,
          driftScans,
          quoteObservedAt,
          rpcMethodsUsed: Object.fromEntries(rpc.counts),
          methodLog,
        },
        kind,
        id,
        startedAt,
        Date.now,
        { candidateBaseline: io.candidateBaseline, execution },
      );
      io.record(`preflight/${id}`, {
        outcome,
        observations: {
          bscB,
          oneB,
          sims,
          ledger,
          logs: { pB, inB, outB, vB, oB, ovB },
          inFlightB,
          driftScans,
          ...details,
        },
      });
      // Cache public canonical observations only after every financial gate passed. P20 is still evaluated and
      // still blocks the session for an unapproved protected-file proposal; caching cannot alter that gate.
      if (
        ledger.reconciled &&
        outcome.gates
          .filter((g) => g.id !== "P20" && g.id !== "R1")
          .every((g) => g.status === "PASS")
      ) {
        const state = liveState(bsc, Fb);
        const logs = {
          bscProxyLogs: [...B.bscProxyLogs, ...pB],
          crossIn: [...B.crossIn, ...inB],
          crossOut: [...B.crossOut, ...outB],
          bscVerifierLogs: [...B.bscVerifierLogs, ...vB],
          oneProxyLogs: [...B.oneProxyLogs, ...oB],
          oneVerifierLogs: [...B.oneVerifierLogs, ...ovB],
        };
        const cp: G7Checkpoint = {
          schema: "otherbridge.g7.checkpoint.v1",
          routeDigest: cacheDigest(G5_ROUTE_PINS),
          acceptedThroughBlock: Fb,
          acceptedThroughBlockHash: bsc.blockHash,
          oneThroughBlock: Ab,
          oneThroughBlockHash: one.blockHash,
          deposited: state.deposited.toString(),
          pendingAmount: state.pendingAmount.toString(),
          reserveBalance: state.balance.toString(),
          openPending: state.pending.map((p) => ({
            index: p.index.toString(),
            value: p.value.toString(),
          })),
          nextIndexes: {
            finalize: state.nextFinalize.toString(),
            initiate: state.nextInitiate.toString(),
          },
          eventDigest: cacheDigest(logs),
          sourceEvidence: {
            stateOperators: bscB.pin!.operatorGroups,
            witnessOperator: bscB.pin!.witnesses[0].operatorGroup,
            observedAt: Date.now(),
          },
          logs,
        };
        cache.save(cp);
        io.record("checkpoint-saved", {
          acceptedThroughBlock: Fb,
          acceptedThroughBlockHash: cp.acceptedThroughBlockHash,
          eventDigest: cp.eventDigest,
          sourceEvidence: cp.sourceEvidence,
        });
      }
      return outcome;
    } catch (e) {
      const outcome = failedOutcome(kind, startedAt, e, execution.snapshot());
      io.record(`preflight/${outcome.id}`, { outcome });
      return outcome;
    }
  }
  let baselineFlight: Promise<void> | null = null;
  function baseline() {
    if (base) return Promise.resolve();
    if (!baselineFlight)
      baselineFlight = performBaseline().finally(() => {
        baselineFlight = null;
      });
    return baselineFlight;
  }
  let fullFlight: {
    kind: PreflightKind;
    promise: Promise<PreflightOutcome>;
  } | null = null;
  async function run(kind: PreflightKind): Promise<PreflightOutcome> {
    if (fullFlight) {
      if (fullFlight.kind === kind) return fullFlight.promise;
      await fullFlight.promise; // a final check always starts fresh after an earlier UI check.
      return run(kind);
    }
    // A refresh re-probes failed sources after their cooldown; successful checkpoint data remains canonical.
    witnessCandidates = null;
    excludedWitnesses.clear();
    const attempt = async () => {
      for (let i = 0; i < 3; i++) {
        const result = await performRun(kind);
        if (
          !result.error ||
          !/^(RATE_LIMITED_LOG_WITNESS|LOGS_UNAVAILABLE)/.test(result.error) ||
          !excludedWitnesses.size ||
          i === 2
        )
          return result;
        io.log(
          "log source unavailable; retrying with another THIRD independent witness",
        );
        base = null;
        checkpoint = cache.load();
        witnessCandidates = null;
      }
      throw new Error("UNREACHABLE_WITNESS_RETRY");
    };
    const promise = attempt().finally(() => {
      fullFlight = null;
    });
    fullFlight = { kind, promise };
    return promise;
  }
  return {
    baseline,
    run,
    execution,
    baselineScope: io.candidateBaseline?.scope ?? "accepted",
  };
}
