// VEINED-MC1 (BRIDGE LANE): TEST-ONLY in-memory doubles for the bridge lane engine — two programmable two-operator FAKE
// CHAINS (the pair's source and destination, any ENABLED pair), a programmable LI.FI quote double that builds REAL
// AcrossFacetV4 calldata with an INDEPENDENT ABI, the in-memory journal of ./swap-lane-fake.ts and a recording fake
// signer. Not a test file itself (no *.test.ts).
// Every read the engine makes is checked against the bridge lane's own read shape for that chain (bridgeReadProblem):
// a read the production transport would refuse is recorded in `violations` and fails on that operator.
// SYNTHETIC_TEST_ONLY: the owner 0x3333…3333, its key, every hash, balance, fee, deposit id and relayer are synthetic.
// Nothing here signs, sends or reaches a network.
import { createHash } from "node:crypto";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  parseAbi,
  stringToHex,
  type Hex,
} from "viem";
import {
  BRIDGE_LANE_APPROVAL_VERSION,
  BRIDGE_LANE_KEY_DOMAIN,
  bridgeLaneGateState,
  type BridgeLaneStepFacts,
  type OwnerBridgeLaneApproval,
} from "../../src/swap/lane/bridge-approval";
import {
  BRIDGE_LANE_CHAIN_PINS,
  BRIDGE_LANE_PIN_SET,
} from "../../src/swap/lane/bridge-pins";
import {
  BRIDGE_LANE_CHAINS,
  BRIDGE_LANE_PAIRS,
  type BridgeLaneChain,
  type BridgeLaneStep,
} from "../../src/swap/lane/bridge-scope";
import { bridgeReadProblem } from "../../src/swap/lane/reads";
import {
  BridgeLaneEngine,
  type BridgeChainReader,
  type BridgeLaneDeps,
  type BridgeLaneSigner,
} from "../../src/swap/lane/bridge-engine";
import type {
  LaneSignerResult,
  LaneTx,
} from "../../src/swap/lane/signer-adapter";
import type { CanaryDurableStore } from "../../src/execution/server/canary/durable-store";
import { MemStore } from "./swap-lane-fake";
import { fakeBridgeCodeOf } from "./bridge-lane-pin-mock";
import {
  fakeStatus,
  fakeStatusBody,
  type FakeSignature,
} from "./lane-fake-signer-status";

export { MemStore };
export const OWNER = "0x3333333333333333333333333333333333333333";
export const OTHER = "0x4444444444444444444444444444444444444444";
export const RELAYER = "0x5555555555555555555555555555555555555555";
export const OWNER_KEY = "6b".repeat(32);
export const KEY_DIGEST = createHash("sha256")
  .update(`${BRIDGE_LANE_KEY_DOMAIN}:${OWNER_KEY}`, "utf8")
  .digest("hex");
export const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
export const NOW_SEC = Math.floor(NOW / 1000);
export const HOUR = 3_600_000;
export const FIRST_NONCE = 11n;
export const AMOUNT = 5_000_000n;
export const FEE = 12_500n;
export const BRIDGED = AMOUNT - FEE;
export const DIAMOND = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";
export const FACET = "0xad3f1634a917924cbb54a0f76e43ca035d2b6bcd";
export const FEE_COLLECTOR = "0xde2b920506ee931a6a2abdf566526220214fbbae";
export const FEE_RECIPIENT = "0xc06ebbefd94032b85424d51906e2a335efae264b";
export const ENABLED_PAIR_IDS = Object.values(BRIDGE_LANE_PAIRS)
  .filter((p) => p.status === "ENABLED")
  .map((p) => p.id);
export const BLOCKED_PAIR_IDS = Object.values(BRIDGE_LANE_PAIRS)
  .filter((p) => p.status === "BLOCKED")
  .map((p) => p.id);
export const DEFAULT_PAIR = "bridge-8453-42161";
const lc = (a: string) => a.toLowerCase();
const hex = (n: bigint | number) => "0x" + BigInt(n).toString(16);
const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
export const w = (x: bigint | number | string) =>
  typeof x === "string"
    ? x.toLowerCase().replace(/^0x/, "").padStart(64, "0")
    : BigInt(x).toString(16).padStart(64, "0");
export const b32 = (a: string) => ("0x" + w(a)) as Hex;
const Z = "0x0000000000000000000000000000000000000000";
const Z32 = ("0x" + "0".repeat(64)) as Hex;

/** A synthetic record of `pairId` (exactly the pair's amount and minimum, its full gas budget, cost cap 300). */
export function recordFor(
  pairId: string,
  over: Partial<OwnerBridgeLaneApproval> = {},
): Readonly<OwnerBridgeLaneApproval> {
  const p = BRIDGE_LANE_PAIRS[pairId];
  const S = BRIDGE_LANE_CHAINS[p.source],
    D = BRIDGE_LANE_CHAINS[p.destination];
  return Object.freeze({
    version: BRIDGE_LANE_APPROVAL_VERSION,
    approvalId: "0x" + "2c".repeat(32),
    route: p.id,
    scope: p.id,
    pinSet: BRIDGE_LANE_PIN_SET,
    account: OWNER,
    sourceChainId: p.source,
    destinationChainId: p.destination,
    sourceToken: S.usdc.address,
    destinationToken: D.usdc.address,
    spender: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
    exactAmount: p.exactAmount.toString(),
    minimumOut: p.minimumOut.toString(),
    maxCostBps: 300,
    nativeGasBudgetWei: p.gasBudgetWei.toString(),
    firstNonce: FIRST_NONCE.toString(),
    notBefore: NOW - HOUR,
    notAfter: NOW + 12 * HOUR,
    singleUse: true,
    allowanceCleanup: "ZERO_REVOKE_ONLY",
    ...over,
  } as OwnerBridgeLaneApproval);
}

