// TEST-ONLY deterministic sources for the G7 pilot harness (no network). They feed synthetic observations through
// the SAME composition (P1-P20 + S1-S8 + review/digest) and the SAME tracking classification as the live sources.
// In fixture mode the browser page accepts only the mock wallet identity, so fixture data never reaches a wallet
// that could broadcast.
import { parseAbi, type Abi } from "viem";
import { G5_ROUTE_PINS } from "../../src/g5/route-pins";
import { G5_STATUS } from "../../src/g5/status";
import { selectorOf } from "../../src/g7/decoder";
import { reconcileLedgerDelta, type LedgerState } from "../../src/g7/ledger";
import {
  CROSS,
  ENDPOINTS,
  EXTENDED_PINS,
  NATIVE,
  NEGATIVE_CONTROLS,
  ROLE_NAMES,
  TRUST_ACCOUNTS,
} from "../../src/g7/policy";
import {
  encodePilotCalldata,
  type SideRead,
  type SimulationRead,
} from "../../src/g7/prep";
import { classifyTracking, type TrackInput } from "../../src/g7/track";
import {
  composeOutcome,
  type Observations,
  type PilotSide,
  type PreflightSource,
} from "./preflight";
import {
  compareMinedTransaction,
  type TrackerSource,
  type TrackSnapshot,
} from "./tracker";
import { PILOT_SCOPE } from "./policy";
import { ExecutionEvidence } from "../../src/g7/write-evidence";
import type { CandidateBaseline } from "../g7-safety-scan";

export const FIXTURE_SCENARIOS = [
  "ready",
  "fee-above-bound",
  "minimum-above-bound",
  "service-fee",
  "debit-above-bound",
  "drift",
  "final-intent-changed",
  "final-reapproval",
  "final-slow",
  "final-stale",
  "mined-mismatch",
  "bridge-pending",
  "orphan",
  "authority-drift",
  "reserve-failure",
  "pending-obligation",
  "in-flight-unenumerated",
] as const;
export type FixtureScenario = (typeof FIXTURE_SCENARIOS)[number];

const P = G5_ROUTE_PINS;
const E = EXTENDED_PINS;
const ONE = 10n ** 18n;
const ABI_TRUE = "0x" + "0".repeat(63) + "1";
const HASH_A = "0x" + "aa".repeat(32);
const HASH_B = "0x" + "bb".repeat(32);
const roles = (r: Record<string, readonly string[]>) =>
  Object.fromEntries(ROLE_NAMES.map((n) => [n, [...(r[n] ?? [])]]));
const SEL: Record<string, string> = {
  BaseBridgeInvalidAmount: selectorOf("BaseBridgeInvalidAmount()"),
  BaseBridgeInvalidValue: selectorOf("BaseBridgeInvalidValue(uint256,uint256)"),
  BaseBridgeCanNotZeroAddress: selectorOf("BaseBridgeCanNotZeroAddress()"),
  RegistryNotExistToken: selectorOf("RegistryNotExistToken(address)"),
};
const FIXTURE_ABI = parseAbi([
  "function bridgeToken(uint256 toChainID,address fromToken,address to,uint256 value,uint256 networkFee,uint256 exFee,bytes extraData) payable returns (bool)",
]) as Abi;

interface Variant {
  minimum: bigint;
  networkFee: bigint;
  exFee: bigint;
  exFeeRate: bigint;
  estimate: bigint;
  implementationCodeHash: string;
  observedAgoMs: number;
  mutate?: (obs: Observations) => void;
}
const BASE: Variant = {
  minimum: 5n * ONE,
  networkFee: 18n * 10n ** 16n,
  exFee: 0n,
  exFeeRate: 0n,
  estimate: 126551n,
  implementationCodeHash: P.source.implementationCodeHash,
  observedAgoMs: 4000,
};

