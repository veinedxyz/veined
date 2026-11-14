// G14 Track A + G14 closure: the smallest owner-signed canary PATHWAY, server side. It is constructed in exactly ONE
// place, the server runtime (./runtime.ts), with the durable store, the two-operator pool, the protected canary gate
// and the server Guardian; that runtime is reachable only through /api/execution, and every step that could lead to a
// signature is refused there while the canary gate is CLOSED (it is, in this build: no owner record, wiring false).
// It joins every control the canary needs into one fail-closed sequence over the G13 lifecycle:
//   review    fresh executable quote -> independent Across decoder -> pins re-read from two operators at one block,
//             bound to the call's selector -> exact spender/allowance -> balances + native gas incl. L1 fee (two
//             operators) -> eth_simulateV1 that THIS engine builds (reviewed gas, real fees, no state override) ->
//             wallet/account/chain binding -> Guardian verdict -> single-use journal; the results are MACed in this
//             process (integrity between review and start inside the server; not an external proof) and mapped onto
//             the 13 G13 preflight checks;
//   start     QUOTE_READ -> PREFLIGHT (report recomputed by the lifecycle) -> GUARDIAN -> REVIEW_SHOWN, only with this
//             process's attestations, each step anchored BEFORE it is committed;
//   authorize a SERVER token (single use, global nonce) — only while the execution gate is OPEN;
//   prepare   consumes the token, writes the single-use journal at the first authorization and returns the exact
//             canonical transaction for the owner's own wallet — only while the gate is OPEN;
//   observe   source observations (submission, replacement, reorg, drop); settle / reconcile build the destination
//             and reconciliation events ONLY from logs and balances the server read itself (round-1 review F9).
// In this candidate the gate is CLOSED by the protected sources: authorize and prepare refuse GATE_CLOSED.
// The Guardian verdict is an INPUT the server Guardian must compute for this plan (caller-trusted; stated).
// Stated limits (round-2 review N7): the use journal assumes ONE server instance (check-then-append is not atomic across
// processes); a wallet rejection after the first authorization still consumes the canary (a new owner-approved
// record is needed — the conservative choice); if the anchor sink fails half-way through start(), the steps already
// anchored stay committed and the record must be inspected; reconciliation trusts the caller to read "before" at or
// below the source block and "after" at or above the fill block; if the journal append fails AFTER the step was
// recorded, no transaction is handed out and the canary is not spent, but the record reads AWAITING_* until it times
// out (round-5 W3: fails closed, needs the owner's eye).
// Nothing here signs, holds a key, broadcasts or retries a transaction.
import {
  EXECUTION_POLICY,
  TERMINAL,
  type ExecutionPlan,
  type FeeLine,
  type WalletTransaction,
} from "../../model";
import {
  apply,
  newRecord,
  type ExecutionEvent,
  type ExecutionRecord,
} from "../../lifecycle";
import { planDigest, reviewDigest } from "../../binding";
import { digest } from "../../canonical";
import {
  CHECK_IDS,
  preflightDigest,
  type Check,
  type CheckId,
} from "../../preflight";
import { approvalTransaction } from "../../erc20";
import {
  CANARY_PINS,
  pinProblems,
  pinValues,
  type DestinationPinReads,
  type PinReads,
} from "../../canary/pins";
import { CANARY_SCOPE } from "../../canary/scope";
import {
  verifyCanaryQuote,
  type CanaryCheck,
  type ExecutableQuote,
} from "../../canary/quote-verify";
import {
  agree,
  agreeConfigured,
  agreementCheck,
  balanceAndGasCheck,
  type ConfiguredSource,
  type SourceRead,
} from "../../canary/chain-reads";
import {
  canarySimulationRequest,
  interpretCanarySimulation,
  type SimulationRequest,
} from "../../canary/simulation";
import {
  depositFromSourceLogs,
  destinationSettlement,
  reconcileCanary,
  type ChainLog,
  type Settlement,
} from "../../canary/settlement";
import type {
  CanaryAuthorizationStore,
  AuthorizationToken,
} from "./authorization-store";
import type { ReviewAttestor, Attestation } from "./attestation";
import type { AuditAnchorLog } from "./audit-anchor";
import type { CanaryGateFacts } from "../gate";
import { isCanaryQuote } from "../../../adapters/routing-core";

