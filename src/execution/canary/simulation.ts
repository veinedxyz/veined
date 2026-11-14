// G14 Track A: REAL transaction simulation of the canary (eth_simulateV1, the read-only method the protected Swap
// transport already allows): the owner's own state, NO state overrides, one block with
//   [ balanceOf(owner), allowance(owner, Diamond), approve(Diamond, amount)?, <the exact LI.FI transaction>,
//     balanceOf(owner), allowance(owner, Diamond) ]
// at the REVIEWED gas limit and realistic fees (a block override sets the base fee; no state is overridden, review
// F7), and an interpretation that proves, from the simulated logs, where every unit of USDC went. The ENGINE builds
// this request itself and records its digest and block (server/canary/engine.ts); with no USDC on Base the simulation
// fails — an honest FAIL.
import {
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  type Hex,
} from "viem";
import { CANARY_PINS } from "./pins";
import type { AcrossCall } from "./across-decoder";
import type { CanaryCheck } from "./quote-verify";

const EVENTS = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)",
]);
const hex = (v: bigint) => `0x${v.toString(16)}`;
export interface SimCall {
  from: string;
  to: string;
  data: string;
  value?: string;
  gas?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}
export interface SimulationRequest {
  blockStateCalls: {
    blockOverrides: { baseFeePerGas: string };
    calls: SimCall[];
  }[];
  validation: boolean;
  traceTransfers: boolean;
}
/** Gas the exact approval may use in the simulation (an ERC-20 approve needs far less). */
export const APPROVAL_SIM_GAS = 100_000n;
export function canarySimulationRequest(i: {
  owner: string;
  amountIn: bigint;
  needsApproval: boolean;
  tx: { to: string; data: string; value: string; gas: string };
  fees: {
    baseFeePerGas: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
  };
}): SimulationRequest {
  const usdc = CANARY_PINS.usdc["8453"].address;
  const diamond = CANARY_PINS.diamond.address;
  const fee = {
    maxFeePerGas: hex(BigInt(i.fees.maxFeePerGas)),
    maxPriorityFeePerGas: hex(BigInt(i.fees.maxPriorityFeePerGas)),
  };
  const read = (fn: "balanceOf" | "allowance"): SimCall => ({
    from: i.owner,
    to: usdc,
    data:
      fn === "balanceOf"
        ? encodeFunctionData({
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [i.owner as Hex],
          })
        : encodeFunctionData({
            abi: erc20Abi,
            functionName: "allowance",
            args: [i.owner as Hex, diamond as Hex],
          }),
  });
  const calls: SimCall[] = [read("balanceOf"), read("allowance")];
  if (i.needsApproval)
    calls.push({
      from: i.owner,
      to: usdc,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [diamond as Hex, i.amountIn],
      }),
      value: "0x0",
      gas: hex(APPROVAL_SIM_GAS),
      ...fee,
    });
  calls.push({
    from: i.owner,
    to: i.tx.to,
    data: i.tx.data,
    value: hex(BigInt(i.tx.value)),
    gas: hex(BigInt(i.tx.gas)),
    ...fee,
  });
  calls.push(read("balanceOf"), read("allowance"));
  // validation=false only skips nonce / balance-for-gas pre-checks; the block override keeps the base fee real.
  return {
    blockStateCalls: [
      {
        blockOverrides: { baseFeePerGas: hex(BigInt(i.fees.baseFeePerGas)) },
        calls,
      },
    ],
    validation: false,
    traceTransfers: true,
  };
}

interface RawLog {
  address: string;
  topics: string[];
  data: string;
}
interface RawCall {
  status: string;
  returnData: string;
  gasUsed: string;
  logs?: RawLog[];
}
export interface SimulationFacts {
  checks: CanaryCheck[];
  gasUsed: bigint[];
  /** The simulated Across deposit (the real deposit id differs: it is assigned when mined). */
  deposit: {
    inputAmount: bigint;
    outputAmount: bigint;
    fillDeadline: number;
  } | null;
}
const lower = (a: unknown) => (typeof a === "string" ? a.toLowerCase() : "");
const b32 = (x: string) => `0x${x.slice(-40)}`.toLowerCase();
const word = (h: unknown): bigint | null =>
  typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h) ? BigInt(h) : null;
const gasOf = (c: RawCall): bigint =>
  typeof c.gasUsed === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(c.gasUsed)
    ? BigInt(c.gasUsed)
    : 0n;

