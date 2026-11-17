// V1.9 single wallet provider adapter. The EIP-1193 provider that Privy hands out for the ACTIVE external wallet
// never travels through the application: every surface talks to this adapter, which
//   - allows only the known read/connection methods (eth_accounts, eth_chainId, wallet_switchEthereumChain,
//     wallet_addEthereumChain from the internal trusted registry, and wallet_watchAsset for the canonical CROSS),
//   - refuses every signing method, raw broadcast and anything unknown,
//   - is bound to one session epoch and is revoked on any account/chain/disconnect change,
//   - performs the one financial call (send transaction) only through sendCanonicalTransaction(): the wallet
//     request must equal the canonical server transaction field by field, the live wallet identity is re-read,
//     and the frozen canonical values are what leaves the page.
import { BridgeError, CROSS } from "../../core/model";
import { parseChain, readWallet, requestOnce } from "./provider";
import { sha256, stringToHex } from "viem";
import {
  takeManualAuthority,
  reportManualResult,
} from "../../manual-wallet/client";
import {
  OWNER_CANARY_APPROVAL,
  approvalRecordProblems,
  canaryDispatchProblem,
  canaryExactPreparation,
  canaryPreparedText,
  canaryWalletRequestProblem,
  type CanaryAction,
  type CanaryDispatchLimits,
} from "../../security/canary-approval";

export interface Eip1193Like {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on?(event: string, fn: (value: unknown) => void): void;
  removeListener?(event: string, fn: (value: unknown) => void): void;
}

/** Methods this application may ever ask a wallet for (besides the single gated send in sendCanonicalTransaction). */
export const READ_METHODS = Object.freeze(["eth_accounts", "eth_chainId"]);
export const CONNECTION_METHODS = Object.freeze([
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
  "wallet_watchAsset",
]);
/** Never requested by Otherbridge (deny list documented for review; everything not allowlisted is refused anyway). */
export const FORBIDDEN_WALLET_METHODS = Object.freeze([
  "personal_sign",
  "eth_sign",
  "eth_signTypedData",
  "eth_signTypedData_v1",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
  "eth_signTransaction",
  "eth_sendRawTransaction",
  "wallet_sendCalls",
  "wallet_grantPermissions",
  "eth_requestAccounts",
]);

/** Field set compared between the canonical server transaction and the wallet request. */
export const CANONICAL_TX_FIELDS = Object.freeze([
  "chainId",
  "from",
  "to",
  "value",
  "data",
  "gas",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
] as const);
export type CanonicalField = (typeof CANONICAL_TX_FIELDS)[number];
export type WalletTxRequest = Partial<Record<CanonicalField, string>>;
/** Gates allowed to reach the financial call; each is the existing Otherbridge execution path for its scope. */
export type ExecutionGate =
  | "otherbridge-submission"
  | "g7-local-pilot"
  // G14 protected proposal B3: the owner-signed canary. The name alone opens nothing: sendCanonicalTransaction
  // additionally requires the protected owner record (src/security/canary-approval.ts) to cover the exact request.
  | "veined-owner-canary";

/**
 * Chains Otherbridge may ask a wallet to switch to or add. Parameters come only from this internal registry —
 * there is no user-supplied RPC URL anywhere in the wallet path.
 */
export const TRUSTED_CHAINS: Readonly<
  Record<
    number,
    {
      switchable: true;
      add?: {
        chainName: string;
        nativeCurrency: { name: string; symbol: string; decimals: 18 };
        rpcUrls: readonly string[];
        blockExplorerUrls: readonly string[];
      };
    }
  >
> = Object.freeze({
  612055: Object.freeze({
    switchable: true as const,
    add: Object.freeze({
      chainName: "ONEchain Mainnet",
      nativeCurrency: Object.freeze({
        name: "ONE",
        symbol: "ONE",
        decimals: 18 as const,
      }),
      rpcUrls: Object.freeze(["https://mainnet.crosstoken.io:22001"]),
      blockExplorerUrls: Object.freeze([
        "https://explorer.onechain.nexus/612055",
      ]),
    }),
  }),
  56: Object.freeze({ switchable: true as const }),
  31337: Object.freeze({ switchable: true as const }),
});

/**
 * G14 protected proposal B3: the canary's own chain registry — Base (8453) only, switch only. It is separate from
 * TRUSTED_CHAINS on purpose: the general switch/add surface (switchChain / addChain) refuses Base, and (G14 follow-up,
 * review 7 R7-1) so do the general execution gates of sendCanonicalTransaction — the submission gate and the local
 * pilot's gate reach a wallet only for a chain of TRUSTED_CHAINS (the pilot gate id itself is spelled only where the
 * G7 pilot safety scan expects it); only switchChain with the explicit canary context and the canary gate use this
 * registry. There is no `add` entry and no RPC URL: a wallet that does not know Base is not taught it.
 */
export const CANARY_TRUSTED_CHAINS: Readonly<
  Record<number, { switchable: true }>
> = Object.freeze({
  8453: Object.freeze({ switchable: true as const }),
});
export const CANARY_SOURCE_CHAIN = 8453;