export class CanaryError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "CanaryError";
  }
}
/** Append-only journal of canary uses (a file opened for append in production; memory in tests), review F3. */
export interface CanaryUseJournal {
  append(line: string): void;
  load(): readonly string[];
  /**
   * G14 proposal B5: true only for a store that survives a restart (an append-only file, a database). The memory
   * journal does not claim it, so the canary gate reads USE_STORE_UNPROVEN for it and stays closed.
   */
  readonly durable?: boolean;
}
export class MemoryUseJournal implements CanaryUseJournal {
  readonly #lines: string[] = [];
  append(line: string) {
    this.#lines.push(line);
  }
  load() {
    return [...this.#lines];
  }
}
export interface CanaryReviewInput {
  record: string;
  owner: string;
  amountIn: string;
  minimumOut: string;
  now: number;
  /** The connected wallet as the SERVER proved it (not as a request claimed it). */
  wallet: { account: string | null; chainId: string | null; proven: boolean };
  quote: ExecutableQuote | null;
  /** Source-side pin reads from two independent operators, each at one block. */
  pins: [PinReads | null, PinReads | null];
  /** Owner balances on Base from two independent operators: values usdc, native, allowance (to the Diamond). */
  balances: [SourceRead | null, SourceRead | null];
  /** Server-read fee values (wei, decimal) for the simulation and the gas check (one source today; B4 adds a second). */
  fees: {
    baseFeePerGas: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
  } | null;
  /** OP-stack L1 data fee of the canary transactions (GasPriceOracle.getL1Fee), wei decimal. */
  l1FeeWei: string | null;
  /** Server-computed Guardian verdict for this plan (caller-trusted input). */
  guardian: { level: string; digest: string } | null;
}
export interface CanaryReview {
  record: string;
  plan: ExecutionPlan | null;
  planHash: string | null;
  checks: CanaryCheck[];
  /** The 13 G13 preflight checks this maps onto (what the lifecycle records). */
  report: { checks: Check[]; now: number };
  ready: boolean;
  simulation: { requestDigest: string; block: string | null } | null;
  attestation: Attestation | null;
  guardianAttestation: Attestation | null;
  checksAttestation: Attestation | null;
  /** The Guardian verdict this review attested (re-verified at start). */
  guardian: { level: string; digest: string } | null;
  needsApproval: boolean;
}
const GROUPS: Readonly<Record<CheckId, readonly string[]>> = Object.freeze({
  ASSETS: ["ASSETS"],
  CHAINS: ["SCOPE", "DEADLINES", "SINGLE_USE"],
  QUOTE: ["QUOTE_FRESH", "REVIEW_BLOCK_FRESH"],
  PROVIDER: [
    "TARGET",
    "CALLDATA",
    "PINS",
    "PINS_AGREEMENT",
    "PINS_AT_REVIEW_BLOCK",
  ],
  BALANCE: ["BALANCE", "BALANCE_AGREEMENT"],
  GAS: ["GAS", "GAS_LIMIT", "GAS_LIMIT_COVERS"],
  RECIPIENT: ["RECIPIENT", "REFUND"],
  AMOUNTS: ["MIN_OUTPUT"],
  FEES: ["FEES"],
  APPROVAL: ["SPENDER", "ALLOWANCE"],
  SIMULATION: ["SIMULATION", "SIMULATION_FLOWS", "SIMULATION_DEPOSIT"],
  GUARDIAN: ["GUARDIAN"],
  WALLET: ["WALLET"],
});
const lower = (a: unknown) => (typeof a === "string" ? a.toLowerCase() : "");
const DIGITS = /^(0|[1-9]\d{0,77})$/;
const usd6 = {
  chainId: "8453",
  address: CANARY_PINS.usdc["8453"].address,
  symbol: "USDC",
  decimals: 6,
  native: false,
};
const pinSource = (p: PinReads | null): SourceRead | null =>
  p
    ? {
        origin: p.origin,
        chainId: p.chainId,
        block: p.block,
        values: pinValues(p),
      }
    : null;

/** The eight fields a wallet step carries (hex quantities), as the owner record's wallet guard compares them. */
export type CanaryWalletRequest = Readonly<
  Record<
    | "chainId"
    | "from"
    | "to"
    | "value"
    | "data"
    | "gas"
    | "maxFeePerGas"
    | "maxPriorityFeePerGas",
    string
  >
>;
export class CanaryEngine {
  readonly #records = new Map<string, ExecutionRecord>();
  readonly #reviews = new Map<string, CanaryReview>();
  constructor(
    private readonly deps: {
      /**
       * The gate decision for ONE wallet step. G14 proposal B5: the engine hands it the facts it proved about that
       * step (account, chain, pins, exact amount, reviewed output, gas, single-use state, operators); the canary
       * gate (server/gate.ts canaryGateState) checks them against the protected owner record.
       */
      gate: (facts?: CanaryGateFacts) => {
        open: boolean;
        reasons: readonly string[];
      };
      authorizations: CanaryAuthorizationStore;
      attestor: ReviewAttestor;
      anchors: AuditAnchorLog;
      uses: CanaryUseJournal;
      /** eth_simulateV1 through the protected Swap transport (only the request this engine built is sent). */
      simulate: (request: SimulationRequest, block: string) => Promise<unknown>;
      /**
       * G14 proposal B4: the configured RPC pool per chain (src/swap/server/config.ts CANARY_RPC_POOL). When given,
       * every agreement must come from two DIFFERENT configured operators; the live wiring must give it.
       */
      pool?: Readonly<Record<string, readonly ConfiguredSource[]>>;
      /**
       * G14 proposal B5: native wei the owner's already-mined exact approval cost, read by the server (receipt).
       * Unknown (absent / null) means the gas budget cannot be proven for the following SEND.
       */
      approvalCostWei?: (owner: string) => string | null;
      /**
       * G14 closure: every lifecycle event, handed over in the same step as its anchor (the runtime writes both to
       * the durable store in one batch, so a restart can rebuild the records). A throw refuses the event.
       */
      events?: (record: string, event: ExecutionEvent) => void;
    },
  ) {}
  /**
   * G14 closure (restart): rebuilds a record from its persisted events through the same lifecycle rules (every event
   * is re-validated; a record that does not replay is refused). Only for a record this engine does not know yet.
   * Nothing is anchored again: the anchors are restored with the anchor log itself.
   */
  restore(id: string, events: readonly ExecutionEvent[]): ExecutionRecord {
    if (this.#records.has(id)) throw new CanaryError("RECORD_EXISTS");
    let r = newRecord(id);
    for (const e of events) r = apply(r, e);
    this.#records.set(id, r);
    return r;
  }
  /** Every record this engine holds (restored or new), by id. */
  records(): readonly ExecutionRecord[] {
    return [...this.#records.values()];
  }
  /**
   * What each review proved for the gate facts (never part of the review object handed to a caller). Bound to the
   * plan it was computed for (review 1 F7): facts of another review never describe the recorded plan.
   */
  readonly #facts = new Map<
    string,
    {
      planHash: string | null;
      quoteFromAdapter: boolean | null;
      pins: {
        set: string;
        runtimeHash: string | null;
        implementationHash: string | null;
        block: string | null;
        observedAt: number | null;
        twoOperatorsAgree: boolean;
      };
      wallet: { account: string | null; chainId: string | null };
      operatorsConfigured: boolean | null;
      approveGasLimit: string | null;
      maxFeePerGas: string | null;
      maxPriorityFeePerGas: string | null;
      l1FeeWei: string | null;
    }
  >();
  #agree(
    a: SourceRead | null,
    b: SourceRead | null,
    keys: readonly string[],
    chainId: string,
  ) {
    return this.deps.pool
      ? agreeConfigured(a, b, keys, chainId, this.deps.pool[chainId])
      : agree(a, b, keys, chainId);
  }
  /** The facts of the recorded plan, or null when the latest review of this record was of another plan. */
  #factsOf(record: string) {
    const r = this.#records.get(record);
    const f = this.#facts.get(record);
    if (!r?.plan || !f || !f.planHash || f.planHash !== planDigest(r.plan))
      return null;
    return { r, p: r.plan, f };
  }
  /**
   * The facts of the record's NEXT wallet step for the canary gate (G14 proposal B2 + B5), from the recorded plan
   * and what ITS review proved: the step's own transaction, the pin evidence, the proven wallet, the reviewed output,
   * the gas of every step still to sign and the single-use state. Anything not proven is null, which the gate denies.
   */
  stepFacts(record: string, now: number): CanaryGateFacts | undefined {
    const x = this.#factsOf(record);
    if (!x) return undefined;
    const { r, p, f } = x;
    const action = p.approval && !r.hashes.approval ? "APPROVE" : "SEND";
    const phases = this.phases(p.account);
    const cap = f.maxFeePerGas;
    const send =
      p.transaction?.gas && cap
        ? {
            action: "SEND" as const,
            gasLimit: p.transaction.gas,
            maxFeePerGas: cap,
          }
        : null;
    const approve =
      f.approveGasLimit && cap
        ? {
            action: "APPROVE" as const,
            gasLimit: f.approveGasLimit,
            maxFeePerGas: cap,
          }
        : null;
    const spent =
      phases.approve === null
        ? "0"
        : (this.deps.approvalCostWei?.(p.account) ?? null);
    const remaining =
      action === "APPROVE"
        ? approve && send
          ? [approve, send]
          : null
        : send
          ? [send]
          : null;
    let tx: WalletTransaction | null = null;
    try {
      tx =
        action === "APPROVE"
          ? (approvalTransaction(p) as WalletTransaction)
          : (p.transaction ?? null);
    } catch {
      tx = null;
    }
    if (!tx) return undefined;
    return {
      step: {
        now,
        action,
        transaction: {
          chainId: tx.chainId,
          from: tx.from,
          to: tx.to,
          value: tx.value,
          data: tx.data,
        },
        pins: { ...f.pins },
        wallet: { ...f.wallet },
        expectedOut: p.expectedOut,
        gas:
          remaining && spent !== null && f.l1FeeWei !== null
            ? { remaining, spentWei: spent, l1FeeWei: f.l1FeeWei }
            : null,
        use:
          this.deps.uses.durable === true
            ? {
                durable: true,
                approveConsumed: phases.approve !== null,
                sendConsumed: phases.send !== null,
              }
            : null,
      },
      operatorsConfigured: f.operatorsConfigured,
      quoteFromAdapter: f.quoteFromAdapter,
    };
  }
  /** The wallet request of each prepared step, fixed at prepare() time (review 2 G3), keyed by record. */
  readonly #prepared = new Map<
    string,
    { nonce: string; request: CanaryWalletRequest }
  >();
  /** The eight-field wallet request of `action` for the recorded plan, from the facts the gate has just judged. */
  #walletRequestOf(
    record: string,
    action: "APPROVE" | "SEND",
  ): CanaryWalletRequest {
    const x = this.#factsOf(record);
    if (!x) throw new CanaryError("UNKNOWN_RECORD");
    const { p, f } = x;
    const approval = action === "APPROVE";
    const tx = approval
      ? (approvalTransaction(p) as WalletTransaction)
      : p.transaction;
    const gas = approval ? f.approveGasLimit : (p.transaction?.gas ?? null);
    if (
      !tx ||
      !gas ||
      !f.maxFeePerGas ||
      !f.maxPriorityFeePerGas ||
      ![tx.chainId, tx.value, gas].every((v) => DIGITS.test(v))
    )
      throw new CanaryError("GAS_NOT_PROVEN");
    const hex = (v: string) => `0x${BigInt(v).toString(16)}`;
    return Object.freeze({
      chainId: hex(tx.chainId),
      from: tx.from,
      to: tx.to,
      value: hex(tx.value),
      data: tx.data,
      gas: hex(gas),
      maxFeePerGas: hex(f.maxFeePerGas),
      maxPriorityFeePerGas: hex(f.maxPriorityFeePerGas),
    });
  }
  /**
   * The wallet request of the step this record is waiting for, AFTER prepare() handed it out (states
   * AWAITING_APPROVAL_SIGNATURE / AWAITING_SIGNATURE only): hex quantities, with the reviewed gas limit (APPROVE: the
   * simulated need x the policy margin; SEND: the quote's reviewed limit) and the review's fee caps — the exact eight
   * fields the owner record's wallet guard and the adapter compare. It is the frozen snapshot prepare() took from
   * the facts the gate judged at that moment: a later review() of the same record cannot change it (review 2 G3),
   * and it is never built from a transaction a caller passes in (review 1 F8). Built only; nothing is sent.
   */
  walletRequest(record: string): CanaryWalletRequest {
    const r = this.#records.get(record);
    if (!r) throw new CanaryError("UNKNOWN_RECORD");
    const snapshot = this.#prepared.get(record);
    if (
      (r.state !== "AWAITING_APPROVAL_SIGNATURE" &&
        r.state !== "AWAITING_SIGNATURE") ||
      !snapshot ||
      !r.pending ||
      r.pending.nonce !== snapshot.nonce
    )
      throw new CanaryError("STEP_NOT_PREPARED");
    return snapshot.request;
  }
  #useKey(owner: string) {
    return `${CANARY_SCOPE.id}:${lower(owner)}`;
  }
  /**
   * The owner's canary phases, durable across restarts (round-3 review M1): the journal holds one line per wallet step
   * ever authorized, `<scope>:<owner>:<record>:APPROVE|SEND`. The canary allows AT MOST ONE exact approval and AT MOST
   * ONE main send per owner, ever — whatever record ids, restarts or re-quotes happen in between.
   */
  phases(owner: string): { approve: string | null; send: string | null } {
    const key = this.#useKey(owner) + ":";
    let approve: string | null = null,
      send: string | null = null;
    for (const raw of this.deps.uses.load()) {
      // A line written with CRLF (or surrounding blanks) is the same line (round-5 W2).
      const line = raw.trim();
      if (!line.startsWith(key)) continue;
      const [record, phase] = line.slice(key.length).split(":");
      if (phase === "APPROVE" && approve === null) approve = record;
      if (phase === "SEND" && send === null) send = record;
      // An unrecognised line for this owner (old format, truncated write) fails CLOSED: read as a send (round-4 P2).
      if (phase !== "APPROVE" && phase !== "SEND" && send === null)
        send = record || "UNKNOWN_RECORD";
    }
    return { approve, send };
  }
  /** The record that first used the canary for this owner (approval or send), if any. */
  usedBy(owner: string): string | null {
    const p = this.phases(owner);
    return p.approve ?? p.send;
  }
  /** Why the owner's canary cannot take this step, or null (APPROVE / SEND each at most once per owner, ever). */
  #phaseProblem(owner: string, needsApproval: boolean): string | null {
    const p = this.phases(owner);
    if (p.send !== null) return "CANARY_ALREADY_SENT";
    if (needsApproval && p.approve !== null) return "APPROVAL_ALREADY_USED";
    return null;
  }

  async review(i: CanaryReviewInput): Promise<CanaryReview> {
    const v = verifyCanaryQuote({
      quote: i.quote,
      owner: i.owner,
      amountIn: i.amountIn,
      minimumOut: i.minimumOut,
      now: i.now,
    });
    const checks: CanaryCheck[] = [...v.checks];
    // SINGLE_USE is decided below, once the allowance (and so whether an approval is needed) is known.
    // Pins: each source must match every pin for THE selector the call uses; the two must be distinct operators at one block.
    const selector = v.call?.selector ?? CANARY_PINS.selector;
    const probs = i.pins.map((p) => [
      ...pinProblems(p),
      ...(p && lower(p.selector) !== selector ? ["SELECTOR_MISMATCH"] : []),
    ]);
    checks.push({
      id: "PINS",
      status:
        !i.pins[0] ||
        !i.pins[1] ||
        probs.some((x) => x.includes("PIN_UNREADABLE"))
          ? "UNKNOWN"
          : probs.every((x) => x.length === 0)
            ? "PASS"
            : "FAIL",
      code: probs.flat().length
        ? [...new Set(probs.flat())].sort().join(",")
        : "ALL_PINS_MATCH",
    });
    const pinAgreement = this.#agree(
      pinSource(i.pins[0]),
      pinSource(i.pins[1]),
      Object.keys(pinValues(i.pins[0] ?? i.pins[1] ?? ({} as PinReads))),
      CANARY_SCOPE.sourceChainId,
    );
    checks.push(agreementCheck("PINS_AGREEMENT", pinAgreement));
    const bal = this.#agree(
      i.balances[0],
      i.balances[1],
      ["usdc", "native", "allowance"],
      CANARY_SCOPE.sourceChainId,
    );
    checks.push(agreementCheck("BALANCE_AGREEMENT", bal));
    // Pins, balances and the simulation describe ONE block (number and hash, round-2 review N4).
    const rb = i.balances[0]?.block ?? null;
    const sameBlock =
      !!rb &&
      i.pins.every(
        (p) =>
          !!p?.block &&
          p.block.number === rb.number &&
          p.block.hash.toLowerCase() === rb.hash.toLowerCase(),
      );
    // The review block must be recent (round-4 NIT): an old block proves nothing about now.
    const age =
      rb && Number.isSafeInteger(rb.timestamp)
        ? Math.floor(i.now / 1000) - rb.timestamp!
        : null;
    checks.push({
      id: "REVIEW_BLOCK_FRESH",
      status:
        age !== null && age >= -5 && age <= CANARY_SCOPE.maxReviewBlockAgeSec
          ? "PASS"
          : "UNKNOWN",
      code:
        age === null
          ? "BLOCK_TIME_NOT_READ"
          : age > CANARY_SCOPE.maxReviewBlockAgeSec
            ? `BLOCK_TOO_OLD:${age}`
            : "FRESH",
    });
    checks.push({
      id: "PINS_AT_REVIEW_BLOCK",
      status: sameBlock ? "PASS" : "UNKNOWN",
      code: sameBlock ? "ONE_BLOCK" : "PINS_NOT_AT_REVIEW_BLOCK",
    });
    const amountIn = /^(0|[1-9]\d{0,40})$/.test(i.amountIn)
      ? BigInt(i.amountIn)
      : 0n;
    const allowance = bal.values?.allowance ?? null;
    const needsApproval =
      allowance === null ? true : BigInt(allowance) < amountIn;
    // Single use per owner (rounds 1 F3, 2 N1, 3 M1/M2): never a second main send, never a second approval; a standing
    // exact approval may be used by a later record (no allowance is left stranded at the Diamond).
    const phaseProblem = /^0x[0-9a-fA-F]{40}$/.test(i.owner)
      ? this.#phaseProblem(i.owner, needsApproval)
      : "OWNER_INVALID";
    const phase = /^0x[0-9a-fA-F]{40}$/.test(i.owner)
      ? this.phases(i.owner)
      : null;
    checks.push({
      id: "SINGLE_USE",
      status: phaseProblem === null ? "PASS" : "FAIL",
      code:
        phaseProblem ??
        (phase?.approve !== null ? "APPROVAL_STANDING" : "NOT_USED"),
    });
    checks.push({
      id: "ALLOWANCE",
      status:
        allowance === null
          ? "UNKNOWN"
          : BigInt(allowance) === 0n || BigInt(allowance) === amountIn
            ? "PASS"
            : "FAIL",
      code:
        allowance === null
          ? "ALLOWANCE_NOT_AGREED"
          : BigInt(allowance) === 0n
            ? "EXACT_APPROVAL_NEEDED"
            : BigInt(allowance) === amountIn
              ? "EXACT_ALLOWANCE_PRESENT"
              : "UNEXPECTED_EXISTING_ALLOWANCE",
    });
    // Simulation: built HERE from the decoded call, the reviewed gas limit and the agreed fees, at the agreed block.
    let gasUsed: bigint[] = [];
    let simulation: CanaryReview["simulation"] = null;
    const feesOk =
      !!i.fees &&
      [
        i.fees.baseFeePerGas,
        i.fees.maxFeePerGas,
        i.fees.maxPriorityFeePerGas,
      ].every((x) => typeof x === "string" && DIGITS.test(x));
    const block = i.balances[0]?.block?.number ?? null;
    if (
      v.call &&
      v.feeTotal !== null &&
      v.gasLimit &&
      feesOk &&
      bal.status === "AGREE" &&
      block &&
      i.quote?.transactionRequest
    ) {
      const request = canarySimulationRequest({
        owner: i.owner,
        amountIn,
        needsApproval,
        tx: {
          to: CANARY_PINS.diamond.address,
          data: i.quote.transactionRequest.data,
          value: "0",
          gas: v.gasLimit,
        },
        fees: i.fees!,
      });
      simulation = { requestDigest: digest(request), block };
      let result: unknown = null;
      try {
        result = await this.deps.simulate(request, block);
      } catch {
        result = null;
      }
      const s = interpretCanarySimulation(result, {
        owner: i.owner,
        amountIn,
        needsApproval,
        call: v.call,
        feeTotal: v.feeTotal,
      });
      checks.push(...s.checks);
      gasUsed = s.gasUsed;
      // The signed gas limit must cover the simulated need with the policy margin (an out-of-gas main transaction
      // would leave the exact approval standing at the Diamond, review F11).
      const main = gasUsed.at(-1) ?? 0n;
      const need =
        (main * BigInt(10_000 + EXECUTION_POLICY.gasMarginBps)) / 10_000n;
      checks.push({
        id: "GAS_LIMIT_COVERS",
        status: main > 0n && BigInt(v.gasLimit) >= need ? "PASS" : "FAIL",
        code:
          main > 0n && BigInt(v.gasLimit) >= need
            ? `COVERS:${need}`
            : `GAS_LIMIT_BELOW_SIMULATED_NEED:${need}`,
      });
    } else {
      for (const id of [
        "SIMULATION",
        "SIMULATION_FLOWS",
        "SIMULATION_DEPOSIT",
        "GAS_LIMIT_COVERS",
      ])
        checks.push({ id, status: "UNKNOWN", code: "NOT_SIMULATED" });
    }
    checks.push(
      ...balanceAndGasCheck({
        usdcBalance: bal.values?.usdc ?? null,
        amountIn,
        nativeBalance: bal.values?.native ?? null,
        gasUsed,
        maxFeePerGas: feesOk ? i.fees!.maxFeePerGas : null,
        l1FeeWei: i.l1FeeWei,
      }),
    );
    const walletOk =
      i.wallet.proven &&
      lower(i.wallet.account) === lower(i.owner) &&
      i.wallet.chainId === CANARY_SCOPE.sourceChainId;
    checks.push({
      id: "WALLET",
      status: !i.wallet.proven ? "UNKNOWN" : walletOk ? "PASS" : "FAIL",
      code: !i.wallet.proven
        ? "WALLET_NOT_PROVEN"
        : walletOk
          ? "OWNER_ON_BASE"
          : "WRONG_ACCOUNT_OR_CHAIN",
    });
    const g = i.guardian;
    const gOk =
      !!g &&
      /^[0-9a-f]{64}$/.test(g.digest) &&
      (g.level === "CLEAR" || g.level === "CAUTION");
    checks.push({
      id: "GUARDIAN",
      status: !g ? "UNKNOWN" : gOk ? "PASS" : "FAIL",
      code: g ? `GUARDIAN_${g.level}` : "NO_SERVER_VERDICT",
    });
    // Map onto the G13 preflight ids (worst status of the group; codes joined).
    const report: Check[] = CHECK_IDS.map((id) => {
      const group = checks.filter((c) => GROUPS[id].includes(c.id));
      const status =
        group.length === 0
          ? "UNKNOWN"
          : group.some((c) => c.status === "FAIL")
            ? "FAIL"
            : group.some((c) => c.status === "UNKNOWN")
              ? "UNKNOWN"
              : "PASS";
      return {
        id,
        status,
        code:
          group
            .map((c) => `${c.id}:${c.code}`)
            .join("|")
            .slice(0, 400) || "NOT_CHECKED",
      };
    });
    const plan =
      v.call && v.gasLimit && i.quote?.transactionRequest
        ? this.#plan(
            i,
            v.call.effectiveOutput,
            v.feeTotal,
            needsApproval,
            v.gasLimit,
          )
        : null;
    const planHash = plan ? planDigest(plan) : null;
    const ready = report.every((c) => c.status === "PASS") && plan !== null;
    const r: CanaryReview = {
      record: i.record,
      plan,
      planHash,
      checks,
      report: { checks: report, now: i.now },
      ready,
      simulation,
      attestation: planHash
        ? this.deps.attestor.attest(
            "PREFLIGHT",
            i.record,
            planHash,
            report,
            i.now,
          )
        : null,
      guardianAttestation:
        planHash && g
          ? this.deps.attestor.attest("GUARDIAN", i.record, planHash, g, i.now)
          : null,
      checksAttestation: planHash
        ? this.deps.attestor.attest(
            "CANARY_CHECKS",
            i.record,
            planHash,
            checks,
            i.now,
          )
        : null,
      guardian: g ? { level: g.level, digest: g.digest } : null,
      needsApproval,
    };
    this.#reviews.set(i.record, r);
    const passed = (id: string) =>
      checks.some((c) => c.id === id && c.status === "PASS");
    this.#facts.set(i.record, {
      planHash,
      // B1 provenance (reviews 1 F8, 2 G4): only the very object the protected routing adapter returned from its
      // real upstream read counts; the predicate is imported, not injected.
      quoteFromAdapter: !!i.quote && isCanaryQuote(i.quote),
      pins: {
        set: CANARY_PINS.set,
        runtimeHash: i.pins[0]?.diamondCodehash ?? null,
        implementationHash: i.pins[0]?.facetCodehash ?? null,
        block: i.pins[0]?.block?.number ?? null,
        // When the evidence was true on chain: the review block's own time, not the caller's clock (review 2 G5).
        observedAt:
          rb && Number.isSafeInteger(rb.timestamp)
            ? rb.timestamp! * 1000
            : null,
        twoOperatorsAgree:
          passed("PINS") &&
          passed("PINS_AGREEMENT") &&
          passed("PINS_AT_REVIEW_BLOCK"),
      },
      wallet: i.wallet.proven
        ? { account: i.wallet.account, chainId: i.wallet.chainId }
        : { account: null, chainId: null },
      // Proven only with a configured pool (B4): pins and balances each from two different configured operators.
      operatorsConfigured: this.deps.pool
        ? pinAgreement.status === "AGREE" && bal.status === "AGREE"
        : null,
      approveGasLimit:
        needsApproval && gasUsed.length === 2 && gasUsed[0] > 0n
          ? (
              (gasUsed[0] * BigInt(10_000 + EXECUTION_POLICY.gasMarginBps)) /
              10_000n
            ).toString()
          : null,
      maxFeePerGas: feesOk ? i.fees!.maxFeePerGas : null,
      maxPriorityFeePerGas: feesOk ? i.fees!.maxPriorityFeePerGas : null,
      l1FeeWei:
        typeof i.l1FeeWei === "string" && DIGITS.test(i.l1FeeWei)
          ? i.l1FeeWei
          : null,
    });
    return r;
  }
  #plan(
    i: CanaryReviewInput,
    effectiveOutput: bigint,
    feeTotal: bigint | null,
    needsApproval: boolean,
    gas: string,
  ): ExecutionPlan {
    const tx = i.quote!.transactionRequest!;
    const transaction: WalletTransaction = {
      chainId: CANARY_SCOPE.sourceChainId,
      from: i.owner,
      to: CANARY_PINS.diamond.address,
      value: "0",
      data: tx.data,
      gas,
    };
    const fees: FeeLine[] =
      feeTotal !== null && feeTotal > 0n
        ? [
            {
              name: "LI.FI fee (decoded from calldata)",
              amount: feeTotal.toString(),
              usd: null,
              included: true,
              kind: "fee",
              asset: usd6,
            },
          ]
        : [];
    return {
      version: EXECUTION_POLICY.version,
      kind: "EVM_BRIDGE",
      provider: "lifi",
      tool: CANARY_SCOPE.tool,
      quoteId: `canary-${i.record}-${i.quote!.quotedAt}`,
      quotedAt: i.quote!.quotedAt,
      expiresAt: i.quote!.quotedAt + EXECUTION_POLICY.maxQuoteAgeMs,
      executable: true,
      account: i.owner,
      sourceChainId: CANARY_SCOPE.sourceChainId,
      destinationChainId: CANARY_SCOPE.destinationChainId,
      pay: { ...CANARY_SCOPE.pay },
      receive: { ...CANARY_SCOPE.receive },
      amountIn: i.amountIn,
      expectedOut: effectiveOutput.toString(),
      minimumOut: i.minimumOut,
      recipient: i.owner,
      refundTo: null,
      slippageBps: 0,
      platformFeeBps: 0,
      fees,
      spender: CANARY_PINS.diamond.address,
      approval: needsApproval
        ? {
            token: CANARY_PINS.usdc["8453"].address,
            spender: CANARY_PINS.diamond.address,
            amount: i.amountIn,
          }
        : null,
      transaction,
    };
  }
  /** Applies one event: computes the next record, anchors it (sink first), and only then commits it (review F10). */
  #apply(id: string, e: ExecutionEvent) {
    const r = this.#records.get(id) ?? newRecord(id);
    const next = apply(r, e);
    const entry = this.deps.anchors.next(next, e.at);
    this.deps.anchors.commit(entry);
    this.deps.events?.(id, e);
    this.#records.set(id, next);
    return next;
  }
  #active(owner: string, except: string) {
    for (const [id, r] of this.#records)
      if (
        id !== except &&
        lower(r.plan?.account) === lower(owner) &&
        !TERMINAL.has(r.state)
      )
        return true;
    return false;
  }
  /** Records the reviewed plan; every step only with THIS server's attestations of THIS plan. */
  start(record: string, at: number): ExecutionRecord {
    const r = this.#reviews.get(record);
    if (
      !r ||
      !r.plan ||
      !r.planHash ||
      !r.attestation ||
      !r.guardianAttestation ||
      !r.checksAttestation
    )
      throw new CanaryError("NO_ATTESTED_REVIEW");
    if (!r.ready) throw new CanaryError("REVIEW_NOT_READY");
    const phaseProblem = this.#phaseProblem(
      r.plan.account,
      r.plan.approval !== null,
    );
    if (phaseProblem) throw new CanaryError(phaseProblem);
    if (this.#active(r.plan.account, record))
      throw new CanaryError("ANOTHER_CANARY_ACTIVE");
    // A new record, or this record re-quoted after its exact approval was confirmed (round-2 review N1).
    const existing = this.#records.get(record) ?? null;
    if (existing && existing.state !== "APPROVAL_CONFIRMED")
      throw new CanaryError("RECORD_EXISTS");
    if (!r.guardian) throw new CanaryError("NO_ATTESTED_REVIEW");
    const level = r.guardian.level;
    const gd = r.guardian.digest;
    if (
      !this.deps.attestor.verify(
        r.attestation,
        "PREFLIGHT",
        record,
        r.planHash,
        r.report.checks,
      ) ||
      !this.deps.attestor.verify(
        r.checksAttestation,
        "CANARY_CHECKS",
        record,
        r.planHash,
        r.checks,
      ) ||
      !this.deps.attestor.verify(
        r.guardianAttestation,
        "GUARDIAN",
        record,
        r.planHash,
        { level, digest: gd },
      )
    )
      throw new CanaryError("ATTESTATION_INVALID");
    // The whole start sequence is validated on a copy first, so a refusal leaves no half-started record behind.
    const events: ExecutionEvent[] = [];
    const failed = r.report.checks
      .filter((c) => c.status !== "PASS")
      .map((c) => c.id);
    const pd = preflightDigest(r.planHash, r.report.checks, r.report.now);
    events.push({ type: "QUOTE_READ", at, plan: r.plan });
    events.push({
      type: "PREFLIGHT",
      at,
      plan: r.planHash,
      ready: failed.length === 0,
      failed,
      digest: pd,
      report: r.report,
    });
    events.push({
      type: "GUARDIAN",
      at,
      plan: r.planHash,
      level,
      digest: gd,
      quoteId: r.plan.quoteId,
    });
    events.push({
      type: "REVIEW_SHOWN",
      at,
      review: reviewDigest(r.planHash, gd, pd),
    });
    let dry = existing ?? newRecord(record);
    for (const e of events) dry = apply(dry, e);
    this.deps.anchors.next(dry, at);
    let out = existing ?? newRecord(record);
    for (const e of events) out = this.#apply(record, e);
    return out;
  }
  /** A server token for the owner's next wallet step — only while the execution gate is OPEN. */
  authorize(
    record: string,
    i: { now: number; trustedGesture: boolean },
  ): AuthorizationToken {
    const gate = this.deps.gate(this.stepFacts(record, i.now));
    if (!gate.open) throw new CanaryError("GATE_CLOSED");
    const r = this.#records.get(record);
    if (!r || r.state !== "REVIEWED" || !r.plan || !r.review)
      throw new CanaryError("NOT_REVIEWED");
    const action = r.plan.approval && !r.hashes.approval ? "APPROVE" : "SEND";
    const phaseProblem = this.#phaseProblem(
      r.plan.account,
      action === "APPROVE",
    );
    if (phaseProblem) throw new CanaryError(phaseProblem);
    return this.deps.authorizations.issue({
      action,
      review: r.review,
      record,
      account: r.plan.account,
      chainId: r.plan.sourceChainId,
      now: i.now,
      quoteExpiresAt: r.plan.expiresAt,
      // The token ends when the lifecycle would refuse the step anyway (round-4 P1); issuance itself is checked
      // against the plan's expiry only (round-5 W1).
      notAfter: r.plan.expiresAt - EXECUTION_POLICY.minRemainingMs,
      trustedGesture: i.trustedGesture,
    });
  }
  /** Consumes the token and returns the exact transaction for the owner's wallet — only while the gate is OPEN. */
  prepare(record: string, token: unknown, now: number): WalletTransaction {
    const gate = this.deps.gate(this.stepFacts(record, now));
    if (!gate.open) throw new CanaryError("GATE_CLOSED");
    const r = this.#records.get(record);
    if (!r || !r.plan || !r.review || r.state !== "REVIEWED")
      throw new CanaryError("NOT_REVIEWED");
    const action = r.plan.approval && !r.hashes.approval ? "APPROVE" : "SEND";
    const phaseProblem = this.#phaseProblem(
      r.plan.account,
      action === "APPROVE",
    );
    if (phaseProblem) throw new CanaryError(phaseProblem);
    // Round-4 review P1: everything that could still refuse is checked BEFORE the token or the canary is spent.
    if (r.plan.expiresAt - now < EXECUTION_POLICY.minRemainingMs)
      throw new CanaryError("QUOTE_TOO_CLOSE_TO_EXPIRY");
    const lastAnchor = this.deps.anchors.entries().at(-1);
    if (lastAnchor && now < lastAnchor.at)
      throw new CanaryError("ANCHOR_CLOCK_WENT_BACK");
    // The wallet request is fixed HERE, from the facts the gate has just judged (review 2 G3); when those facts do
    // not exist (a wiring without reviewed gas / fees) there is simply no snapshot and walletRequest() refuses.
    let request: CanaryWalletRequest | null = null;
    try {
      request = this.#walletRequestOf(record, action);
    } catch {
      request = null;
    }
    const authorization = this.deps.authorizations.consume(token, {
      action,
      review: r.review,
      record,
      account: r.plan.account,
      chainId: r.plan.sourceChainId,
      now,
    });
    const next = this.#apply(record, {
      type: "OWNER_AUTHORIZED",
      at: now,
      authorization,
    });
    // Single use (F3 / M1): the authorized wallet step is journaled durably before the transaction is handed out
    // (and only once the step is recorded: a refused step spends neither the canary nor a journal line).
    this.deps.uses.append(
      `${this.#useKey(r.plan.account)}:${record}:${action}`,
    );
    if (request)
      this.#prepared.set(record, { nonce: authorization.nonce, request });
    else this.#prepared.delete(record);
    const p = next.plan!;
    if (action === "APPROVE")
      return approvalTransaction(p) as WalletTransaction;
    return p.transaction!;
  }
  /** Source-chain observations only; review steps and settlement conclusions are refused here (review F9). */
  observe(record: string, e: ExecutionEvent): ExecutionRecord {
    if (!this.#records.has(record)) throw new CanaryError("UNKNOWN_RECORD");
    if (
      [
        "QUOTE_READ",
        "PREFLIGHT",
        "GUARDIAN",
        "REVIEW_SHOWN",
        "OWNER_AUTHORIZED",
      ].includes(e.type)
    )
      throw new CanaryError("REVIEW_STEPS_ARE_SERVER_ONLY");
    if (e.type === "DESTINATION" || e.type === "RECONCILED")
      throw new CanaryError("SETTLEMENT_ONLY_FROM_SERVER_READS");
    return this.#apply(record, e);
  }
  /** Destination settlement from logs the server read itself (source receipt, Arbitrum pool + USDC, Base refunds). */
  settle(
    record: string,
    i: {
      sourceLogs: readonly ChainLog[];
      destinationLogs: readonly ChainLog[];
      sourceRefundLogs: readonly ChainLog[];
      destinationPins: DestinationPinReads | null;
      nowSec: number;
      at: number;
    },
  ): { record: ExecutionRecord; settlement: Settlement } {
    const r = this.#records.get(record);
    if (!r || !r.plan || !r.hashes.main)
      throw new CanaryError("NO_MAIN_TRANSACTION");
    if (r.state === "SETTLED" || r.state === "RECONCILED")
      throw new CanaryError("ALREADY_SETTLED");
    // Re-derived from the CURRENT main hash's receipt every time (a reorg may re-include it elsewhere, round-2 N3).
    const deposit = depositFromSourceLogs(
      i.sourceLogs,
      r.hashes.main,
      r.plan.account,
      r.plan.minimumOut,
    );
    if (!deposit) throw new CanaryError("DEPOSIT_NOT_FOUND_IN_SOURCE_RECEIPT");
    const s = destinationSettlement({
      deposit,
      destinationLogs: i.destinationLogs,
      sourceRefundLogs: i.sourceRefundLogs,
      destinationPins: i.destinationPins,
      nowSec: i.nowSec,
    });
    // Only a definitive mismatch ends the record; an unreadable or changed destination pin is retried (round-2 N2).
    const definitive = [
      "MULTIPLE_MATCHING_FILLS",
      "DEPOSIT_NOT_THE_REVIEWED_RELAY",
    ];
    if (s.status === "DISCREPANCY" && !definitive.includes(s.code))
      return { record: r, settlement: s };
    // G14 closure (refund identity): a USDC transfer from the Base pool to the owner after the deadline is a refund
    // CANDIDATE only. Across pays refunds in bundles (relayer refund leaves) that the logs read here do not tie to
    // this deposit id, so another transfer to the owner could look the same: without that proof the record never
    // becomes REFUNDED and never counts as completed — it stays REFUND_PENDING, which needs the owner's attention.
    const status =
      s.status === "DELIVERED"
        ? "DELIVERED"
        : s.status === "REFUNDED" || s.status === "REFUND_PENDING"
          ? "REFUND_PENDING"
          : s.status === "PENDING"
            ? "PENDING"
            : "FAILED";
    if (
      status === r.state.replace("DESTINATION_", "") ||
      (status === "PENDING" && r.state === "DESTINATION_PENDING")
    )
      return { record: r, settlement: s };
    const next = this.#apply(record, {
      type: "DESTINATION",
      at: i.at,
      status,
      ...(status === "DELIVERED" && s.hash ? { hash: s.hash } : {}),
      ...(status === "DELIVERED" && s.delivered ? { amount: s.delivered } : {}),
    } as ExecutionEvent);
    return { record: next, settlement: s };
  }
  /** Final reconciliation from two agreeing sources per balance (Base before/after, Arbitrum before/after). */
  reconcile(
    record: string,
    i: {
      baseBefore: [SourceRead | null, SourceRead | null];
      baseAfter: [SourceRead | null, SourceRead | null];
      arbBefore: [SourceRead | null, SourceRead | null];
      arbAfter: [SourceRead | null, SourceRead | null];
      at: number;
    },
  ): { record: ExecutionRecord; check: CanaryCheck } {
    const r = this.#records.get(record);
    if (!r || !r.plan) throw new CanaryError("UNKNOWN_RECORD");
    const val = (pair: [SourceRead | null, SourceRead | null], chain: string) =>
      this.#agree(pair[0], pair[1], ["usdc"], chain).values?.usdc ?? null;
    const delivered = r.state === "SETTLED" ? r.delivered : null;
    const refunded = r.state === "REFUNDED" ? (r.delivered ?? null) : null;
    const check = reconcileCanary({
      amountIn: r.plan.amountIn,
      delivered,
      refunded,
      minimumOut: r.plan.minimumOut,
      base: {
        before: val(i.baseBefore, "8453"),
        after: val(i.baseAfter, "8453"),
      },
      arbitrum: {
        before: val(i.arbBefore, "42161"),
        after: val(i.arbAfter, "42161"),
      },
    });
    if (check.status === "UNKNOWN" || r.state !== "SETTLED")
      return { record: r, check };
    return {
      record: this.#apply(record, {
        type: "RECONCILED",
        at: i.at,
        ok: check.status === "PASS",
        detail: check.code,
      }),
      check,
    };
  }
  record(id: string): ExecutionRecord | null {
    return this.#records.get(id) ?? null;
  }
}