// ---- independent ABIs -------------------------------------------------------------------------------------------
const BD =
  "(bytes32 transactionId,string bridge,string integrator,address referrer,address sendingAssetId,address receiver,uint256 minAmount,uint256 destinationChainId,bool hasSourceSwaps,bool hasDestinationCall)";
const SD =
  "(address callTo,address approveTo,address sendingAssetId,address receivingAssetId,uint256 fromAmount,bytes callData,bool requiresDeposit)[]";
const AD =
  "(bytes32 receiverAddress,bytes32 refundAddress,bytes32 sendingAssetId,bytes32 receivingAssetId,uint256 outputAmount,uint128 outputAmountMultiplier,bytes32 exclusiveRelayer,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityParameter,bytes message)";
export const ACROSS = parseAbi([
  `function swapAndStartBridgeTokensViaAcrossV4(${BD} _bridgeData, ${SD} _swapData, ${AD} _acrossData) payable`,
]);
export const FEES = parseAbi([
  "function forwardERC20Fees(address token, (address recipient, uint256 amount)[] fees)",
]);
const ERC20 = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
]);
export const EVENTS = parseAbi([
  "event FilledRelay(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 repaymentChainId, uint256 indexed originChainId, uint256 indexed depositId, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 exclusiveRelayer, bytes32 indexed relayer, bytes32 depositor, bytes32 recipient, bytes32 messageHash, (bytes32 updatedRecipient, bytes32 updatedMessageHash, uint256 updatedOutputAmount, uint8 fillType) relayExecutionInfo)",
  "event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)",
]);
const SEL = {
  balanceOf: "0x70a08231",
  allowance: "0xdd62ed3e",
  approve: "0x095ea7b3",
  bridge: "0x1794958f",
  facetAddress: "0xcdffacc6",
  spokePool: "0xf6503992",
  getL1Fee: "0x49948e0e",
  getOperatorFee: "0x275aedd2",
  l1Component: "0x77d488a2",
};
const NODE_INTERFACE = parseAbi([
  "function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)",
]);

// ---- the LI.FI quote double -----------------------------------------------------------------------------------------
export interface QuoteParts {
  transactionId: Hex;
  bridge: string;
  integrator: string;
  referrer: string;
  sendingAssetId: string;
  receiver: string;
  minAmount: bigint;
  destinationChainId: bigint;
  hasSourceSwaps: boolean;
  hasDestinationCall: boolean;
  steps: {
    callTo: string;
    approveTo: string;
    sendingAssetId: string;
    receivingAssetId: string;
    fromAmount: bigint;
    callData: Hex;
    requiresDeposit: boolean;
  }[];
  across: {
    receiverAddress: Hex;
    refundAddress: Hex;
    sendingAssetId: Hex;
    receivingAssetId: Hex;
    outputAmount: bigint;
    outputAmountMultiplier: bigint;
    exclusiveRelayer: Hex;
    quoteTimestamp: number;
    fillDeadline: number;
    exclusivityParameter: number;
    message: Hex;
  };
}
export const feeCall = (
  token: string,
  entries: { recipient: string; amount: bigint }[],
): Hex =>
  encodeFunctionData({
    abi: FEES,
    functionName: "forwardERC20Fees",
    args: [
      token as Hex,
      entries.map((e) => ({ recipient: e.recipient as Hex, amount: e.amount })),
    ],
  });
/** The evidence's Across multiplier (E-bridge-sims.json): ~130 bps into Ethereum, ~28 bps elsewhere. */
export const multiplierOf = (pairId: string) =>
  BRIDGE_LANE_PAIRS[pairId].destination === "1"
    ? 989_503_759_398_496_241n
    : 998_581_854_636_591_479n;
/** The honest parts of a 5 USDC quote of `pairId` at `nowSec` (the shape of the evidence's 30 simulated quotes). */
export function honestParts(pairId: string, nowSec: number): QuoteParts {
  const p = BRIDGE_LANE_PAIRS[pairId];
  const S = BRIDGE_LANE_CHAINS[p.source],
    D = BRIDGE_LANE_CHAINS[p.destination];
  const m = multiplierOf(pairId);
  return {
    transactionId: keccak256(stringToHex(`fake-lifi-tx:${pairId}:${nowSec}`)),
    bridge: "across",
    integrator: "lifi-api",
    referrer: Z,
    sendingAssetId: S.usdc.address,
    receiver: OWNER,
    minAmount: BRIDGED,
    destinationChainId: BigInt(p.destination),
    hasSourceSwaps: true,
    hasDestinationCall: false,
    steps: [
      {
        callTo: FEE_COLLECTOR,
        approveTo: FEE_COLLECTOR,
        sendingAssetId: S.usdc.address,
        receivingAssetId: S.usdc.address,
        fromAmount: AMOUNT,
        callData: feeCall(S.usdc.address, [
          { recipient: FEE_RECIPIENT, amount: FEE },
        ]),
        requiresDeposit: true,
      },
    ],
    across: {
      receiverAddress: b32(OWNER),
      refundAddress: b32(OWNER),
      sendingAssetId: b32(S.usdc.address),
      receivingAssetId: b32(D.usdc.address),
      outputAmount: (BRIDGED * m) / 10n ** 18n,
      outputAmountMultiplier: m,
      exclusiveRelayer: Z32,
      quoteTimestamp: nowSec - 60,
      fillDeadline: nowSec + 9_000,
      exclusivityParameter: 0,
      message: "0x",
    },
  };
}
export const effectiveOf = (parts: QuoteParts) =>
  (parts.minAmount * parts.across.outputAmountMultiplier) / 10n ** 18n;