const HEX_QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Field-by-field comparison: identical key sets, identical string values. Returns the differing fields. */
export function compareCanonicalTx(
  canonical: WalletTxRequest,
  request: WalletTxRequest,
): string[] {
  const differences: string[] = [];
  const keys = new Set([...Object.keys(canonical), ...Object.keys(request)]);
  for (const key of keys) {
    if (!(CANONICAL_TX_FIELDS as readonly string[]).includes(key)) {
      differences.push(`unexpected:${key}`);
      continue;
    }
    const a = canonical[key as CanonicalField];
    const b = request[key as CanonicalField];
    if (typeof a !== "string" || typeof b !== "string" || a !== b)
      differences.push(key);
  }
  for (const required of ["chainId", "from", "to", "value", "data"] as const)
    if (typeof canonical[required] !== "string")
      differences.push(`missing:${required}`);
  return [...new Set(differences)];
}

/**
 * Own enumerable fields of a plain object, copied once into a frozen prototype-less snapshot. Everything after
 * this point (comparison, validation, the wallet request) uses only the snapshots, so a caller cannot change what
 * is sent after it was compared, and inherited (prototype) fields never take part.
 */
function snapshotTx(value: unknown): Readonly<WalletTxRequest> {
  const proto =
    value && typeof value === "object"
      ? Object.getPrototypeOf(value)
      : undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (proto !== Object.prototype && proto !== null)
  )
    throw new BridgeError("CANONICAL_TX_MISMATCH");
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value))
    copy[key] = (value as Record<string, unknown>)[key];
  return Object.freeze(copy) as Readonly<WalletTxRequest>;
}
/** Wallets with a financial request in flight, or whose last request ended without a definitive answer. */
const inFlight = new WeakSet<object>();
const uncertain = new WeakSet<object>();
/** Errors THIS adapter threw before asking the wallet (a wallet cannot forge membership), review 1 F11. */
const refusals = new WeakSet<object>();
/** True only for a refusal the adapter itself made before any wallet request. */
export function refusedBeforeWallet(error: unknown): boolean {
  return typeof error === "object" && error !== null && refusals.has(error);
}
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * G14 closure (PP1-AUDIT-01) + follow-up F2 (R3): what the canary gate needs besides its name. `authority` is the
 * opaque, single-use DISPATCH AUTHORITY that obtainCanaryDispatchAuthority() (below) minted from the SERVER's own
 * confirmed preparation and the server's committed durable REQUESTED record of this one step. Limits a caller builds
 * or copies (with a recomputed digest, or not) are never accepted: a context naming `limits` is refused.
 */
export interface CanaryDispatchContext {
  authority: CanaryDispatchAuthority;
  /** The latest time (ms) the caller has already seen in this flow: the adapter's clock never reads below it. */
  notBefore?: number;
  /**
   * Synchronous veto of the caller (the review this step belongs to is no longer the current one: another account,
   * network, quote or session). It can only refuse: anything but `true` stops the request.
   */
  current?: () => boolean;
}
/** A wall clock more than this far behind the monotonic clock was set back or frozen: the monotonic time is used. */
export const CLOCK_SETBACK_TOLERANCE_MS = 1_000;
const monotonic = () =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : null;
/**
 * The time of ONE financial request. It starts at the wall clock and never runs backwards: every reading is at least
 * the previous one and at least `floor`; and when the wall clock falls more than CLOCK_SETBACK_TOLERANCE_MS behind
 * the monotonic clock (it was set back, or it stands still while time passes), the monotonic elapsed time counts.
 * So a clock that is set back while a request is in flight cannot bring an expired step back to life. Stated limit:
 * a set-back of less than the tolerance can stretch a step by at most that tolerance; without a monotonic clock
 * (no `performance`) only the "never backwards" rule applies.
 */
export function canaryRequestClock() {
  const wall0 = Date.now();
  const mono0 = monotonic();
  let last = wall0;
  return (floor?: number): number => {
    const wall = Date.now();
    const m = monotonic();
    const elapsed = mono0 !== null && m !== null ? wall0 + (m - mono0) : wall;
    const now = Math.max(
      wall,
      last,
      elapsed - wall > CLOCK_SETBACK_TOLERANCE_MS ? elapsed : wall,
      typeof floor === "number" && Number.isFinite(floor) ? floor : wall,
    );
    last = now;
    return now;
  };
}

function wellFormed(tx: WalletTxRequest) {
  return (
    ADDRESS.test(tx.from ?? "") &&
    ADDRESS.test(tx.to ?? "") &&
    /^0x(?:[0-9a-fA-F]{2})*$/.test(tx.data ?? "") &&
    HEX_QUANTITY.test(tx.chainId ?? "") &&
    HEX_QUANTITY.test(tx.value ?? "") &&
    (["gas", "maxFeePerGas", "maxPriorityFeePerGas"] as const).every(
      (k) => tx[k] === undefined || HEX_QUANTITY.test(tx[k]!),
    )
  );
}

/** A frozen copy of the caller's canary context: the authority object, the clock floor and the veto (read once). */
function snapshotCanaryContext(c: CanaryDispatchContext | undefined) {
  const raw = c as unknown as Record<string, unknown> | undefined;
  return Object.freeze({
    authority: raw?.authority,
    // G14 follow-up F2: limits handed in by a caller are evidence of nothing (they can be rebuilt and re-digested).
    limitsGiven:
      !!raw &&
      typeof raw === "object" &&
      Object.prototype.hasOwnProperty.call(raw, "limits"),
    notBefore: raw?.notBefore as number | undefined,
    current: raw?.current as (() => boolean) | undefined,
  });
}
/** The limits name the server's prepared digest of exactly this transaction (recomputed here, synchronously). */
function preparedDigestProblem(
  limits: unknown,
  tx: Readonly<WalletTxRequest>,
): string | null {
  const l = limits as CanaryDispatchLimits;
  try {
    const digest = sha256(
      stringToHex(
        canaryPreparedText({
          approvalId: l.approvalId,
          record: l.record,
          review: l.review,
          action: l.action,
          attempt: l.attempt,
          authorizationExpiresAt: l.authorizationExpiresAt,
          quoteExpiresAt: l.quoteExpiresAt,
          transaction: tx,
        }),
      ),
    ).slice(2);
    return digest === l.preparedDigest ? null : "DISPATCH_DIGEST_MISMATCH";
  } catch {
    return "DISPATCH_DIGEST_MISMATCH";
  }
}

