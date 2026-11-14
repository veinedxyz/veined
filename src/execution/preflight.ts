// G13: deterministic preflight of an owner-signed plan (lifecycle steps 1–12). Pure: every input is a READ fact
// supplied by the server (registry evidence, balances, allowance, gas, simulation, Guardian verdict, wallet identity).
// Each check is PASS, FAIL or UNKNOWN; UNKNOWN blocks exactly like FAIL (fail-closed: what was not proven is not
// assumed). `ready` only says the plan itself is sound — the execution gate is separate and CLOSED.
// Hardened after the Phase 3 review: recipient / bridged amount / fees are proven from an allowlisted, canonically
// encoded call only (F01, F02); a same-chain swap's on-chain minimum must be decoded (F03); numbers are strict (F09);
// gas uses the transaction's own limit and fee caps (F10); fees need a quoted network fee (F11); slippage is exact
// (F12); an upgradeable or unpinned contract is UNKNOWN (F13); a wallet identity the server cannot prove is UNKNOWN (F14).
import { digest } from "./canonical";
import { EXECUTION_POLICY, type ExecutionPlan } from "./model";
import { planDigest } from "./binding";
import { approvalProblem } from "./erc20";
import { decodeLifiBridgeCall, lifiFees } from "./lifi-decoder";
import { behaviourPinned, familyOf, identify } from "./providers";
import { factsProblem, planProblem } from "./plan-check";

export type CheckId =
  | "ASSETS"
  | "CHAINS"
  | "QUOTE"
  | "PROVIDER"
  | "BALANCE"
  | "GAS"
  | "RECIPIENT"
  | "AMOUNTS"
  | "FEES"
  | "APPROVAL"
  | "SIMULATION"
  | "GUARDIAN"
  | "WALLET";