export function encodeBridge(parts: QuoteParts): Hex {
  return encodeFunctionData({
    abi: ACROSS,
    functionName: "swapAndStartBridgeTokensViaAcrossV4",
    args: [
      {
        transactionId: parts.transactionId,
        bridge: parts.bridge,
        integrator: parts.integrator,
        referrer: parts.referrer as Hex,
        sendingAssetId: parts.sendingAssetId as Hex,
        receiver: parts.receiver as Hex,
        minAmount: parts.minAmount,
        destinationChainId: parts.destinationChainId,
        hasSourceSwaps: parts.hasSourceSwaps,
        hasDestinationCall: parts.hasDestinationCall,
      },
      parts.steps.map((s) => ({
        ...s,
        callTo: s.callTo as Hex,
        approveTo: s.approveTo as Hex,
        sendingAssetId: s.sendingAssetId as Hex,
        receivingAssetId: s.receivingAssetId as Hex,
      })),
      parts.across,
    ],
  });
}
/** The LI.FI /v1/quote response shape (only the fields the lane reads, plus a few it must ignore). */
export function quoteOf(pairId: string, parts: QuoteParts) {
  const p = BRIDGE_LANE_PAIRS[pairId];
  const S = BRIDGE_LANE_CHAINS[p.source],
    D = BRIDGE_LANE_CHAINS[p.destination];
  const eff = effectiveOf(parts);
  return {
    id: "synthetic-quote",
    type: "lifi",
    tool: "across",
    toolDetails: { key: "across", name: "AcrossV4" },
    action: {
      fromChainId: Number(p.source),
      toChainId: Number(p.destination),
      fromToken: { address: S.usdc.address, symbol: "USDC", decimals: 6 },
      toToken: { address: D.usdc.address, symbol: "USDC", decimals: 6 },
      fromAmount: AMOUNT.toString(),
      fromAddress: OWNER,
      toAddress: OWNER,
      slippage: 0.005,
    },
    estimate: {
      tool: "across",
      approvalAddress: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
      fromAmount: AMOUNT.toString(),
      toAmount: eff.toString(),
      toAmountMin: eff.toString(),
      executionDuration: 2,
    },
    includedSteps: ["protocol:feeCollection", "cross:across"],
    transactionRequest: {
      to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
      from: OWNER,
      chainId: Number(p.source),
      value: "0x0",
      data: encodeBridge(parts),
      gasLimit: "0x47c8a",
      gasPrice: "0x1",
    },
  };
}

// ---- the fake chains --------------------------------------------------------------------------------------------
export interface ChainFixture {
  baseFee: bigint;
  tip: bigint;
  l1Fee: bigint;
  l1Gas: { APPROVE: bigint; EXECUTE: bigint };
  native: bigint;
}
export const FIXTURES: Record<string, ChainFixture> = {
  "1": {
    baseFee: 195_588_636n,
    tip: 50_000_000n,
    l1Fee: 0n,
    l1Gas: { APPROVE: 0n, EXECUTE: 0n },
    native: 1_000_000_000_000_000n,
  },
  "8453": {
    baseFee: 5_000_000n,
    tip: 1_000_000n,
    l1Fee: 6_621_319_885n,
    l1Gas: { APPROVE: 0n, EXECUTE: 0n },
    native: 1_000_000_000_000_000n,
  },
  "42161": {
    baseFee: 20_038_000n,
    tip: 0n,
    l1Fee: 0n,
    l1Gas: { APPROVE: 900n, EXECUTE: 2_471n },
    native: 1_000_000_000_000_000n,
  },
  "10": {
    baseFee: 536n,
    tip: 1_000_000n,
    l1Fee: 9_119_696_260n,
    l1Gas: { APPROVE: 0n, EXECUTE: 0n },
    native: 1_000_000_000_000_000n,
  },
  "137": {
    baseFee: 252_496_198_643n,
    tip: 30_000_000_000n,
    l1Fee: 0n,
    l1Gas: { APPROVE: 0n, EXECUTE: 0n },
    native: 10_000_000_000_000_000_000n,
  },
};
export interface FakeLog {
  address: string;
  topics: string[];
  data: string;
}
export interface FakeReceipt {
  transactionHash: string;
  status: "0x1" | "0x0";
  blockNumber: string;
  blockHash: string;
  gasUsed: string;
  effectiveGasPrice: string;
  l1Fee?: string;
  logs: FakeLog[];
  from: string;
  to: string;
}
type Both<T> = {
  values: [T | null, T | null];
  agree: boolean;
  errors: string[];
};
/** Per-operator tamper: undefined keeps the honest answer, any other value replaces it, a throw fails that read. */
export type Tamper = (
  op: 0 | 1,
  method: string,
  params: readonly unknown[],
  honest: unknown,
) => unknown;
interface State {
  usdc: bigint;
  allowance: bigint;
}
export interface FakeDeposit {
  depositId: bigint;
  inputToken: Hex;
  outputToken: Hex;
  inputAmount: bigint;
  outputAmount: bigint;
  destinationChainId: bigint;
  quoteTimestamp: number;
  fillDeadline: number;
  exclusivityDeadline: number;
  depositor: Hex;
  recipient: Hex;
  exclusiveRelayer: Hex;
  message: Hex;
}