export function interpretCanarySimulation(
  result: unknown,
  e: {
    owner: string;
    amountIn: bigint;
    needsApproval: boolean;
    call: AcrossCall;
    feeTotal: bigint;
  },
): SimulationFacts {
  const checks: CanaryCheck[] = [];
  const fail = (code: string): SimulationFacts => ({
    checks: [
      { id: "SIMULATION", status: "FAIL", code },
      { id: "SIMULATION_FLOWS", status: "FAIL", code },
      { id: "SIMULATION_DEPOSIT", status: "FAIL", code },
    ],
    gasUsed: [],
    deposit: null,
  });
  const block = Array.isArray(result) ? result[0] : null;
  const calls: RawCall[] | null =
    block && Array.isArray(block.calls) ? block.calls : null;
  const expected = e.needsApproval ? 6 : 5;
  if (!calls || calls.length !== expected) return fail("SIMULATION_SHAPE");
  if (!calls.every((c) => c && c.status === "0x1"))
    return fail("SIMULATED_CALL_REVERTED");
  const owner = lower(e.owner);
  const usdc = lower(CANARY_PINS.usdc["8453"].address);
  const diamond = lower(CANARY_PINS.diamond.address);
  const pool = lower(CANARY_PINS.spokePools["8453"].address);
  const before = word(calls[0].returnData),
    allowanceBefore = word(calls[1].returnData);
  const after = word(calls[expected - 2].returnData),
    allowanceAfter = word(calls[expected - 1].returnData);
  if (
    before === null ||
    after === null ||
    allowanceBefore === null ||
    allowanceAfter === null
  )
    return fail("SIMULATION_READ_UNREADABLE");
  const main = calls[e.needsApproval ? 3 : 2];
  // A pre-existing allowance to the Diamond other than exactly the amount is refused (the canary approves exactly).
  if (!e.needsApproval && allowanceBefore !== e.amountIn)
    return fail("UNEXPECTED_EXISTING_ALLOWANCE");
  if (e.needsApproval && allowanceBefore !== 0n)
    return fail("UNEXPECTED_EXISTING_ALLOWANCE");
  const ok = before - after === e.amountIn && allowanceAfter === 0n;
  checks.push({
    id: "SIMULATION",
    status: ok ? "PASS" : "FAIL",
    code: ok
      ? "EXACT_AMOUNT_SPENT_ALLOWANCE_ZERO"
      : "BALANCE_OR_ALLOWANCE_DELTA_WRONG",
  });
  // Every USDC movement in the main call, from the simulated logs.
  const transfers: { from: string; to: string; value: bigint }[] = [];
  const deposits: {
    ok: boolean;
    inputAmount: bigint;
    outputAmount: bigint;
    fillDeadline: number;
  }[] = [];
  let foreign = 0;
  for (const l of main.logs ?? []) {
    try {
      const x = decodeEventLog({
        abi: EVENTS,
        data: l.data as Hex,
        topics: l.topics as [Hex, ...Hex[]],
      });
      if (x.eventName === "Transfer") {
        if (lower(l.address) !== usdc) foreign++;
        else
          transfers.push({
            from: lower(x.args.from),
            to: lower(x.args.to),
            value: x.args.value,
          });
      } else if (x.eventName === "FundsDeposited") {
        const a = x.args,
          c = e.call.across;
        const exclusivityOk =
          c.exclusivityParameter === 0
            ? a.exclusivityDeadline === 0
            : a.exclusivityDeadline > 0 &&
              a.exclusivityDeadline <= a.fillDeadline;
        deposits.push({
          ok:
            lower(l.address) === pool &&
            b32(a.depositor) === owner &&
            b32(a.recipient) === owner &&
            b32(a.inputToken) === usdc &&
            b32(a.outputToken) === lower(CANARY_PINS.usdc["42161"].address) &&
            a.inputAmount === e.call.bridgedAmount &&
            a.outputAmount === e.call.effectiveOutput &&
            a.destinationChainId === 42161n &&
            a.message === "0x" &&
            // The remaining relay fields must be the decoded call's own (review F7).
            Number(a.quoteTimestamp) === c.quoteTimestamp &&
            Number(a.fillDeadline) === c.fillDeadline &&
            lower(a.exclusiveRelayer) === c.exclusiveRelayer &&
            exclusivityOk,
          inputAmount: a.inputAmount,
          outputAmount: a.outputAmount,
          fillDeadline: Number(a.fillDeadline),
        });
      }
    } catch {
      // Not one of the decoded events (LI.FI's own, fee collector's): carries no token movement by itself.
    }
  }
  const sum = (f: (t: (typeof transfers)[number]) => boolean) =>
    transfers.filter(f).reduce((a, t) => a + t.value, 0n);
  const fromOwner = transfers.filter((t) => t.from === owner);
  const flowsOk =
    foreign === 0 &&
    fromOwner.length === 1 &&
    fromOwner[0].to === diamond &&
    fromOwner[0].value === e.amountIn &&
    sum(
      (t) =>
        t.from === diamond &&
        CANARY_PINS.feeCollector.recipients.includes(t.to),
    ) === e.feeTotal &&
    sum((t) => t.from === diamond && t.to === pool) === e.call.bridgedAmount &&
    sum((t) => t.from === diamond) === e.amountIn;
  checks.push({
    id: "SIMULATION_FLOWS",
    status: flowsOk ? "PASS" : "FAIL",
    code: flowsOk ? "EVERY_UNIT_ACCOUNTED" : "UNEXPECTED_TOKEN_MOVEMENT",
  });
  // Exactly one deposit, and it is the reviewed one.
  const depositOk = deposits.length === 1 && deposits[0].ok;
  checks.push({
    id: "SIMULATION_DEPOSIT",
    status: depositOk ? "PASS" : "FAIL",
    code: depositOk
      ? "ACROSS_DEPOSIT_TO_OWNER"
      : deposits.length === 1
        ? "DEPOSIT_MISMATCH"
        : `DEPOSITS:${deposits.length}`,
  });
  const d = depositOk ? deposits[0] : null;
  return {
    checks,
    gasUsed: calls.slice(2, e.needsApproval ? 4 : 3).map(gasOf),
    deposit: d
      ? {
          inputAmount: d.inputAmount,
          outputAmount: d.outputAmount,
          fillDeadline: d.fillDeadline,
        }
      : null,
  };
}