function oneSide(url: string, v: Variant, nowMs: number): PilotSide {
  return {
    url,
    chainId: 612055,
    block: 45720000,
    blockHash: HASH_A,
    blockTimestamp: Math.floor(nowMs / 1000) - 5,
    proxyCodeHash: P.source.proxyCodeHash,
    implementationSlot:
      "0x" + "0".repeat(24) + P.source.implementation.slice(2),
    implementation: P.source.implementation,
    implementationCodeHash: v.implementationCodeHash,
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
    nextInitiateIndex: "98800",
    nextFinalizeIndex: "40837",
    pending: [],
    trustAccountCodes: Object.fromEntries(
      TRUST_ACCOUNTS.map((a) => [a.toLowerCase(), "0x"]),
    ),
    accountCode: "0x",
    fees: {
      minimum: v.minimum.toString(),
      networkFee: v.networkFee.toString(),
      exFee: ((v.minimum * v.exFeeRate) / 10000n).toString(),
      minimumAtAmount: v.minimum.toString(),
      networkFeeAtAmount: v.networkFee.toString(),
      configMinimum: v.minimum.toString(),
      configNetworkFee: v.networkFee.toString(),
      exFeeRate: v.exFeeRate.toString(),
    },
    pilotFees: {
      amount: PILOT_SCOPE.principal.toString(),
      minimum: v.minimum.toString(),
      networkFee: v.networkFee.toString(),
      exFee: v.exFee.toString(),
    },
    balance: (10n * ONE).toString(), // the owner funds ~10 ONE; the principal stays 5 ONE
    nonce: "3",
    dispatcherHasBridgeToken: true,
  };
}
function bscSide(url: string, v: Variant, nowMs: number): SideRead {
  return {
    ...oneSide(
      url,
      { ...v, implementationCodeHash: P.source.implementationCodeHash },
      nowMs,
    ),
    chainId: 56,
    block: 125900000,
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
    nextFinalizeIndex: "98800",
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
function sim(url: string, v: Variant): SimulationRead {
  return {
    url,
    block: 45720000,
    blockHash: HASH_A,
    blockHashAfter: HASH_A,
    ethCall: { ok: true, result: ABI_TRUE },
    estimateGas: { ok: true, result: "0x" + v.estimate.toString(16) },
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
function observations(v: Variant, nowMs: number): Observations {
  const ledgerState: LedgerState = {
    block: 125900000,
    balance: 913927738855791322580189858n,
    deposited: 913927728855791322580189858n,
    pendingAmount: 0n,
    nextFinalize: 98800n,
    nextInitiate: 40837n,
    pending: [{ index: 20n, value: 0n }],
  };
  const scan = (chain: "one" | "bsc", contract: string) => ({
    chain,
    contract,
    from: 1,
    to: 2,
    complete: true,
    events: [],
  });
  return {
    g5: {
      decisionStatus: "PASS",
      decisionFileSha256Matches: true,
      manifestFilesVerified: 10,
      manifestFilesTotal: 10,
      g5StatusConstant: G5_STATUS,
      decisionPinsMatchRoutePins: true,
    },
    liveAbi: FIXTURE_ABI,
    selectorInLiveDispatcher: true,
    one: ENDPOINTS.one.map((u) => oneSide(u, v, nowMs)),
    bsc: ENDPOINTS.bsc.map((u) => bscSide(u, v, nowMs)),
    bscFinalizedOk: true,
    sims: ENDPOINTS.one.map((u) => sim(u, v)),
    simulatedCalldata: "", // filled by the caller with the exact calldata (S8)
    ledger: reconcileLedgerDelta(
      { ...ledgerState, block: 125745332 },
      ledgerState,
      [],
      [],
      {
        proxy: P.destination.proxy,
        cross: CROSS,
        dev: E.bsc.dev,
        sourceChainId: 612055n,
      },
    ),
    inFlight: {
      enumerated: true,
      bscNextFinalize: "98800",
      oneNextInitiate: "98800",
      items: [],
    },
    driftScans: [
      scan("one", P.source.proxy),
      scan("one", P.source.verifier),
      scan("bsc", P.destination.proxy),
      scan("bsc", P.destination.verifier),
    ],
    quoteObservedAt: nowMs - v.observedAgoMs,
    rpcMethodsUsed: {},
    methodLog: [],
  };
}

function variantFor(
  scenario: FixtureScenario,
  kind: string,
  finals: number,
): Variant {
  const v = { ...BASE };
  const final = kind === "final";
  switch (scenario) {
    case "fee-above-bound":
      return { ...v, networkFee: 19n * 10n ** 16n };
    case "minimum-above-bound":
      return { ...v, minimum: 6n * ONE };
    case "service-fee":
      return { ...v, exFeeRate: 20n, exFee: (5n * ONE * 20n) / 10000n };
    case "debit-above-bound":
      return { ...v, estimate: 126552n };
    case "drift":
      return { ...v, implementationCodeHash: "0x" + "11".repeat(32) };
    case "final-intent-changed":
      return final || finals > 0 ? { ...v, networkFee: 17n * 10n ** 16n } : v;
    case "final-reapproval":
      return final ? { ...v, networkFee: 2n * 10n ** 17n } : v;
    case "final-slow":
      return final ? { ...v, observedAgoMs: 18_000 } : v;
    case "final-stale":
      return final ? { ...v, observedAgoMs: 25_000 } : v;
    case "authority-drift":
      return {
        ...v,
        mutate: (o) =>
          o.bsc.forEach((side) => {
            side.bridgeRoles.VALIDATOR_ROLE = [
              ...side.bridgeRoles.VALIDATOR_ROLE.slice(0, 2),
              "0x1111111111111111111111111111111111111111",
            ];
          }),
      };
    case "reserve-failure":
      return {
        ...v,
        mutate: (o) =>
          o.bsc.forEach(
            (side) => (side.token = { ...side.token!, balanceOfBridge: "1" }),
          ),
      };
    case "pending-obligation":
      return {
        ...v,
        mutate: (o) =>
          o.bsc.forEach((side) =>
            side.pending.push({
              index: "999999",
              toToken: CROSS.toLowerCase(),
              to: "0x1111111111111111111111111111111111111111",
              value: "1",
              status: 1,
            }),
          ),
      };
    case "in-flight-unenumerated":
      return {
        ...v,
        mutate: (o) => {
          o.inFlight = {
            ...o.inFlight,
            enumerated: false,
            items: [{ index: "98800", found: 0 }],
          };
        },
      };
    default:
      return v;
  }
}

export function fixturePreflight(
  scenario: FixtureScenario,
  clock: () => number = Date.now,
  context: {
    candidateBaseline?: CandidateBaseline;
    execution?: ExecutionEvidence;
  } = {},
): PreflightSource {
  if (
    context.candidateBaseline &&
    context.candidateBaseline.scope !== "fixture-validation"
  )
    throw new Error("CANDIDATE_FIXTURE_SCOPE_REQUIRED");
  const execution = context.execution ?? new ExecutionEvidence();
  let runs = 0,
    finals = 0;
  return {
    execution,
    baselineScope: context.candidateBaseline?.scope ?? "accepted",
    baseline: async () => {},
    async run(kind) {
      const startedAt = clock();
      await new Promise((r) => setTimeout(r, kind === "final" ? 400 : 150));
      const v = variantFor(scenario, kind, finals);
      if (kind === "final") finals++;
      const now = clock();
      const obs = observations(v, now);
      v.mutate?.(obs);
      const id = `pf-${kind}-fixture-${++runs}`;
      // The exact calldata the live source would have simulated (composeOutcome re-derives and compares it, S8).
      obs.simulatedCalldata = encodePilotCalldata({
        account: PILOT_SCOPE.account,
        recipient: PILOT_SCOPE.recipient,
        amount: PILOT_SCOPE.principal,
        networkFee: v.networkFee,
        serviceFee: v.exFee,
      });
      return composeOutcome(obs, kind, id, startedAt, clock, {
        ...context,
        execution,
      }).outcome;
    },
  };
}

export function fixtureTracker(scenario: FixtureScenario): TrackerSource {
  let calls = 0;
  return {
    async track({ txHash, tx }) {
      calls++;
      const minedTx = {
        from: tx.from,
        to: tx.to,
        value:
          scenario === "mined-mismatch"
            ? "0x" + (BigInt(tx.value) + 1n).toString(16)
            : tx.value,
        input: tx.data,
        gas: tx.gas,
        maxFeePerGas: tx.maxFeePerGas,
        chainId: tx.chainId,
      };
      const txCheck = compareMinedTransaction(calls >= 1 ? minedTx : null, tx);
      const expected = {
        account: PILOT_SCOPE.account,
        recipient: PILOT_SCOPE.recipient,
        amount: PILOT_SCOPE.principal.toString(),
      };
      const decoded = {
        index: "98800",
        recipient: PILOT_SCOPE.recipient,
        amount: expected.amount,
        destinationChain: 56,
      };
      const input: TrackInput =
        calls === 1
          ? {
              elapsedSeconds: 2,
              expected,
              source: {
                found: false,
                endpointsAgree: false,
                status: null,
                canonical: false,
              },
            }
          : {
              elapsedSeconds: 10 * calls,
              expected,
              source: {
                found: true,
                endpointsAgree: true,
                status: "0x1",
                canonical: true,
                decoded,
              },
              destination:
                calls === 2
                  ? { searched: true, event: null }
                  : scenario === "bridge-pending"
                    ? { searched: true, event: "BridgePending" }
                    : {
                        searched: true,
                        event: "BridgeFinalized",
                        receiptSuccess: true,
                        finalized: true,
                        payoutExact: true,
                        implementationConsistent: true,
                      },
            };
      const c = classifyTracking(input);
      const completed = c.status === "COMPLETED";
      const status = txCheck.exact ? c.status : "MANUAL_REVIEW_REQUIRED";
      const snap: TrackSnapshot = {
        at: new Date().toISOString(),
        txHash,
        status,
        g7Pass: completed && txCheck.exact,
        reasons: txCheck.exact
          ? c.reasons
          : [
              ...c.reasons,
              ...txCheck.mismatches.map(
                (m) => `MINED_TRANSACTION_${m}_DIFFERS_FROM_ARMED`,
              ),
            ],
        nextStep: c.nextStep,
        autoRetry: false,
        autoRelease: false,
        txCheck,
        source: {
          found: calls > 1,
          endpointsAgree: calls > 1,
          status: calls > 1 ? "0x1" : null,
          block: calls > 1 ? 45720010 : null,
          blockHash: calls > 1 ? HASH_A : null,
          confirmations: calls > 1 ? 64 : null,
          canonical: calls > 1,
          implementationConsistent: calls > 1 ? true : null,
          index: calls > 1 ? decoded.index : null,
          recipient: calls > 1 ? decoded.recipient : null,
          amount: calls > 1 ? decoded.amount : null,
          decodeError: null,
        },
        destination: {
          searched: calls > 1,
          searchFrom: calls > 1 ? 125900000 : null,
          searchTo: calls > 1 ? 125900100 : null,
          event:
            calls > 2
              ? scenario === "bridge-pending"
                ? "BridgePending"
                : "BridgeFinalized"
              : null,
          txHash: calls > 2 ? HASH_B : null,
          block: calls > 2 ? 125900050 : null,
          finalizedBlock: calls > 2 ? 125900060 : null,
          finalized: calls > 2 ? true : null,
          payout:
            calls > 2 && scenario !== "bridge-pending"
              ? {
                  logIndex: 3,
                  token: CROSS,
                  from: P.destination.proxy,
                  recipient: PILOT_SCOPE.recipient,
                  amount: expected.amount,
                }
              : null,
          implementationConsistent: calls > 2 ? true : null,
          decodeError: null,
        },
      };
      return snap;
    },
    async detect() {
      return scenario === "orphan"
        ? {
            transfers: [
              {
                txHash: "0x" + "cd".repeat(32),
                index: "98800",
                block: 45720010,
              },
            ],
            nonces: ["4", "4"],
          }
        : { transfers: [], nonces: ["3", "3"] };
    },
  };
}