export class FakeBridgeChain implements BridgeChainReader {
  readonly chain: Readonly<BridgeLaneChain>;
  readonly A: {
    usdc: string;
    usdcImpl: string;
    spokePool: string;
    spokeImpl: string;
    oracle: string | null;
  };
  head: bigint;
  /** Seconds the head block lags behind the clock; seconds per block. */
  lagSec = 1;
  blockSec = 2;
  baseFee: bigint;
  tip: bigint;
  l1Fee: bigint;
  operatorFee = 0n;
  l1Gas: { APPROVE: bigint; EXECUTE: bigint };
  gas = { APPROVE: 55_437n, EXECUTE: 184_360n };
  usdc = 50_000_000n;
  allowance = 0n;
  native: bigint;
  code = new Map<string, string>();
  slots = new Map<string, string>();
  facetFor: string = FACET;
  spokeOfFacet: string;
  forks = new Map<bigint, string>();
  receipts = new Map<string, FakeReceipt>();
  pending = new Map<string, LaneTx>();
  sent = new Map<string, LaneTx>();
  baseNonce = FIRST_NONCE;
  /** The next mined transaction reverts (status 0x0, no state change). */
  failNext = false;
  /** eth_simulateV1 of the bridge call reverts. */
  bridgeReverts = false;
  /** The simulated / mined bridge pulls this much more (or less) USDC than its fee step's fromAmount. */
  pullDelta = 0n;
  /** Rewrites the deposit the SpokePool emits (adversarial settlement). */
  depositTamper: ((d: FakeDeposit) => FakeDeposit) | null = null;
  /** The owner's USDC at a past block (undefined: the current balance), for history-dependent reads. */
  usdcAtBlock: ((block: bigint) => bigint | undefined) | null = null;
  nextDepositId = 4_926_614n;
  deposits: FakeDeposit[] = [];
  tamper: Tamper | null = null;
  violations: string[] = [];
  log: { method: string; params: readonly unknown[] }[] = [];
  #n = 0;
  constructor(
    public readonly now: () => number,
    public readonly chainId: string,
    head: bigint,
  ) {
    this.chain = BRIDGE_LANE_CHAINS[chainId];
    const p = BRIDGE_LANE_CHAIN_PINS[chainId];
    this.A = {
      usdc: lc(p.usdc.address),
      usdcImpl: lc(p.usdc.implementation.address),
      spokePool: lc(p.spokePool.address),
      spokeImpl: lc(p.spokePool.implementation.address),
      oracle: p.gasPriceOracle ? lc(p.gasPriceOracle) : null,
    };
    this.spokeOfFacet = this.A.spokePool;
    const f = FIXTURES[chainId];
    this.head = head;
    this.baseFee = f.baseFee;
    this.tip = f.tip;
    this.l1Fee = f.l1Fee;
    this.l1Gas = { ...f.l1Gas };
    this.native = f.native;
    for (const a of [
      p.diamond.address,
      p.facet.address,
      p.feeCollector.address,
      p.spokePool.address,
      p.spokePool.implementation.address,
      p.usdc.address,
      p.usdc.implementation.address,
    ])
      this.code.set(lc(a), fakeBridgeCodeOf(a));
    this.slots.set(
      `${this.A.usdc}:${lc(p.usdc.implementation.slot)}`,
      this.A.usdcImpl,
    );
    this.slots.set(
      `${this.A.spokePool}:${lc(p.spokePool.implementation.slot)}`,
      this.A.spokeImpl,
    );
  }
  get opStack() {
    return this.chain.feeModel === "OP_STACK";
  }
  blockHash(n: bigint) {
    return keccak256(
      stringToHex(
        `fake-bridge-${this.chainId}-block:${n}:${this.forks.get(n) ?? ""}`,
      ),
    );
  }
  blockTimeSec(n: bigint) {
    return (
      Math.floor(this.now() / 1000) -
      this.lagSec -
      this.blockSec * Number(this.head - n)
    );
  }
  async both<T = unknown>(
    method: string,
    params: readonly unknown[],
    pick: (x: unknown) => unknown = (x) => x,
  ): Promise<Both<T>> {
    this.log.push({ method, params });
    const r = ([0, 1] as const).map((op) => {
      try {
        return {
          v: this.#answer(op, method, params) as T,
          e: null as string | null,
        };
      } catch (e) {
        return { v: null, e: e instanceof Error ? e.message : "READ_FAILED" };
      }
    });
    const values: [T | null, T | null] = [r[0].v, r[1].v];
    const errors = r.map((x) => x.e).filter((e): e is string => e !== null);
    const agree =
      errors.length === 0 &&
      JSON.stringify(pick(values[0])) === JSON.stringify(pick(values[1]));
    return { values, agree, errors };
  }
  #answer(op: 0 | 1, method: string, params: readonly unknown[]): unknown {
    const problem = bridgeReadProblem(this.chainId, method, params, OWNER);
    if (problem) {
      this.violations.push(`${method}:${problem}`);
      throw new Error("REVIEW_REQUIRED");
    }
    const honest = this.#honest(method, params);
    if (this.tamper) {
      const t = this.tamper(op, method, params, honest);
      if (t !== undefined) return t;
    }
    return honest;
  }
  #honest(method: string, p: readonly unknown[]): unknown {
    switch (method) {
      case "eth_chainId":
        return hex(BigInt(this.chainId));
      case "eth_blockNumber":
        return hex(this.head);
      case "eth_getBlockByNumber": {
        const n = BigInt(p[0] as string);
        if (n > this.head) return null;
        return {
          number: hex(n),
          hash: this.blockHash(n),
          timestamp: hex(this.blockTimeSec(n)),
          baseFeePerGas: hex(this.baseFee),
        };
      }
      case "eth_getCode":
        return this.code.get(lc(p[0] as string)) ?? "0x";
      case "eth_getStorageAt": {
        const v = this.slots.get(`${lc(p[0] as string)}:${lc(p[1] as string)}`);
        return v ? "0x" + w(v) : word(0n);
      }
      case "eth_call": {
        const c = p[0] as { to: string; data: string };
        const past = this.usdcAtBlock?.(BigInt(p[1] as string));
        return this.#call(
          c.to,
          c.data,
          past === undefined ? this : { usdc: past, allowance: this.allowance },
        );
      }
      case "eth_estimateGas": {
        const c = p[0] as { from: string; to: string; data: string };
        const [res] = this.#simulateOn(
          { usdc: this.usdc, allowance: this.allowance },
          [c],
        );
        if (res.status !== "0x1") throw new Error("SIMULATION_FAILED");
        const f = c.data.slice(0, 10).toLowerCase();
        return hex(
          BigInt(res.gasUsed) +
            (f === SEL.approve ? this.l1Gas.APPROVE : this.l1Gas.EXECUTE),
        );
      }
      case "eth_getBalance":
        return hex(this.native);
      case "eth_getTransactionCount": {
        if (lc(p[0] as string) !== lc(OWNER)) return "0x0";
        return hex(
          p[1] === "pending"
            ? this.nonceAt(this.head) + this.ownerPending()
            : this.nonceAt(
                p[1] === "latest" ? this.head : BigInt(p[1] as string),
              ),
        );
      }
      case "eth_maxPriorityFeePerGas":
        return hex(this.tip);
      case "eth_simulateV1": {
        const o = p[0] as {
          blockStateCalls: {
            calls: { from: string; to: string; data: string }[];
          }[];
        };
        return [
          {
            number: hex(this.head + 1n),
            calls: this.#simulateOn(
              { usdc: this.usdc, allowance: this.allowance },
              o.blockStateCalls[0].calls,
            ),
          },
        ];
      }
      case "eth_getTransactionReceipt": {
        const r = this.receipts.get(lc(p[0] as string));
        return r && BigInt(r.blockNumber) <= this.head
          ? structuredClone(r)
          : null;
      }
      case "eth_getTransactionByHash": {
        const h = lc(p[0] as string);
        const tx = this.sent.get(h);
        if (!tx) return null;
        const r = this.receipts.get(h);
        const mined = !!r && BigInt(r.blockNumber) <= this.head;
        return {
          hash: h,
          from: lc(tx.from),
          to: lc(tx.to),
          input: tx.data,
          value: tx.value,
          blockNumber: mined ? r.blockNumber : null,
          blockHash: mined ? r.blockHash : null,
        };
      }
      case "eth_getLogs": {
        const f = p[0] as {
          address: string;
          fromBlock: string;
          toBlock: string;
          topics: string[];
        };
        const from = BigInt(f.fromBlock),
          to = BigInt(f.toBlock);
        const out: unknown[] = [];
        for (const r of this.receipts.values()) {
          const n = BigInt(r.blockNumber);
          if (n < from || n > to || n > this.head) continue;
          r.logs.forEach((l, i) => {
            if (lc(l.address) !== lc(f.address)) return;
            if (!f.topics.every((t, k) => lc(l.topics[k] ?? "") === lc(t)))
              return;
            out.push({
              ...l,
              transactionHash: r.transactionHash,
              blockNumber: r.blockNumber,
              blockHash: r.blockHash,
              logIndex: hex(i),
              removed: false,
            });
          });
        }
        return out;
      }
    }
    throw new Error(`UNEXPECTED_METHOD:${method}`);
  }
  #call(to: string, data: string, s: State): string {
    const A = this.A;
    const t = lc(to),
      f = data.slice(0, 10).toLowerCase();
    const arg = (i: number) =>
      "0x" + data.slice(10 + 64 * i + 24, 10 + 64 * (i + 1));
    if (t === A.usdc && f === SEL.balanceOf)
      return word(lc(arg(0)) === lc(OWNER) ? s.usdc : 0n);
    if (t === A.usdc && f === SEL.allowance)
      return word(
        lc(arg(0)) === lc(OWNER) && lc(arg(1)) === DIAMOND ? s.allowance : 0n,
      );
    if (t === DIAMOND && f === SEL.facetAddress)
      return (
        "0x" + w(data.slice(10, 18) === SEL.bridge.slice(2) ? this.facetFor : Z)
      );
    if (t === FACET && f === SEL.spokePool) return "0x" + w(this.spokeOfFacet);
    if (A.oracle && t === A.oracle && f === SEL.getL1Fee)
      return word(this.l1Fee);
    if (A.oracle && t === A.oracle && f === SEL.getOperatorFee)
      return word(this.operatorFee);
    if (
      t === "0x00000000000000000000000000000000000000c8" &&
      this.chain.feeModel === "ARBITRUM" &&
      f === SEL.l1Component
    ) {
      const inner = decodeFunctionData({
        abi: NODE_INTERFACE,
        data: data as Hex,
      }).args[2] as string;
      return encodeAbiParameters(
        [{ type: "uint64" }, { type: "uint256" }, { type: "uint256" }],
        [
          inner.slice(0, 10).toLowerCase() === SEL.approve
            ? this.l1Gas.APPROVE
            : this.l1Gas.EXECUTE,
          this.baseFee,
          30_000_000_000n,
        ],
      );
    }
    throw new Error(`UNEXPECTED_CALL:${t}:${f}`);
  }
  /** Applies one bridge call to `s`; null = it reverts. */
  #bridge(s: State, data: string) {
    try {
      const d = decodeFunctionData({ abi: ACROSS, data: data as Hex });
      const [bd, sd, ad] = d.args;
      const pull = sd[0].fromAmount + this.pullDelta;
      if (s.allowance < pull || s.usdc < pull) return null;
      s.usdc -= pull;
      s.allowance -= pull;
      return { bd, sd, ad, pull };
    } catch {
      return null;
    }
  }
  #simulateOn(s: State, calls: { from: string; to: string; data: string }[]) {
    return calls.map((c) => {
      const t = lc(c.to),
        f = c.data.slice(0, 10).toLowerCase();
      if (t === this.A.usdc && f === SEL.approve) {
        s.allowance = BigInt("0x" + c.data.slice(74, 138));
        return {
          status: "0x1",
          returnData: word(1n),
          gasUsed: hex(this.gas.APPROVE),
          logs: [],
        };
      }
      if (t === DIAMOND && f === SEL.bridge) {
        const r = this.bridgeReverts ? null : this.#bridge(s, c.data);
        return r
          ? {
              status: "0x1",
              returnData: "0x",
              gasUsed: hex(this.gas.EXECUTE),
              logs: [],
            }
          : {
              status: "0x0",
              returnData: "0x",
              gasUsed: hex(30_000n),
              logs: [],
            };
      }
      try {
        return {
          status: "0x1",
          returnData: this.#call(c.to, c.data, s),
          gasUsed: hex(26_000n),
          logs: [],
        };
      } catch {
        return {
          status: "0x0",
          returnData: "0x",
          gasUsed: hex(21_000n),
          logs: [],
        };
      }
    });
  }
  // ---- the "network" side -------------------------------------------------------------------------------------
  submit(tx: LaneTx): string {
    const hash = keccak256(
      stringToHex(
        `fake-bridge-tx:${this.chainId}:${++this.#n}:${JSON.stringify(tx)}`,
      ),
    );
    this.pending.set(hash, { ...tx });
    this.sent.set(lc(hash), { ...tx });
    return hash;
  }
  nonceAt(block: bigint): bigint {
    let n = this.baseNonce;
    for (const r of this.receipts.values())
      if (lc(r.from) === lc(OWNER) && BigInt(r.blockNumber) <= block) n++;
    return n;
  }
  ownerPending(): bigint {
    return BigInt(
      [...this.pending.values()].filter((t) => lc(t.from) === lc(OWNER)).length,
    );
  }
  erc20Log(
    token: string,
    name: "Transfer" | "Approval",
    a: string,
    b: string,
    value: bigint,
  ): FakeLog {
    const topics =
      name === "Transfer"
        ? encodeEventTopics({
            abi: ERC20,
            eventName: "Transfer",
            args: { from: a as Hex, to: b as Hex },
          })
        : encodeEventTopics({
            abi: ERC20,
            eventName: "Approval",
            args: { owner: a as Hex, spender: b as Hex },
          });
    return {
      address: token,
      topics: topics as string[],
      data: encodeAbiParameters([{ type: "uint256" }], [value]),
    };
  }
  depositLog(d: FakeDeposit): FakeLog {
    const topics = encodeEventTopics({
      abi: EVENTS,
      eventName: "FundsDeposited",
      args: {
        destinationChainId: d.destinationChainId,
        depositId: d.depositId,
        depositor: d.depositor,
      },
    });
    return {
      address: this.A.spokePool,
      topics: topics as string[],
      data: encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint32" },
          { type: "uint32" },
          { type: "uint32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes" },
        ],
        [
          d.inputToken,
          d.outputToken,
          d.inputAmount,
          d.outputAmount,
          d.quoteTimestamp,
          d.fillDeadline,
          d.exclusivityDeadline,
          d.recipient,
          d.exclusiveRelayer,
          d.message,
        ],
      ),
    };
  }
  /** Includes every pending transaction in the next block (an approve or the bridge); returns that block. */
  mine(): bigint {
    const A = this.A;
    const n = this.head + 1n;
    this.head = n;
    for (const [hash, tx] of this.pending) {
      const fail = this.failNext;
      this.failNext = false;
      let status: "0x1" | "0x0" = "0x0";
      const logs: FakeLog[] = [];
      let gasUsed = 30_000n;
      const f = tx.data.slice(0, 10).toLowerCase();
      if (
        !fail &&
        lc(tx.from) === lc(OWNER) &&
        lc(tx.to) === A.usdc &&
        f === SEL.approve
      ) {
        const amount = BigInt("0x" + tx.data.slice(74, 138));
        this.allowance = amount;
        status = "0x1";
        gasUsed = this.gas.APPROVE;
        logs.push(this.erc20Log(A.usdc, "Approval", OWNER, DIAMOND, amount));
      } else if (
        !fail &&
        lc(tx.from) === lc(OWNER) &&
        lc(tx.to) === DIAMOND &&
        f === SEL.bridge
      ) {
        const r = this.#bridge(this, tx.data);
        if (r) {
          status = "0x1";
          gasUsed = this.gas.EXECUTE;
          const { bd, ad, pull } = r;
          const fee = pull - bd.minAmount;
          logs.push(this.erc20Log(A.usdc, "Transfer", OWNER, DIAMOND, pull));
          logs.push(
            this.erc20Log(A.usdc, "Transfer", DIAMOND, FEE_COLLECTOR, fee),
          );
          logs.push(
            this.erc20Log(
              A.usdc,
              "Transfer",
              DIAMOND,
              A.spokePool,
              bd.minAmount,
            ),
          );
          let d: FakeDeposit = {
            depositId: this.nextDepositId++,
            inputToken: b32(A.usdc),
            outputToken: ad.receivingAssetId,
            inputAmount: bd.minAmount,
            outputAmount:
              (bd.minAmount * ad.outputAmountMultiplier) / 10n ** 18n,
            destinationChainId: bd.destinationChainId,
            quoteTimestamp: ad.quoteTimestamp,
            fillDeadline: ad.fillDeadline,
            exclusivityDeadline:
              ad.exclusivityParameter > 0
                ? this.blockTimeSec(n) + ad.exclusivityParameter
                : 0,
            depositor: ad.refundAddress,
            recipient: ad.receiverAddress,
            exclusiveRelayer: ad.exclusiveRelayer,
            message: ad.message,
          };
          if (this.depositTamper) d = this.depositTamper(d);
          this.deposits.push(d);
          logs.push(this.depositLog(d));
        }
      }
      this.receipts.set(lc(hash), {
        transactionHash: hash,
        status,
        blockNumber: hex(n),
        blockHash: this.blockHash(n),
        gasUsed: hex(gasUsed),
        effectiveGasPrice: hex(this.baseFee + this.tip),
        ...(this.opStack ? { l1Fee: hex(this.l1Fee) } : {}),
        logs,
        from: lc(tx.from),
        to: lc(tx.to),
      });
      this.native -=
        gasUsed * (this.baseFee + this.tip) + (this.opStack ? this.l1Fee : 0n);
    }
    this.pending.clear();
    return n;
  }
  advance(blocks: number) {
    this.head += BigInt(blocks);
  }
  /**
   * The destination side: a relayer fills `d` in the next block (FilledRelay from the pinned SpokePool, plus the USDC
   * payment). `over` rewrites the fill for adversarial cases. Returns the fill's transaction hash.
   */
  fill(
    d: FakeDeposit,
    originChainId: bigint,
    over: {
      recipient?: Hex;
      updatedRecipient?: Hex;
      updatedOutputAmount?: bigint;
      fillType?: number;
      outputAmount?: bigint;
      paidTo?: string;
      paid?: bigint;
      noPayment?: boolean;
      at?: bigint;
      address?: string;
    } = {},
  ): string {
    const n = over.at ?? this.head + 1n;
    if (n > this.head) this.head = n;
    const hash = keccak256(
      stringToHex(`fake-fill:${this.chainId}:${++this.#n}`),
    );
    const recipient = over.recipient ?? d.recipient;
    const outputAmount = over.outputAmount ?? d.outputAmount;
    const topics = encodeEventTopics({
      abi: EVENTS,
      eventName: "FilledRelay",
      args: {
        originChainId,
        depositId: d.depositId,
        relayer: b32(RELAYER),
      },
    });
    const data = encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint32" },
        { type: "uint32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        {
          type: "tuple",
          components: [
            { type: "bytes32" },
            { type: "bytes32" },
            { type: "uint256" },
            { type: "uint8" },
          ],
        },
      ],
      [
        d.inputToken,
        d.outputToken,
        d.inputAmount,
        outputAmount,
        originChainId,
        d.fillDeadline,
        d.exclusivityDeadline,
        d.exclusiveRelayer,
        d.depositor,
        recipient,
        d.message === "0x" ? Z32 : keccak256(d.message),
        [
          over.updatedRecipient ?? recipient,
          d.message === "0x" ? Z32 : keccak256(d.message),
          over.updatedOutputAmount ?? outputAmount,
          over.fillType ?? 1,
        ],
      ],
    );
    const logs: FakeLog[] = [
      {
        address: over.address ?? this.A.spokePool,
        topics: topics as string[],
        data,
      },
    ];
    if (!over.noPayment)
      logs.push(
        this.erc20Log(
          this.A.usdc,
          "Transfer",
          RELAYER,
          over.paidTo ?? "0x" + recipient.slice(-40),
          over.paid ?? over.updatedOutputAmount ?? outputAmount,
        ),
      );
    this.receipts.set(lc(hash), {
      transactionHash: hash,
      status: "0x1",
      blockNumber: hex(n),
      blockHash: this.blockHash(n),
      gasUsed: hex(90_000n),
      effectiveGasPrice: hex(this.baseFee + this.tip),
      ...(this.opStack ? { l1Fee: hex(this.l1Fee) } : {}),
      logs,
      from: RELAYER,
      to: this.A.spokePool,
    });
    return hash;
  }
}