export class WalletProviderAdapter {
  readonly #raw: Eip1193Like;
  readonly #address: string;
  readonly #epoch: number;
  #chainId: number | undefined;
  #revoked = false;
  #financialPending = false;
  constructor(
    raw: Eip1193Like,
    binding: { address: string; chainId: number | undefined; epoch: number },
  ) {
    if (!raw || typeof raw.request !== "function")
      throw new BridgeError("WALLET_UNAVAILABLE");
    if (!ADDRESS.test(binding.address)) throw new BridgeError("WALLET_NOT_EVM");
    this.#raw = raw;
    this.#address = binding.address;
    this.#chainId = binding.chainId;
    this.#epoch = binding.epoch;
  }
  get address() {
    return this.#address;
  }
  get epoch() {
    return this.#epoch;
  }
  get revoked() {
    return this.#revoked;
  }
  /** Called by the wallet layer on any account/chain/disconnect/session change. Irreversible. */
  revoke() {
    this.#revoked = true;
  }
  #live() {
    if (this.#revoked) throw new BridgeError("WALLET_SESSION_STALE");
  }
  /** Subscribes to provider events (wallet layer only). */
  on(
    event: "accountsChanged" | "chainChanged" | "disconnect",
    fn: (v: unknown) => void,
  ) {
    this.#raw.on?.(event, fn);
    return () => this.#raw.removeListener?.(event, fn);
  }
  read(
    method: "eth_accounts" | "eth_chainId",
    signal?: AbortSignal,
    timeout = 8000,
  ) {
    this.#live();
    if (!READ_METHODS.includes(method))
      throw new BridgeError("WALLET_METHOD_FORBIDDEN");
    return readWallet(this.#raw, method, signal, timeout);
  }
  /** Reads the live wallet identity; it must still be this session's account. */
  async identity(signal?: AbortSignal) {
    const [accounts, chain] = await Promise.all([
      this.read("eth_accounts", signal),
      this.read("eth_chainId", signal),
    ]);
    this.#live();
    const account =
      Array.isArray(accounts) && typeof accounts[0] === "string"
        ? accounts[0]
        : "";
    if (account.toLowerCase() !== this.#address.toLowerCase())
      throw new BridgeError("IDENTITY_CHANGED");
    return { account, chainId: parseChain(chain) };
  }
  /**
   * G14 B3: with the explicit canary context the switch is checked against the canary's own registry (Base only);
   * without it nothing changes — Base stays refused on the general surface. It is a separate, explicit owner action:
   * sendCanonicalTransaction never switches, and there is no add-chain fallback for the canary.
   */
  async switchChain(
    chainId: number,
    context?: { gate: "veined-owner-canary" },
  ) {
    this.#live();
    const registry =
      context?.gate === "veined-owner-canary"
        ? CANARY_TRUSTED_CHAINS
        : TRUSTED_CHAINS;
    // The canary context exists only with a well-formed owner record: with the disarmed constant no canary-context
    // request of any kind reaches a wallet (review 1 F9).
    if (
      !registry[chainId]?.switchable ||
      (context?.gate === "veined-owner-canary" &&
        approvalRecordProblems(OWNER_CANARY_APPROVAL).length > 0)
    )
      throw new BridgeError("WALLET_CHAIN_NOT_TRUSTED");
    await requestOnce(this.#raw, "wallet_switchEthereumChain", [
      { chainId: `0x${chainId.toString(16)}` },
    ]);
  }
  async addChain(chainId: number) {
    this.#live();
    const add = TRUSTED_CHAINS[chainId]?.add;
    if (!add) throw new BridgeError("WALLET_CHAIN_NOT_TRUSTED");
    await requestOnce(this.#raw, "wallet_addEthereumChain", [
      {
        chainId: `0x${chainId.toString(16)}`,
        chainName: add.chainName,
        nativeCurrency: { ...add.nativeCurrency },
        rpcUrls: [...add.rpcUrls],
        blockExplorerUrls: [...add.blockExplorerUrls],
      },
    ]);
  }
  /** Asks the wallet to display the canonical BSC CROSS token. Fixed parameters only. */
  async watchCanonicalCross() {
    this.#live();
    return requestOnce(this.#raw, "wallet_watchAsset", [
      {
        type: "ERC20",
        options: { address: CROSS, symbol: "CROSS", decimals: 18 },
      },
    ]);
  }
  /** Candidate manual scope: Base only; a separate owner gesture, never part of sending. */
  async switchManualBase() {
    this.#live();
    await requestOnce(this.#raw, "wallet_switchEthereumChain", [
      { chainId: "0x2105" },
    ]);
  }
  /** Server-claimed single-use authority. No caller-provided transaction or general execution gate. */
  async sendManualTransaction(authority: unknown): Promise<string> {
    const grant = takeManualAuthority(authority, this);
    const canonical = grant.preparation.transaction;
    this.#live();
    if (
      this.#financialPending ||
      inFlight.has(this.#raw) ||
      uncertain.has(this.#raw)
    )
      throw new BridgeError("WALLET_REQUEST_PENDING");
    this.#financialPending = true;
    inFlight.add(this.#raw);
    let asked = false;
    let hash: string | null = null;
    let outcome: "SENT" | "REFUSED" | "UNCERTAIN" = "UNCERTAIN";
    try {
      const live = await this.identity();
      if (
        live.chainId !== 8453 ||
        live.account.toLowerCase() !== canonical.from
      )
        throw new BridgeError("IDENTITY_CHANGED");
      this.#live();
      grant.check();
      // No await between the final session/time veto and the connected wallet's request.
      asked = true;
      const answer = await this.#raw.request({
        method: "eth_sendTransaction",
        params: Object.freeze([canonical]),
      });
      if (typeof answer !== "string" || !TX_HASH.test(answer))
        throw new BridgeError("WALLET_RESULT_UNKNOWN");
      hash = answer;
      outcome = "SENT";
      return answer;
    } catch (e) {
      if (!asked || (e as { code?: unknown })?.code === 4001)
        outcome = "REFUSED";
      else uncertain.add(this.#raw);
      throw e;
    } finally {
      try {
        await reportManualResult(grant, outcome, hash);
      } catch {
        uncertain.add(this.#raw);
        throw new BridgeError("WALLET_RESULT_REPORT_UNKNOWN");
      } finally {
        this.#financialPending = false;
        inFlight.delete(this.#raw);
      }
    }
  }
  /**
   * The accepted financial wallet call. `canonical` is the server-built transaction the user reviewed; `request` is the
   * object the caller intends to send. Both must match field by field; the account and chain must be this session's
   * and the live wallet's. The frozen canonical object is what the wallet receives.
   */
  async sendCanonicalTransaction(
    canonicalInput: WalletTxRequest,
    requestInput: WalletTxRequest,
    context: {
      gate: ExecutionGate;
      signal?: AbortSignal;
      /** Required for the gate "veined-owner-canary" (PP1-AUDIT-01); ignored by every other gate. */
      canary?: CanaryDispatchContext;
    },
  ): Promise<unknown> {
    // Every refusal below happens before the wallet is asked; callers can report it as such. The marked object is
    // always one THIS adapter created (G14 closure): an error object a wallet handed over is never registered, so a
    // wallet cannot later re-throw it from the financial request to pass as "refused before the wallet".
    const refused = (e: unknown) => {
      const own = e instanceof BridgeError && !refusals.has(e);
      const error = Object.assign(
        new BridgeError(own ? e.code : "PROVIDER_UNAVAILABLE"),
        own
          ? {
              ...("reason" in e ? { reason: e.reason } : {}),
              ...("differences" in e ? { differences: e.differences } : {}),
            }
          : {},
        { beforeWalletRequest: true as const },
      );
      refusals.add(error);
      return error;
    };
    const clock = canaryRequestClock();
    const canary = context.gate === "veined-owner-canary";
    // Review 1 F4: the caller's canary context is copied ONCE, here; both checks use the copy.
    // G14 follow-up F2 (R3): the only limits ever checked are the ones of the dispatch AUTHORITY, minted by this
    // module from the server's own answers; it is taken out of the module's private registry here, before anything
    // else, so it is spent whatever happens next (a refusal, a wallet error or a hash).
    let cc: ReturnType<typeof snapshotCanaryContext> | null = null;
    let grant: DispatchGrant | null = null;
    let chainId: number;
    let canonical: Readonly<WalletTxRequest>;
    try {
      // Inside the refusal boundary: a context whose getter throws is a marked refusal, never an unmarked error.
      cc = canary ? snapshotCanaryContext(context.canary) : null;
      grant = canary ? takeGrant(cc?.authority) : null;
      this.#live();
      if (
        context.gate !== "otherbridge-submission" &&
        context.gate !== "g7-local-pilot" &&
        context.gate !== "veined-owner-canary"
      )
        throw new BridgeError("EXECUTION_GATE_REQUIRED");
      canonical = snapshotTx(canonicalInput);
      const request = snapshotTx(requestInput);
      const differences = compareCanonicalTx(canonical, request);
      if (differences.length || !wellFormed(canonical))
        throw Object.assign(new BridgeError("CANONICAL_TX_MISMATCH"), {
          differences,
        });
      if (canonical.from!.toLowerCase() !== this.#address.toLowerCase())
        throw new BridgeError("WALLET_ACCOUNT_MISMATCH");
      chainId = Number(BigInt(canonical.chainId!));
      if (this.#chainId !== undefined && this.#chainId !== chainId)
        throw new BridgeError("WALLET_CHAIN_MISMATCH");
      // G14 follow-up (review 7 R7-1): a general gate is bound to its own chain registry, so Base (the canary's chain)
      // is reachable ONLY through the canary gate and its server-minted authority.
      if (!canary && TRUSTED_CHAINS[chainId]?.switchable !== true)
        throw new BridgeError("WALLET_CHAIN_NOT_TRUSTED");
      // G14 B3: the canary gate reaches the wallet only for a request the protected owner record covers exactly
      // (Base, the record's account, approve(spender, exactAmount) or the pinned selector on the pinned target,
      // explicit gas / fee caps inside the budget, inside the validity window). The record is the module constant:
      // no caller can pass one. With the disarmed record this refuses every canary request before the wallet.
      // G14 closure (PP1-AUDIT-01): the same guard also needs the prepared step's limits already here, and all of
      // it is checked AGAIN after the last await below.
      if (canary) {
        const problem =
          CANARY_TRUSTED_CHAINS[chainId]?.switchable !== true
            ? "WRONG_CHAIN"
            : (canaryWalletRequestProblem(
                OWNER_CANARY_APPROVAL,
                canonical,
                clock(cc?.notBefore),
              ) ??
              grantProblem(grant, this, this.#epoch, cc, canonical) ??
              canaryDispatchProblem(
                OWNER_CANARY_APPROVAL,
                canonical,
                grant!.limits,
                clock(cc?.notBefore) + grant!.offsetMs,
              ) ??
              preparedDigestProblem(grant!.limits, canonical));
        if (problem)
          throw Object.assign(new BridgeError("CANARY_REQUEST_REFUSED"), {
            reason: problem,
          });
      }
      // One financial request per wallet (not per adapter epoch); an earlier request that ended without a
      // definitive answer (timeout, provider error) may still be open in the wallet: no second one.
      if (this.#financialPending || inFlight.has(this.#raw))
        throw new BridgeError("WALLET_REQUEST_PENDING");
      if (uncertain.has(this.#raw))
        throw new BridgeError("WALLET_REQUEST_UNCERTAIN");
    } catch (e) {
      throw refused(e);
    }
    this.#financialPending = true;
    inFlight.add(this.#raw);
    try {
      let params: Readonly<Record<string, string | undefined>>;
      try {
        const live = await this.identity(context.signal);
        if (live.chainId !== chainId)
          throw new BridgeError("WALLET_CHAIN_MISMATCH");
        params = Object.freeze(
          Object.fromEntries(
            CANONICAL_TX_FIELDS.filter((k) => canonical[k] !== undefined).map(
              (k) => [k, canonical[k]],
            ),
          ),
        );
        // THE LAST CHECK (G14 closure, PP1-AUDIT-01). The identity read above was the last await; it can take up to
        // its own timeout, and what was valid at entry may be dead by now. Everything that must still hold at the
        // instant of the request is re-checked HERE, synchronously, with the request's own never-backwards clock:
        // the session (account / network / disconnect revoke the adapter), the caller's abort signal, and for the
        // canary the owner record's window, the prepared step's authorization, the reviewed quote and the owner's
        // gesture, plus the caller's own "still the current review" veto. NOTHING is awaited between this block and
        // the wallet request below. What the wallet does with the request after it received it (how long it shows
        // it, what the owner edits in it) is outside the application's reach and is a separate, stated risk.
        this.#live();
        if (context.signal?.aborted) throw new BridgeError("IDENTITY_CHANGED");
        if (uncertain.has(this.#raw))
          throw new BridgeError("WALLET_REQUEST_UNCERTAIN");
        if (canary) {
          const veto = cc?.current;
          const problem =
            veto !== undefined &&
            (typeof veto !== "function" || veto() !== true)
              ? "REVIEW_NO_LONGER_CURRENT"
              : (canaryDispatchProblem(
                  OWNER_CANARY_APPROVAL,
                  canonical,
                  grant!.limits,
                  clock(cc?.notBefore) + grant!.offsetMs,
                ) ?? preparedDigestProblem(grant!.limits, canonical));
          if (problem)
            throw Object.assign(new BridgeError("CANARY_REQUEST_REFUSED"), {
              reason: problem,
            });
        }
      } catch (e) {
        throw refused(e);
      }
      try {
        const answer = await this.#raw.request({
          method: "eth_sendTransaction",
          params: Object.freeze([params]),
        });
        // G14 B3 (review 1 F1): under the canary gate an answer that is not a transaction hash is not a definitive
        // answer either — the wallet stays blocked for every further financial request.
        if (
          context.gate === "veined-owner-canary" &&
          !(typeof answer === "string" && TX_HASH.test(answer))
        )
          uncertain.add(this.#raw);
        return answer;
      } catch (e) {
        // G14 closure: whatever the wallet throws from the financial request is never "refused before the wallet" —
        // even an object this adapter once marked as such (a wallet or page that re-throws it cannot clear the
        // uncertainty). It is an unclear answer: the wallet stays blocked.
        if (typeof e === "object" && e !== null && refusals.has(e)) {
          uncertain.add(this.#raw);
          throw new BridgeError("WALLET_ANSWER_INVALID");
        }
        // A user rejection (4001) is definitive; anything else may still be pending in the wallet.
        if ((e as { code?: unknown })?.code !== 4001) uncertain.add(this.#raw);
        throw e;
      }
    } finally {
      this.#financialPending = false;
      inFlight.delete(this.#raw);
    }
  }
}

// ---------------------------------------------------------------------------------------------- dispatch authority
// G14 follow-up F2 (independent review R3 / review 6 line 69): a hash that any caller can recompute is not authority.
// The canary gate of sendCanonicalTransaction accepts ONLY an opaque object that THIS module minted, once, after it
// itself (never a caller-supplied callback) asked the server
//   1. canary-confirm: the server's OWN preparation of exactly this attempt (record, action, review, attempt, digest),
//      checked field by field and digested again here, bound to the owner record's approval and this wallet's account;
//   2. canary-record "requested": the server's DURABLE, single-use REQUESTED commit of exactly this attempt and write.
// The limits the authority carries are the server's (its authorization and quote ends, judged in the SERVER's time:
// the confirmation states the server's clock), plus the owner's gesture fixed at minting. The object has no fields;
// its meaning lives only in this module's private registry. It is spent at the first send (or discarded): a copy,
// clone, serialisation, a second use, another adapter or identity epoch, another transaction, a page reload or a
// module re-evaluation finds nothing and is refused before the wallet.
// Threat model, stated (G14 follow-up, corrected after review 7 R7-1). WHAT THIS BINDS: every code path of this
// repository. Dynamically, the canary gate refuses anything but an authority minted here from the module's own server
// answers (limits built, copied, re-digested or stretched by a caller, a copied / cloned / serialised / spent authority,
// another adapter, epoch or transaction, a module re-evaluation, a fetch replaced after load: all refused before the
// wallet); the general gates reach only the chains of TRUSTED_CHAINS (never Base). Statically, scripts/verify-safety.mjs
// allows exactly one financial wallet call (here) and exactly one caller of it (src/features/bridge/submission.ts), and
// pins the authority checks. WHAT THIS DOES NOT BIND: hostile script running in the same page realm. Such code can
// replace built-ins this module relies on after it was loaded (WeakMap / Response / Promise prototypes), call the
// page's EIP-1193 provider directly, call the server API itself with the page's session (for example clean up its own
// write after the authority was minted), or run before this module (a replaced fetch, a malicious service worker or
// extension, a compromised origin or server). No in-page check can bound that; it is out of scope by design. The
// gesture's `trusted` flag is the browser's own event flag as reported by page code (no cryptographic proof of a human
// click exists). The owner's wallet confirmation remains the final gate in every case.
/** Where the server's canary API lives: a fixed same-origin path, never a caller value. */
export const CANARY_API_PATH = "/api/execution";
/** The page's fetch as it was when THIS module was evaluated; a later replacement of globalThis.fetch is not used. */
const PAGE_FETCH: typeof fetch | null =
  typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : null;
/** How long one server call of the authority may take (then its outcome is not known). */
export const CANARY_SERVER_WAIT_MS = 10_000;
/** A server / page clock difference beyond this is refused (the server's limits are seconds to minutes). */
export const CANARY_MAX_CLOCK_OFFSET_MS = 300_000;
/** The opaque, single-use dispatch authority (an empty frozen object; its meaning is in the private registry). */
export type CanaryDispatchAuthority = object;
interface DispatchGrant {
  adapter: WalletProviderAdapter;
  epoch: number;
  limits: Readonly<CanaryDispatchLimits>;
  transaction: Readonly<WalletTxRequest>;
  /** serverNow - (page time when the confirmation was asked): adding it never under-states the server's time. */
  offsetMs: number;
}
const grants = new WeakMap<object, DispatchGrant>();
/** Takes an authority out of the registry (spent from here on); null when it is not one this module minted. */
function takeGrant(authority: unknown): DispatchGrant | null {
  if (!authority || typeof authority !== "object") return null;
  const g = grants.get(authority) ?? null;
  grants.delete(authority);
  return g;
}
function grantProblem(
  g: DispatchGrant | null,
  adapter: WalletProviderAdapter,
  epoch: number,
  cc: ReturnType<typeof snapshotCanaryContext> | null,
  canonical: Readonly<WalletTxRequest>,
): string | null {
  if (cc?.limitsGiven) return "DISPATCH_LIMITS_FROM_CALLER";
  if (!g) return "DISPATCH_AUTHORITY_REQUIRED";
  if (g.adapter !== adapter || g.epoch !== epoch)
    return "DISPATCH_AUTHORITY_OTHER_WALLET";
  if (compareCanonicalTx(g.transaction, canonical).length > 0)
    return "DISPATCH_TRANSACTION_MISMATCH";
  return null;
}
/** Forgets an authority that will not be used (the caller then asks the server to cancel its REQUESTED record). */
export function discardCanaryDispatchAuthority(authority: unknown): void {
  if (authority && typeof authority === "object") grants.delete(authority);
}
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,39}$/;
const plainRecord = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v) as object | null);
/** One bounded same-origin POST of the canary API through the module's own fetch. Null = no usable answer in time. */
async function canaryServer(
  body: unknown,
  signal?: AbortSignal,
): Promise<{ status: number; json: unknown } | null> {
  if (!PAGE_FETCH) return null;
  const pageFetch = PAGE_FETCH;
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const r = await pageFetch(CANARY_API_PATH, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          credentials: "same-origin",
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
        });
        const json = (r.headers.get("content-type") ?? "").startsWith(
          "application/json",
        )
          ? ((await r.json()) as unknown)
          : null;
        return { status: r.status, json };
      })().catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, CANARY_SERVER_WAIT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}
const preparationDigest = (
  p: NonNullable<ReturnType<typeof canaryExactPreparation>>,
) =>
  sha256(
    stringToHex(
      canaryPreparedText({
        approvalId: p.approvalId,
        record: p.record,
        review: p.review,
        action: p.action,
        attempt: p.attempt,
        authorizationExpiresAt: p.expiresAt,
        quoteExpiresAt: p.quoteExpiresAt,
        transaction: p.transaction,
      }),
    ),
  ).slice(2);
/**
 * What obtaining an authority ended with. `written` says what is known about the server's durable REQUESTED record of
 * this write when no authority was minted: false = definitely not written; "UNKNOWN" = it may have been committed
 * (H3: the caller must ask for the server's conditional clean-up and treat the step as uncertain until confirmed).
 */
export type CanaryAuthorityResult =
  | { ok: true; authority: CanaryDispatchAuthority }
  | { ok: false; written: false | "UNKNOWN"; code: string };
/** The opaque, single-use ticket of a server CONFIRMATION (phase 1); like the authority, it has no fields. */
export type CanaryConfirmation = object;
interface Confirmed {
  adapter: WalletProviderAdapter;
  epoch: number;
  session: string;
  prep: NonNullable<ReturnType<typeof canaryExactPreparation>>;
  offsetMs: number;
}
const confirmations = new WeakMap<object, Confirmed>();
type Refusal = { ok: false; written: false | "UNKNOWN"; code: string };
const no = (code: string, written: false | "UNKNOWN" = false): Refusal => ({
  ok: false,
  written,
  code,
});
/**
 * PHASE 1 — the server's own preparation of exactly this attempt (read only on the server; nothing is written by it),
 * asked by THIS module through its own fetch. With the disarmed owner record it refuses before any request (no
 * network call at all). The answer is checked field by field, digested again here, bound to the owner record's
 * approval and to this wallet's account; the server's clock is taken from it. Returns an opaque single-use ticket.
 */
export async function confirmCanaryPreparation(
  adapter: WalletProviderAdapter,
  input: {
    session: string;
    /** The review digest the server prepared this step under. */
    review: string;
    ref: {
      record: string;
      action: CanaryAction;
      attempt: string;
      digest: string;
    };
    signal?: AbortSignal;
  },
): Promise<
  { ok: true; confirmation: CanaryConfirmation; offsetMs: number } | Refusal
> {
  const owner = OWNER_CANARY_APPROVAL;
  const structural = approvalRecordProblems(owner);
  if (structural.length || !owner)
    return no(structural[0] ?? "NO_OWNER_APPROVED_CANARY");
  if (!(adapter instanceof WalletProviderAdapter) || adapter.revoked)
    return no("NOT_THE_LIVE_WALLET_ADAPTER");
  const i = input as unknown;
  if (!plainRecord(i) || !plainRecord(i.ref))
    return no("AUTHORITY_INPUT_MALFORMED");
  const r = i.ref;
  if (
    typeof i.session !== "string" ||
    !HEX64.test(i.session) ||
    typeof i.review !== "string" ||
    !HEX64.test(i.review) ||
    typeof r.record !== "string" ||
    !/^[A-Za-z0-9._-]{1,80}$/.test(r.record) ||
    (r.action !== "APPROVE" && r.action !== "SEND") ||
    typeof r.attempt !== "string" ||
    !HEX32.test(r.attempt) ||
    typeof r.digest !== "string" ||
    !HEX64.test(r.digest)
  )
    return no("AUTHORITY_INPUT_MALFORMED");
  const session = i.session;
  const review = i.review;
  const ref = Object.freeze({
    record: r.record,
    action: r.action as CanaryAction,
    attempt: r.attempt,
    digest: r.digest,
  });
  if (!PAGE_FETCH) return no("PAGE_FETCH_UNAVAILABLE");
  const askedAt = Date.now();
  const c = await canaryServer(
    {
      action: "canary-confirm",
      session,
      record: ref.record,
      step: ref.action,
      review,
      attempt: ref.attempt,
      digest: ref.digest,
    },
    input.signal,
  );
  const body = c && c.status === 200 && plainRecord(c.json) ? c.json : null;
  const prep =
    body &&
    Object.keys(body).length === 2 &&
    Object.prototype.hasOwnProperty.call(body, "serverNow")
      ? canaryExactPreparation(body.preparation)
      : null;
  if (!body || !prep) {
    const e = c && plainRecord(c.json) ? c.json.error : null;
    return no(
      typeof e === "string" && CODE.test(e) ? e : "PREPARATION_NOT_CONFIRMED",
    );
  }
  if (
    prep.record !== ref.record ||
    prep.action !== ref.action ||
    prep.review !== review ||
    prep.attempt !== ref.attempt ||
    prep.digest !== ref.digest
  )
    return no("PREPARATION_MISMATCH");
  if (prep.approvalId !== owner.approvalId)
    return no("PREPARATION_APPROVAL_MISMATCH");
  if (preparationDigest(prep) !== prep.digest)
    return no("PREPARATION_DIGEST_MISMATCH");
  if (prep.transaction.from.toLowerCase() !== adapter.address.toLowerCase())
    return no("WALLET_ACCOUNT_MISMATCH");
  const serverNow = body.serverNow;
  if (!Number.isSafeInteger(serverNow)) return no("PREPARATION_NOT_CONFIRMED");
  const offsetMs = (serverNow as number) - askedAt;
  if (Math.abs(offsetMs) > CANARY_MAX_CLOCK_OFFSET_MS)
    return no("CLOCK_OFFSET_TOO_LARGE");
  const confirmation: CanaryConfirmation = Object.freeze(
    Object.create(null) as object,
  );
  confirmations.set(
    confirmation,
    Object.freeze({ adapter, epoch: adapter.epoch, session, prep, offsetMs }),
  );
  return { ok: true, confirmation, offsetMs };
}
/** Forgets a confirmation that will not be committed (nothing was written for it). */
export function discardCanaryConfirmation(confirmation: unknown): void {
  if (confirmation && typeof confirmation === "object")
    confirmations.delete(confirmation);
}
/**
 * PHASE 2 — the server's durable, single-use REQUESTED commit of exactly the confirmed attempt and this write (`request`,
 * 16 random bytes chosen by the caller for its conditional clean-up), asked by THIS module; only its exact committed
 * answer mints the dispatch authority (limits = the server's, gesture fixed now). The confirmation is spent here.
 */
export async function commitCanaryDispatch(
  confirmation: CanaryConfirmation,
  input: {
    request: string;
    gesture: { trusted: boolean; at: number };
    signal?: AbortSignal;
  },
): Promise<CanaryAuthorityResult> {
  const c =
    confirmation && typeof confirmation === "object"
      ? (confirmations.get(confirmation) ?? null)
      : null;
  if (confirmation && typeof confirmation === "object")
    confirmations.delete(confirmation);
  if (!c) return no("CONFIRMATION_REQUIRED");
  const i = input as unknown;
  if (
    !plainRecord(i) ||
    typeof i.request !== "string" ||
    !HEX32.test(i.request) ||
    !plainRecord(i.gesture) ||
    typeof i.gesture.trusted !== "boolean" ||
    typeof i.gesture.at !== "number" ||
    !Number.isFinite(i.gesture.at)
  )
    return no("AUTHORITY_INPUT_MALFORMED");
  const owner = OWNER_CANARY_APPROVAL;
  if (approvalRecordProblems(owner).length || !owner)
    return no("NO_OWNER_APPROVED_CANARY");
  if (input.signal?.aborted || c.adapter.revoked || c.adapter.epoch !== c.epoch)
    return no("IDENTITY_CHANGED");
  const prep = c.prep;
  const gesture = Object.freeze({
    trusted: i.gesture.trusted,
    at: i.gesture.at,
  });
  const ref = Object.freeze({
    record: prep.record,
    action: prep.action,
    attempt: prep.attempt,
    digest: prep.digest,
    request: i.request,
  });
  const w = await canaryServer(
    { action: "canary-record", session: c.session, kind: "requested", ref },
    input.signal,
  );
  const ans = w && plainRecord(w.json) ? w.json : null;
  if (
    w?.status === 200 &&
    ans &&
    Object.keys(ans).length === 5 &&
    ans.ok === true &&
    ans.state === "REQUESTED" &&
    ans.attempt === ref.attempt &&
    ans.digest === ref.digest &&
    ans.request === ref.request
  ) {
    const limits: Readonly<CanaryDispatchLimits> = Object.freeze({
      approvalId: prep.approvalId,
      action: prep.action,
      record: prep.record,
      review: prep.review,
      attempt: prep.attempt,
      preparedDigest: prep.digest,
      authorizationExpiresAt: prep.expiresAt,
      quoteExpiresAt: prep.quoteExpiresAt,
      // In server time, like the limits (its age is the same in either clock).
      gesture: Object.freeze({
        trusted: gesture.trusted,
        at: gesture.at + c.offsetMs,
      }),
    });
    const authority: CanaryDispatchAuthority = Object.freeze(
      Object.create(null) as object,
    );
    grants.set(
      authority,
      Object.freeze({
        adapter: c.adapter,
        epoch: c.epoch,
        limits,
        transaction: snapshotTx({ ...prep.transaction }),
        offsetMs: c.offsetMs,
      }),
    );
    return { ok: true, authority };
  }
  // Definitively not written: an explicit refusal of the write, or a refusal the API makes before the store is
  // touched. Anything else (no answer, a time-out, a failed commit, an unknown error) leaves the outcome unknown.
  const code =
    ans && typeof ans.code === "string"
      ? ans.code
      : ans && typeof ans.error === "string"
        ? ans.error
        : null;
  const definitive =
    (w?.status === 200 && ans?.ok === false) ||
    w?.status === 403 ||
    w?.status === 429 ||
    (w?.status === 422 &&
      typeof code === "string" &&
      code !== "STORE_NEEDS_ATTENTION" &&
      code !== "PROVIDER_UNAVAILABLE");
  return definitive
    ? no(code && CODE.test(code) ? code : "RECORD_NOT_WRITTEN")
    : no("RECORD_OUTCOME_UNKNOWN", "UNKNOWN");
}
/** Both phases in one call (phase 1, then phase 2 with the same write id). */
export async function obtainCanaryDispatchAuthority(
  adapter: WalletProviderAdapter,
  input: {
    session: string;
    review: string;
    ref: {
      record: string;
      action: CanaryAction;
      attempt: string;
      digest: string;
      request: string;
    };
    gesture: { trusted: boolean; at: number };
    signal?: AbortSignal;
  },
): Promise<CanaryAuthorityResult> {
  const i = input as unknown;
  // Every input is checked before the first request (a malformed one asks the server nothing).
  if (
    !plainRecord(i) ||
    !plainRecord(i.ref) ||
    typeof i.ref.request !== "string" ||
    !HEX32.test(i.ref.request) ||
    !plainRecord(i.gesture) ||
    typeof i.gesture.trusted !== "boolean" ||
    typeof i.gesture.at !== "number" ||
    !Number.isFinite(i.gesture.at)
  )
    return no(
      approvalRecordProblems(OWNER_CANARY_APPROVAL)[0] ??
        "AUTHORITY_INPUT_MALFORMED",
    );
  const first = await confirmCanaryPreparation(adapter, {
    session: input.session,
    review: input.review,
    ref: {
      record: input.ref.record,
      action: input.ref.action,
      attempt: input.ref.attempt,
      digest: input.ref.digest,
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!first.ok) return first;
  return commitCanaryDispatch(first.confirmation, {
    request: input.ref.request,
    gesture: input.gesture,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}