export type CheckStatus = "PASS" | "FAIL" | "UNKNOWN";
export interface Check {
  id: CheckId;
  status: CheckStatus;
  code: string;
}
export interface AssetEvidence {
  chainId: string;
  address: string;
  symbol: string;
  decimals: number;
  level?: string;
  risk?: readonly string[];
}
export interface PreflightFacts {
  now: number;
  /** The wallet that would sign; `proven` only when its identity was verified (not merely claimed by a request). */
  wallet: { account: string | null; chainId: string | null; proven: boolean };
  evidence: { pay: AssetEvidence | null; receive: AssetEvidence | null };
  /** Raw balances of the account on the source chain, read at one block; `agreement` compares two RPC reads. */
  balances: {
    pay: string | null;
    native: string | null;
    agreement: "AGREE" | "DISAGREE" | "SINGLE" | null;
  };
  allowance: string | null;
  /** The spender BOTH allowance reads (before, and after the simulated call) were made for (round 4, S3). */
  allowanceSpender: string | null;
  /** Gas estimate and current fee cap read from the chain (the transaction's own values win when higher). */
  gas: { limit: string | null; maxFeePerGas: string | null };
  /** Value of the amount sent, in USD, as a price source reported it (null when unknown). */
  inputUsd: string | null;
  simulation: {
    success: boolean;
    block: string;
    /** Signed raw delta of the pay asset at the account (a send of 5 USDC is "-5000000"). */
    payDelta: string;
    /** Raw delta of the receive asset at the recipient (same-chain swaps), or null. */
    receiveDelta: string | null;
    /** Transfers out of the account other than the planned input. */
    unexpectedOutflows: number;
    /** Allowance left to the spender after the simulated call. */
    allowanceAfter: string | null;
  } | null;
  guardian: { level: string; digest: string; quoteId: string } | null;
  /** Destination chains this foundation supports for the plan's kind. */
  supportedDestinations: readonly string[];
}
export interface PreflightReport {
  version: string;
  plan: string;
  checks: Check[];
  ready: boolean;
  digest: string;
}
const DIGITS = /^(0|[1-9]\d{0,77})$/;
const SIGNED = /^-?(0|[1-9]\d{0,77})$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const APPROVAL_GAS = 70_000n;
const lower = (a: string) => a.toLowerCase();
const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a &&
  !!b &&
  (/^0x[0-9a-fA-F]{40}$/.test(a) ? lower(a) === lower(b) : a === b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
/** The report digest, recomputable by anyone holding the report (G14: lifecycle.ts recomputes it, review N5). */
export const preflightDigest = (plan: string, checks: Check[], now: number) =>
  digest(["veined.execution.preflight.v3", plan, checks, now]);
export const CHECK_IDS: readonly CheckId[] = [
  "ASSETS",
  "CHAINS",
  "QUOTE",
  "PROVIDER",
  "BALANCE",
  "GAS",
  "RECIPIENT",
  "AMOUNTS",
  "FEES",
  "APPROVAL",
  "SIMULATION",
  "GUARDIAN",
  "WALLET",
];

export function preflight(
  plan: ExecutionPlan,
  f: PreflightFacts,
): PreflightReport {
  // A plan without the strict shape, or facts without theirs, is refused as a whole (review round 3 R7, round 4 S4):
  // nothing below can throw on it.
  const malformed = planProblem(plan) ?? factsProblem(f);
  if (malformed) {
    const invalid: Check[] = CHECK_IDS.map((id) => ({
      id,
      status: "FAIL",
      code: malformed,
    }));
    const marker = digest(["veined.execution.plan.invalid.v1"]);
    return {
      version: EXECUTION_POLICY.version,
      plan: marker,
      checks: invalid,
      ready: false,
      digest: digest([
        "veined.execution.preflight.v3",
        marker,
        invalid,
        Number.isSafeInteger(f?.now) ? f.now : null,
      ]),
    };
  }
  const checks: Check[] = [];
  const add = (id: CheckId, status: CheckStatus, code: string) =>
    checks.push({ id, status, code });
  const tx = plan.transaction;
  const family = familyOf(plan.provider);
  // Strict quantities (review F09): canonical decimal digits only — "", " 0 ", "0x0", "1e9" are not numbers here.
  const txNumbersOk =
    !tx ||
    (DIGITS.test(tx.value) &&
      /^\d{1,18}$/.test(tx.chainId) &&
      [tx.gas, tx.maxFeePerGas, tx.maxPriorityFeePerGas].every(
        (v) => v === undefined || DIGITS.test(v),
      ));
  const decoded =
    tx && txNumbersOk && plan.kind === "EVM_BRIDGE" && family === "lifi"
      ? decodeLifiBridgeCall(tx.data, plan.sourceChainId)
      : null;
  const amountIn = DIGITS.test(plan.amountIn) ? BigInt(plan.amountIn) : null;

  // 1–2 exact assets, contracts and decimals (registry evidence for the exact chain + contract; never synthesized)
  {
    const ok = (e: AssetEvidence | null, a: ExecutionPlan["pay"]) =>
      !!e &&
      e.chainId === a.chainId &&
      same(e.address, a.address) &&
      e.decimals === a.decimals &&
      e.symbol === a.symbol &&
      (e.level === "CANONICAL" || e.level === "CURATED") &&
      !e.risk?.length;
    if (!f.evidence.pay || !f.evidence.receive)
      add("ASSETS", "UNKNOWN", "ASSET_EVIDENCE_MISSING");
    else if (!ok(f.evidence.pay, plan.pay))
      add("ASSETS", "FAIL", "PAY_ASSET_NOT_REVIEWED");
    else if (!ok(f.evidence.receive, plan.receive))
      add("ASSETS", "FAIL", "RECEIVE_ASSET_NOT_REVIEWED");
    else add("ASSETS", "PASS", "REVIEWED_ASSETS");
  }
  // 2 chains
  {
    const kindOk =
      plan.kind === "EVM_SWAP"
        ? plan.sourceChainId === plan.destinationChainId
        : plan.kind === "EVM_BRIDGE"
          ? plan.sourceChainId !== plan.destinationChainId &&
            f.supportedDestinations.includes(plan.destinationChainId)
          : plan.destinationChainId === "near" &&
            f.supportedDestinations.includes("near");
    if (
      plan.pay.chainId !== plan.sourceChainId ||
      plan.receive.chainId !== plan.destinationChainId
    )
      add("CHAINS", "FAIL", "ASSET_CHAIN_MISMATCH");
    else if (!kindOk) add("CHAINS", "FAIL", "UNSUPPORTED_CHAIN_PAIR");
    else if (tx && tx.chainId !== plan.sourceChainId)
      add("CHAINS", "FAIL", "TRANSACTION_CHAIN_MISMATCH");
    else add("CHAINS", "PASS", "CHAINS_MATCH");
  }
  // 3 fresh executable quote
  {
    const age = f.now - plan.quotedAt;
    if (!plan.executable) add("QUOTE", "FAIL", "DRY_QUOTE_NOT_EXECUTABLE");
    else if (!(plan.expiresAt > plan.quotedAt) || plan.quotedAt > f.now + 5000)
      add("QUOTE", "FAIL", "QUOTE_TIME_INVALID");
    else if (f.now >= plan.expiresAt) add("QUOTE", "FAIL", "QUOTE_EXPIRED");
    else if (
      age > EXECUTION_POLICY.maxQuoteAgeMs ||
      plan.expiresAt - f.now < EXECUTION_POLICY.minRemainingMs
    )
      add("QUOTE", "FAIL", "QUOTE_TOO_OLD");
    else add("QUOTE", "PASS", "QUOTE_FRESH");
  }
  // 4 provider and contract identity — and whether the contract's behaviour is pinned (an upgradeable diamond is not)
  {
    // NEAR (review N1): the deposit transfer goes to a 1Click deposit address that only an executable quote can
    // give; until a deposit address is bound to the reviewed quote, the target is never "reviewed".
    if (plan.kind === "NEAR_INTENTS")
      add(
        "PROVIDER",
        family === "near-intents" ? "UNKNOWN" : "FAIL",
        family === "near-intents"
          ? "NEAR_DEPOSIT_NOT_VERIFIED"
          : "PROVIDER_NOT_SUPPORTED",
      );
    else if (!family || family === "near-intents")
      add("PROVIDER", "FAIL", "PROVIDER_NOT_SUPPORTED");
    else if (!tx) add("PROVIDER", "UNKNOWN", "CALLDATA_NOT_AVAILABLE");
    else {
      const target = identify(plan.sourceChainId, tx.to, "router", family);
      // The token spender is pinned for EVERY token payment, with or without an approval in this plan (round 3, R1).
      const token = !plan.pay.native;
      const spender =
        token && plan.spender
          ? identify(plan.sourceChainId, plan.spender, "spender", family)
          : null;
      if (!target) add("PROVIDER", "FAIL", "UNEXPECTED_TARGET_CONTRACT");
      else if (
        plan.approval &&
        !identify(plan.sourceChainId, plan.approval.spender, "spender", family)
      )
        add("PROVIDER", "FAIL", "UNEXPECTED_SPENDER");
      else if (token && !plan.spender)
        add("PROVIDER", "FAIL", "SPENDER_MISSING");
      else if (token && !spender) add("PROVIDER", "FAIL", "UNEXPECTED_SPENDER");
      else if (plan.approval && !same(plan.approval.spender, plan.spender))
        add("PROVIDER", "FAIL", "APPROVAL_SPENDER_MISMATCH");
      else if (!token && plan.spender)
        add("PROVIDER", "FAIL", "SPENDER_ON_NATIVE");
      else if (
        !behaviourPinned(target) ||
        (spender && !behaviourPinned(spender))
      )
        add("PROVIDER", "UNKNOWN", "CONTRACT_NOT_PINNED");
      else add("PROVIDER", "PASS", "REVIEWED_CONTRACTS");
    }
  }
  // 5 source balance (two RPC reads must agree)
  {
    const b = f.balances;
    if (b.agreement === "DISAGREE") add("BALANCE", "FAIL", "RPC_DISAGREEMENT");
    else if (b.pay === null || !DIGITS.test(b.pay) || amountIn === null)
      add("BALANCE", "UNKNOWN", "BALANCE_UNKNOWN");
    else if (BigInt(b.pay) < amountIn)
      add("BALANCE", "FAIL", "INSUFFICIENT_BALANCE");
    else
      add(
        "BALANCE",
        b.agreement === "AGREE" ? "PASS" : "UNKNOWN",
        b.agreement === "AGREE"
          ? "BALANCE_COVERS_AMOUNT"
          : "BALANCE_SINGLE_SOURCE",
      );
  }
  // 5 native gas — the transaction's own gas limit and fee cap count when they are higher than the estimate (F10)
  {
    const native = f.balances.native;
    const limits = [tx?.gas, f.gas.limit]
      .filter((v): v is string => !!v && DIGITS.test(v))
      .map(BigInt);
    const caps = [tx?.maxFeePerGas, f.gas.maxFeePerGas]
      .filter((v): v is string => !!v && DIGITS.test(v))
      .map(BigInt);
    if (
      !tx ||
      !txNumbersOk ||
      !native ||
      !DIGITS.test(native) ||
      !limits.length ||
      !caps.length
    )
      add("GAS", "UNKNOWN", "GAS_UNKNOWN");
    else if (
      tx.maxPriorityFeePerGas !== undefined &&
      (tx.maxFeePerGas === undefined ||
        BigInt(tx.maxPriorityFeePerGas) > BigInt(tx.maxFeePerGas))
    )
      // Round-2 review (F10): a priority fee above the fee cap is not a valid EIP-1559 transaction.
      add("GAS", "FAIL", "PRIORITY_FEE_ABOVE_CAP");
    else {
      const limit = limits.reduce(max),
        cap = caps.reduce(max);
      const approvalGas = plan.approval ? APPROVAL_GAS * cap : 0n;
      const fee =
        ((limit * cap + approvalGas) *
          BigInt(10000 + EXECUTION_POLICY.gasMarginBps)) /
        10000n;
      const need = fee + BigInt(tx.value);
      add(
        "GAS",
        BigInt(native) >= need ? "PASS" : "FAIL",
        BigInt(native) >= need ? "GAS_COVERED" : "INSUFFICIENT_GAS",
      );
    }
  }
  // 6 recipient (owner-signed canary: the owner's own address only) — read from an allowlisted call itself (F01)
  {
    if (!same(plan.recipient, plan.account))
      add("RECIPIENT", "FAIL", "RECIPIENT_NOT_SELF");
    else if (tx && !same(tx.from, plan.account))
      add("RECIPIENT", "FAIL", "SENDER_MISMATCH");
    else if (plan.kind === "EVM_BRIDGE") {
      if (!decoded) add("RECIPIENT", "UNKNOWN", "CALLDATA_NOT_DECODED");
      else if (decoded.hasDestinationCall)
        add("RECIPIENT", "FAIL", "DESTINATION_CALL");
      else if (!same(decoded.receiver, plan.recipient))
        add("RECIPIENT", "FAIL", "WRONG_RECIPIENT");
      else if (!decoded.receiverEnforced)
        add("RECIPIENT", "UNKNOWN", "FACET_RECEIVER_NOT_VERIFIED");
      else add("RECIPIENT", "PASS", "RECIPIENT_IN_CALLDATA");
    } else if (plan.kind === "EVM_SWAP") {
      const d = f.simulation?.receiveDelta;
      if (!f.simulation || d === null || d === undefined || !SIGNED.test(d))
        add("RECIPIENT", "UNKNOWN", "RECIPIENT_NOT_PROVEN");
      else
        add(
          "RECIPIENT",
          BigInt(d) > 0n ? "PASS" : "FAIL",
          BigInt(d) > 0n ? "OUTPUT_TO_RECIPIENT" : "WRONG_RECIPIENT",
        );
    } else
      add(
        "RECIPIENT",
        plan.refundTo && same(plan.refundTo, plan.account) ? "PASS" : "FAIL",
        plan.refundTo && same(plan.refundTo, plan.account)
          ? "REFUND_TO_SENDER"
          : "REFUND_NOT_SENDER",
      );
  }
  // 6–7 amounts, minimum output, slippage, value — and, for a bridge, the bridged amount against the disclosed fees
  {
    const min = DIGITS.test(plan.minimumOut) ? BigInt(plan.minimumOut) : null,
      expected = DIGITS.test(plan.expectedOut)
        ? BigInt(plan.expectedOut)
        : null;
    const nativeFees = plan.fees
      .filter(
        (x) =>
          !x.included &&
          x.kind === "fee" &&
          x.asset.native &&
          x.asset.chainId === plan.sourceChainId &&
          DIGITS.test(x.amount),
      )
      .reduce((n, x) => n + BigInt(x.amount), 0n);
    // Fees taken out of the amount sent, in the pay asset: the only legitimate gap between amount sent and bridged.
    const disclosedInPay = plan.fees
      .filter(
        (x) =>
          x.included &&
          x.asset.chainId === plan.pay.chainId &&
          same(x.asset.address, plan.pay.address) &&
          DIGITS.test(x.amount),
      )
      .reduce((n, x) => n + BigInt(x.amount), 0n);
    const amounts = (): [string, string] => {
      if (
        amountIn === null ||
        amountIn <= 0n ||
        min === null ||
        expected === null ||
        min <= 0n ||
        !Number.isInteger(plan.slippageBps) ||
        plan.slippageBps < 0
      )
        return ["FAIL", "AMOUNT_INVALID"];
      if (min > expected) return ["FAIL", "MINIMUM_ABOVE_EXPECTED"];
      // Exact bound (F12): (expected − min) / expected must not exceed the declared slippage, which must not exceed policy.
      // Providers floor the minimum (min = floor(expected × (1 − slippage))), so the bound is the floored minimum: an
      // honest 0.5 % quote passes and anything below it fails (found in the owner's live G13 session; review F12 kept).
      if (
        plan.slippageBps > EXECUTION_POLICY.maxSlippageBps ||
        min < (expected * BigInt(10000 - plan.slippageBps)) / 10000n
      )
        return ["FAIL", "SLIPPAGE_ABOVE_POLICY"];
      if (plan.kind === "NEAR_INTENTS")
        return ["UNKNOWN", "NEAR_DEPOSIT_NOT_VERIFIED"];
      if (!tx) return ["UNKNOWN", "CALLDATA_NOT_AVAILABLE"];
      if (!txNumbersOk) return ["FAIL", "TRANSACTION_NUMBER_INVALID"];
      if (BigInt(tx.value) !== (plan.pay.native ? amountIn : 0n) + nativeFees)
        return ["FAIL", "UNDISCLOSED_VALUE"];
      if (plan.kind === "EVM_SWAP")
        return ["UNKNOWN", "SWAP_MINIMUM_NOT_DECODED"];
      if (!decoded) return ["UNKNOWN", "CALLDATA_NOT_DECODED"];
      if (decoded.destinationChainId !== plan.destinationChainId)
        return ["FAIL", "DESTINATION_CHAIN_MISMATCH"];
      if (!same(decoded.referrer, ZERO_ADDRESS))
        return ["FAIL", "REFERRER_SET"];
      // The sent asset is read from the call for native coins too (review N8): LI.FI uses the zero address.
      if (
        plan.pay.native
          ? !same(decoded.sendingAssetId, ZERO_ADDRESS)
          : !same(decoded.sendingAssetId, plan.pay.address)
      )
        return ["FAIL", "SENDING_ASSET_MISMATCH"];
      if (decoded.minAmount > amountIn) return ["FAIL", "BRIDGED_ABOVE_INPUT"];
      const fees = lifiFees(
        decoded,
        plan.sourceChainId,
        plan.pay.address,
        amountIn,
      );
      if ("problem" in fees)
        return [fees.definitive ? "FAIL" : "UNKNOWN", fees.problem];
      if (fees.sum > disclosedInPay) return ["FAIL", "UNDISCLOSED_FEE"];
      if (
        amountIn - decoded.minAmount > disclosedInPay ||
        amountIn - decoded.minAmount !== fees.sum
      )
        return ["FAIL", "BRIDGED_BELOW_DISCLOSED"];
      // The destination asset and minimum live in the facet's own data, which is not decoded yet (stated, not guessed).
      return ["UNKNOWN", "DESTINATION_MINIMUM_NOT_DECODED"];
    };
    const [status, code] = amounts();
    add("AMOUNTS", status as CheckStatus, code);
  }
  // 7 fees (named, priced, a quoted network fee; VEINED commission 0; not uneconomic). Fee USD values are the
  // provider's own: a known limit (review F11), stated in the security review.
  {
    const usd = (v: string | null) =>
      v && /^\d{1,30}(\.\d{1,18})?$/.test(v) ? Number(v) : null;
    const costs = plan.fees.map((x) =>
      /^0+$/.test(x.amount) ? 0 : usd(x.usd),
    );
    const input = usd(f.inputUsd);
    if (plan.platformFeeBps !== 0)
      add("FEES", "FAIL", "PLATFORM_FEE_NOT_ALLOWED");
    else if (plan.fees.some((x) => !DIGITS.test(x.amount) || !x.name))
      add("FEES", "FAIL", "FEE_LINE_INVALID");
    else if (
      plan.kind !== "NEAR_INTENTS" &&
      !plan.fees.some((x) => x.kind === "gas")
    )
      add("FEES", "UNKNOWN", "NETWORK_FEE_NOT_QUOTED");
    else if (costs.some((c) => c === null) || input === null || input <= 0)
      add("FEES", "UNKNOWN", "FEES_NOT_PRICED");
    else {
      const share =
        ((costs as number[]).reduce((a, b) => a + b, 0) / input) * 10000;
      add(
        "FEES",
        share >= EXECUTION_POLICY.uneconomicCostBps ? "FAIL" : "PASS",
        share >= EXECUTION_POLICY.uneconomicCostBps
          ? "UNECONOMIC"
          : "FEES_DISCLOSED",
      );
    }
  }
  // 10 exact approval for the reviewed spender only
  {
    // The allowance counts only when it was read for this plan's own spender (round 4, S3).
    const readForSpender =
      plan.pay.native || same(f.allowanceSpender, plan.spender);
    const p = approvalProblem(
      plan,
      readForSpender && f.allowance !== null && DIGITS.test(f.allowance)
        ? BigInt(f.allowance)
        : null,
      (s) => !!family && !!identify(plan.sourceChainId, s, "spender", family),
    );
    if (plan.kind === "NEAR_INTENTS" && !plan.approval)
      add("APPROVAL", "PASS", "NO_APPROVAL");
    else if (p === "ALLOWANCE_UNKNOWN") add("APPROVAL", "UNKNOWN", p);
    else if (p) add("APPROVAL", "FAIL", p);
    else
      add(
        "APPROVAL",
        "PASS",
        plan.approval ? "EXACT_APPROVAL" : "NO_APPROVAL_NEEDED",
      );
  }
  // 8 simulation of the exact calldata (strict numbers; an approval needs a READ allowance after the call)
  {
    const s = f.simulation;
    if (plan.kind === "NEAR_INTENTS")
      add("SIMULATION", "UNKNOWN", "DEPOSIT_TRANSFER_NOT_SIMULATED");
    else if (!s) add("SIMULATION", "UNKNOWN", "SIMULATION_NOT_RUN");
    else if (!s.success) add("SIMULATION", "FAIL", "SIMULATION_REVERTED");
    else if (
      !SIGNED.test(s.payDelta) ||
      amountIn === null ||
      BigInt(s.payDelta) !== -amountIn
    )
      add("SIMULATION", "FAIL", "SIMULATED_INPUT_MISMATCH");
    else if (
      !Number.isInteger(s.unexpectedOutflows) ||
      s.unexpectedOutflows !== 0
    )
      add("SIMULATION", "FAIL", "UNEXPECTED_OUTFLOW");
    else if (
      // Every token payment must prove no allowance is left behind (round 3, R1), with or without an approval.
      !plan.pay.native &&
      (s.allowanceAfter === null ||
        !DIGITS.test(s.allowanceAfter) ||
        !same(f.allowanceSpender, plan.spender))
    )
      add("SIMULATION", "UNKNOWN", "ALLOWANCE_AFTER_UNKNOWN");
    else if (
      s.allowanceAfter !== null &&
      DIGITS.test(s.allowanceAfter) &&
      BigInt(s.allowanceAfter) > 0n
    )
      add("SIMULATION", "FAIL", "RESIDUAL_ALLOWANCE");
    else if (
      plan.kind === "EVM_SWAP" &&
      (s.receiveDelta === null ||
        !SIGNED.test(s.receiveDelta) ||
        !DIGITS.test(plan.minimumOut) ||
        BigInt(s.receiveDelta) < BigInt(plan.minimumOut))
    )
      add("SIMULATION", "FAIL", "SIMULATED_OUTPUT_BELOW_MINIMUM");
    else add("SIMULATION", "PASS", "SIMULATION_MATCHES_PLAN");
  }
  // 9 server-side Guardian on this exact quote
  {
    const g = f.guardian;
    if (!g) add("GUARDIAN", "UNKNOWN", "GUARDIAN_NOT_RUN");
    else if (g.quoteId !== plan.quoteId)
      add("GUARDIAN", "FAIL", "GUARDIAN_STALE");
    else if (g.level === "BLOCK" || g.level === "HOLD")
      add("GUARDIAN", "FAIL", `GUARDIAN_${g.level}`);
    else if (g.level === "CLEAR" || g.level === "CAUTION")
      add("GUARDIAN", "PASS", `GUARDIAN_${g.level}`);
    else add("GUARDIAN", "FAIL", "GUARDIAN_UNKNOWN_LEVEL");
  }
  // 12–13 the wallet that would sign is this plan's account on the source chain (a claimed identity is not proof)
  {
    const w = f.wallet;
    if (!w.account || !w.chainId)
      add("WALLET", "UNKNOWN", "WALLET_NOT_CONNECTED");
    else if (!same(w.account, plan.account))
      add("WALLET", "FAIL", "WALLET_ACCOUNT_MISMATCH");
    else if (plan.kind !== "NEAR_INTENTS" && w.chainId !== plan.sourceChainId)
      add("WALLET", "FAIL", "WALLET_CHAIN_MISMATCH");
    else if (!w.proven) add("WALLET", "UNKNOWN", "WALLET_NOT_PROVEN");
    else add("WALLET", "PASS", "WALLET_MATCHES");
  }
  const planHash = planDigest(plan);
  return {
    version: EXECUTION_POLICY.version,
    plan: planHash,
    checks,
    ready: checks.every((c) => c.status === "PASS"),
    digest: preflightDigest(planHash, checks, f.now),
  };
}