/** Records every hand-off; by default it "sends" (the source chain receives the exact transaction). */
export class FakeBridgeSigner implements BridgeLaneSigner {
  calls: {
    authority: unknown;
    tx: LaneTx;
    step: BridgeLaneStep | "REVOKE";
  }[] = [];
  answer: (
    step: BridgeLaneStep | "REVOKE",
    tx: LaneTx,
  ) => LaneSignerResult | Promise<LaneSignerResult>;
  signatures: FakeSignature[] = [];
  /** Signatures of OTHER lanes / records on the source chain (the signer is shared). */
  others: FakeSignature[] = [];
  /** Rewrites the raw status body (undefined keeps it); a throw = the signer cannot be reached. */
  tamperStatus: ((raw: Record<string, unknown>) => unknown) | null = null;
  statusCalls = 0;
  constructor(
    readonly chain: FakeBridgeChain,
    readonly route: string = DEFAULT_PAIR,
  ) {
    this.answer = (_step, tx) => ({
      outcome: "SENT",
      hash: chain.submit(tx),
      problems: [],
    });
  }
  async send(authority: unknown, tx: LaneTx, step: BridgeLaneStep | "REVOKE") {
    this.calls.push({ authority, tx: { ...tx }, step });
    const r = await this.answer(step, tx);
    this.signatures.push({
      key: `${this.route}:${step}`,
      outcome: r.outcome,
      hash: r.hash,
    });
    return r;
  }
  async status() {
    this.statusCalls++;
    const c = this.chain;
    const raw = fakeStatusBody({
      address: OWNER,
      routes: [this.route],
      chainId: c.chainId,
      firstNonce: FIRST_NONCE,
      signatures: this.signatures,
      others: this.others,
      decided: (h) => {
        const r = h ? c.receipts.get(h.toLowerCase()) : undefined;
        return (
          !!r &&
          c.head - BigInt(r.blockNumber) + 1n >= BigInt(c.chain.confirmations)
        );
      },
      now: c.now(),
    });
    const x = this.tamperStatus ? this.tamperStatus(raw) : undefined;
    return fakeStatus(x === undefined ? raw : x);
  }
}
export interface BridgeLane {
  clock: { t: number };
  pairId: string;
  src: FakeBridgeChain;
  dst: FakeBridgeChain;
  store: MemStore;
  signer: FakeBridgeSigner;
  engine: BridgeLaneEngine;
  gateCalls: { facts: BridgeLaneStepFacts; open: boolean; reasons: string[] }[];
  /** Rewrites the honest quote parts of the next quotes (adversarial calldata). */
  mutate: ((p: QuoteParts) => void) | null;
  /** Rewrites the whole quote object of the next quotes (adversarial quote). */
  mutateQuote: ((q: ReturnType<typeof quoteOf>) => unknown) | null;
  /** The next quotes fail with this error. */
  quoteError: Error | null;
  quotes: number;
  lastParts: QuoteParts | null;
}
/** One engine over the fakes. The default gate is the REAL bridge gate with the synthetic record, digest and wiring. */
export function bridgeLane(
  over: Partial<BridgeLaneDeps> & {
    pair?: string;
    record?: Readonly<OwnerBridgeLaneApproval>;
  } = {},
): BridgeLane {
  const { pair, ...deps } = over;
  const pairId = pair ?? DEFAULT_PAIR;
  const p = BRIDGE_LANE_PAIRS[pairId];
  const clock = { t: NOW };
  const src = new FakeBridgeChain(() => clock.t, p.source, 57_900_000n);
  const dst = new FakeBridgeChain(() => clock.t, p.destination, 424_000_000n);
  const store = new MemStore();
  const signer = new FakeBridgeSigner(src, pairId);
  const record = over.record ?? recordFor(pairId);
  const gateCalls: BridgeLane["gateCalls"] = [];
  const L = {
    clock,
    pairId,
    src,
    dst,
    store,
    signer,
    gateCalls,
    mutate: null,
    mutateQuote: null,
    quoteError: null,
    quotes: 0,
    lastParts: null,
  } as unknown as BridgeLane;
  L.engine = new BridgeLaneEngine({
    store: store as unknown as CanaryDurableStore,
    keyDigest: KEY_DIGEST,
    chains: {
      source: src,
      destination: dst,
      quote: async () => {
        L.quotes++;
        if (L.quoteError) throw L.quoteError;
        const parts = honestParts(pairId, Math.floor(clock.t / 1000));
        if (L.mutate) L.mutate(parts);
        L.lastParts = parts;
        const q = quoteOf(pairId, parts);
        return L.mutateQuote ? L.mutateQuote(q) : q;
      },
    },
    signer,
    now: () => clock.t,
    gate: (facts) => {
      const g = bridgeLaneGateState(facts, record, KEY_DIGEST, true);
      if (facts)
        gateCalls.push({ facts, open: g.open, reasons: [...g.reasons] });
      return g;
    },
    ...deps,
    record,
  });
  return L;
}
/** review -> authorize -> dispatch of the next step (the review must be ready). */
export async function step(L: BridgeLane) {
  const r = await L.engine.review(OWNER_KEY);
  if (!r.ready)
    throw new Error(`NOT_READY ${L.pairId}: ${r.problems.join(",")}`);
  const token = L.engine.authorize(r.reviewId, OWNER_KEY);
  const d = await L.engine.dispatch(token, OWNER_KEY);
  return { r, token, d };
}
/** Mines the source's pending transactions and buries them exactly deep enough for the source chain. */
export function settleSource(L: BridgeLane) {
  const n = L.src.mine();
  L.src.advance(L.src.chain.confirmations - 1);
  return n;
}
/** APPROVE + EXECUTE dispatched and final on the source; returns the deposit the SpokePool emitted. */
export async function bridged(L: BridgeLane) {
  await step(L);
  settleSource(L);
  await L.engine.track();
  const e = await step(L);
  L.dst.advance(5);
  settleSource(L);
  return { e, deposit: L.src.deposits.at(-1)! };
}
/** The relayer fills on the destination and the fill is buried exactly deep enough. */
export function fillAndBury(
  L: BridgeLane,
  d: FakeDeposit,
  over: Parameters<FakeBridgeChain["fill"]>[2] = {},
) {
  const h = L.dst.fill(d, BigInt(L.src.chainId), over);
  L.dst.advance(L.dst.chain.confirmations - 1);
  return h;
}
export const enabledChainIds = Object.values(BRIDGE_LANE_CHAINS)
  .filter((c) => c.status === "ENABLED")
  .map((c) => c.chainId);
