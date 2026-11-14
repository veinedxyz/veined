"use client";
// G7 controlled pilot inside the normal Otherbridge Bridge card (owner-approved, LOCAL ONLY). Loaded only through
// the gated dynamic import in src/components/product.tsx, which is constant-folded out of every normal build, and
// rendered only when the server-side gate (src/server/g7-local-pilot.ts) is open. Security work happens behind the
// normal product look: the launcher's one-shot session runs the fresh mainnet preflight, the page re-verifies the
// released transaction independently (./verify) and makes the single wallet request (./wallet-send) only after
// the owner's click, both checkboxes and the exact phrase. No key material, no signing method, no approval.
// V1.9: the wallet is the active Privy-connected external wallet, reached only through the session's adapter
// (bound to one session epoch; any account/chain/disconnect change revokes it before a request can be made).
import { useCallback, useEffect, useRef, useState } from "react";
import type { WalletProviderAdapter } from "../../../src/features/wallet/adapter";
import { trapDialog } from "../../../src/components/dialog";
import {
  EXPECT,
  exactTx,
  sameTx,
  units,
  verifyReview,
  type PilotReview,
} from "./verify";
import { requestWalletConfirmationOnce, sendAttempted } from "./wallet-send";
import styles from "./local-pilot.module.css";

export interface LocalPilotBridgeProps {
  gate: { apiBase: string; origin: string };
  wallet: WalletProviderAdapter | null;
  /** EIP-6963 rdns / Privy wallet id of the active session (identifies the test mock wallet in fixture mode). */
  walletId: string;
  account: string;
  chain: number | undefined;
  liveBalance: bigint | undefined;
  openWallet: () => void;
  switchToOneChain: () => void;
  addOneChain: () => void;
  t: (key: string) => string;
}
interface Gate {
  id: string;
  name: string;
  status: string;
  reasons: string[];
}
interface Summary {
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
    finalized: boolean;
  };
  pending: {
    status: string;
    pendingAmount: string;
    valuedActivePendingCross: number;
    inFlightCount: number;
    inFlightEnumerated: boolean;
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
  bscPin?: {
    block: number;
    ageSec: number;
    operatorGroups: string[];
    hosts: string[];
  } | null;
  g5: string;
  balance: string;
  minimum: string;
}
// V1.11: why a preflight could not reach a verdict (no gate failed; a data source could not be agreed on).
interface Diagnostics {
  code: string;
  chain: string;
  health: {
    host: string;
    operatorGroup: string;
    role: string;
    ok: boolean;
    finalized: number | null;
    lagBlocks: number | null;
    failure: string | null;
  }[];
  attempts: { a: string; b: string; outcome: string }[];
  observedAt: number;
}
type Review = PilotReview & {
  estimatedGas: { gas: string; gasPrice: string; cost: string };
  quote: {
    observedAt: number;
    sourceBlock: number;
    sourceBlockHash: string;
    destinationBlock: number;
    destinationBlockHash: string;
  };
};
interface Tracking {
  status: string;
  g7Pass: boolean;
  reasons: string[];
  txCheck: { found: boolean; exact: boolean; mismatches: string[] };
  source: {
    found: boolean;
    status: string | null;
    canonical: boolean;
    confirmations: number | null;
    index: string | null;
  };
  destination: {
    event: string | null;
    txHash: string | null;
    finalized: boolean | null;
    payout: { amount: string; recipient: string } | null;
  };
}
interface Snapshot {
  sessionId: string;
  mode: "real" | "dry-run";
  fixture: boolean;
  state: string;
  terminal: boolean;
  busy: boolean;
  sendCapability: boolean;
  serverNow: number;
  preflight: {
    id: string;
    kind: string;
    status: string;
    decisionAt: number;
    gates: Gate[];
    blockedReasons: string[];
    reapprovalReasons: string[];
    summary: Summary | null;
    review: Review | null;
    error: string | null;
    diagnostics?: Diagnostics | null;
  } | null;
  walletResult: { outcome: string; errorMessage?: string | null } | null;
  txHash: string | null;
  hashSource: string | null;
  tracking: Tracking | null;
  trackingError: string | null;
}
type Tone = "" | "ok" | "bad";

const TOKEN_KEY = "g7-product-pilot-token";
function readToken() {
  const m = /(?:^#|&)g7-pilot=([A-Za-z0-9_-]{20,100})(?:&|$)/.exec(
    location.hash,
  );
  if (m) {
    try {
      sessionStorage.setItem(TOKEN_KEY, m[1]);
    } catch {
      // the token still works for this page load
    }
    history.replaceState(history.state, "", location.pathname);
    return m[1];
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
const STOPS: Record<string, string> = {
  BLOCKED:
    "Route review required — a fresh safety check failed. No wallet request is possible.",
  OWNER_REAPPROVAL_REQUIRED:
    "Owner re-approval required — a live value exceeds the approved pilot bounds. No wallet request will be made.",
  USER_REJECTED:
    "You rejected the transaction in your wallet. The pilot is stopped; there is no retry.",
  MANUAL_REVIEW_REQUIRED:
    "Manual review required — the wallet result is uncertain. Do not retry; the chain is watched read-only.",
  ABORTED_BEFORE_WALLET_REQUEST:
    "Stopped before any wallet request. The one-time authorization is used up; a new attempt needs a new owner approval.",
  LOCKED:
    "This pilot authorization was already used (one-time lock). Showing read-only status only.",
  EXPIRED:
    "This local pilot session expired. Restart pnpm g7:product-pilot for a fresh check.",
};
// A preflight that could not reach a verdict (X0: a read-only data source was unavailable or lagging) is retryable
// and says so; any failed gate keeps the strict "route review required" stop. Both make no wallet request.
type Preflight = NonNullable<Snapshot["preflight"]>;
export function retryableStop(p: Preflight | null | undefined) {
  if (!p || p.status !== "BLOCKED") return null;
  const failed = p.gates.filter((g) => g.status !== "PASS");
  if (failed.length !== 1 || failed[0].id !== "X0") return null;
  if (
    p.diagnostics?.code === "RPC_FINALIZED_HASH_DISAGREEMENT" ||
    /HASH_DISAGREEMENT|MALFORMED|LOG_FILTER_MISMATCH|DUPLICATE_LOG|CHECKPOINT_CANONICAL|REQUEST_BUDGET_EXHAUSTED/i.test(
      p.error ?? "",
    )
  )
    return null;
  if (
    p.diagnostics?.code !== "RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE" &&
    !/RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE|block not found|header not found|RATE_LIMITED|usage limit|too many requests|\b429\b|TIMEOUT|timed out|fetch failed|HTTP_(?:403|5\d\d)/i.test(
      p.error ?? "",
    )
  )
    return null;
  const bscLag =
    p.diagnostics?.chain === "bsc" ||
    /RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE|block not found|header not found/i.test(
      p.error ?? "",
    );
  const limited =
    /RATE_LIMITED|usage limit|too many requests|\b429\b/i.test(
      `${p.error ?? ""} ${JSON.stringify(p.diagnostics?.attempts ?? [])} ${(p.diagnostics?.health ?? []).map((h) => h.failure).join(" ")}`,
    ) && !(p.diagnostics?.health ?? []).some((h) => h.ok && h.lagBlocks);
  return {
    title: "Safety check needs another attempt",
    body:
      limited || bscLag
        ? "One of the independent BSC data sources is temporarily unavailable. No wallet request was made."
        : "A data source did not answer in time. No wallet request was made.",
    gate: `${failed[0].id} ${failed[0].name}`,
    reason: p.diagnostics?.code ?? (p.error ?? "").split(/[:(]/)[0].trim(),
    chain: p.diagnostics?.chain ?? (bscLag ? "bsc" : "—"),
    sources: (p.diagnostics?.health ?? []).map(
      (h) =>
        `${h.host} · ${h.operatorGroup} · ${h.ok ? `finalized ${h.finalized}${h.lagBlocks ? ` (${h.lagBlocks} behind)` : ""}` : (h.failure ?? "unavailable")}`,
    ),
  };
}
const STEPS = [
  "Submitted",
  "Confirming on ONEchain",
  "ONEchain confirmed",
  "Bridging",
  "BSC finalized",
  "Completed",
] as const;
function stepStates(s: Snapshot): ("done" | "active" | "pending")[] {
  const t = s.tracking;
  const submitted = !!s.txHash;
  const canonical = !!t?.source.canonical && !!t.source.index;
  const event = t?.destination.event === "BridgeFinalized";
  const finalized = event && t?.destination.finalized === true;
  const completed = s.state === "G7_PASS" || !!t?.g7Pass;
  const done = [submitted, canonical, canonical, event, finalized, completed];
  const firstOpen = done.indexOf(false);
  return done.map((d, i) =>
    d ? "done" : i === firstOpen && submitted ? "active" : "pending",
  );
}

export function LocalPilotBadge() {
  return (
    <span className={`badge ${styles.badge}`}>
      <span className="dot" />
      CONTROLLED PILOT · LOCAL ONLY · 5 ONE AUTHORIZED
    </span>
  );
}

export default function LocalPilotBridge(props: LocalPilotBridgeProps) {
  const { gate, wallet: provider, walletId, account, chain, t } = props;
  const [snap, setSnap] = useState<Snapshot>();
  const [tokenMissing, setTokenMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: Tone }>({
    text: "",
    tone: "",
  });
  const [scope, setScope] = useState(false);
  const [trust, setTrust] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [check, setCheck] = useState<{
    ok: boolean;
    failures: string[];
    forDigest: string | null;
  }>({ ok: false, failures: ["verifying"], forDigest: null });
  const [armedLocally, setArmedLocally] = useState(false);
  const [lastHash, setLastHash] = useState<string>();
  const [now, setNow] = useState(0);
  const token = useRef<string | null>(null);
  const csrf = useRef<string | null>(null);
  const busyRef = useRef(false);
  const inflight = useRef(0);
  const reviewDigest = useRef<string | null>(null);
  const previousChain = useRef<number | undefined>(chain);
  const dialog = useRef<HTMLDialogElement>(null);

  const accept = useCallback((s: Snapshot) => {
    setSnap(s);
    const digest = s.preflight?.review?.intentDigest ?? null;
    if (digest === reviewDigest.current) return;
    const first = reviewDigest.current === null;
    reviewDigest.current = digest;
    setCheck({ ok: false, failures: ["verifying"], forDigest: null });
    if (!first) {
      setScope(false);
      setTrust(false);
      setPhrase("");
      setMsg({
        text: "The transaction values changed — review them and confirm again.",
        tone: "",
      });
    }
    if (digest && s.preflight?.review)
      void verifyReview(s.preflight.review).then((r) => {
        if (reviewDigest.current !== digest) return;
        setCheck({
          ok: r.ok && r.digest === digest,
          failures: r.failures,
          forDigest: digest,
        });
      });
  }, []);
  const api = useCallback(
    async (route: string, body: Record<string, unknown> = {}) => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${token.current}`,
      };
      if (csrf.current) headers["x-g7-csrf"] = csrf.current;
      inflight.current++;
      try {
        const res = await fetch(`${gate.apiBase}/${route}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          mode: "same-origin",
        });
        const data = await res.json().catch(() => null);
        if (data?.sessionId) accept(data as Snapshot);
        else if (data?.state?.sessionId) accept(data.state as Snapshot);
        if (!res.ok)
          throw Object.assign(new Error(data?.error ?? `HTTP_${res.status}`), {
            code: data?.error ?? `HTTP_${res.status}`,
          });
        return data;
      } finally {
        inflight.current--;
      }
    },
    [gate.apiBase, accept],
  );

  useEffect(() => {
    token.current = readToken();
    if (!token.current) {
      queueMicrotask(() => setTokenMissing(true));
      return;
    }
    void api("claim")
      .then((d) => (csrf.current = d.csrf))
      .catch((e) =>
        setMsg({ text: `Local pilot session refused: ${e.code}`, tone: "bad" }),
      );
    const poll = setInterval(() => {
      if (!busyRef.current && inflight.current === 0 && csrf.current)
        void api("state").catch(() => undefined);
    }, 2500);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [api]);

  const authorized = account.toLowerCase() === EXPECT.account;
  const rightChain = chain === EXPECT.chainId;
  const mockProvider = walletId === EXPECT.mockRdns;
  // Fixture data may only ever reach the test mock; the test mock is never accepted outside fixture mode.
  const providerAllowed = !!provider && !!snap && snap.fixture === mockProvider;

  const resetConfirmations = useCallback((note?: string) => {
    setScope(false);
    setTrust(false);
    setPhrase("");
    if (note) setMsg({ text: note, tone: "" });
  }, []);
  // A wallet network switch is its own owner step; once on ONEchain the full preflight is re-run.
  useEffect(() => {
    const before = previousChain.current;
    // V1.9: while the wallet session re-binds (account/chain change) the chain is briefly unknown; keep the last
    // known chain so that 56 → (re-binding) → 612055 is still recognized as a network switch.
    if (chain === undefined) return;
    previousChain.current = chain;
    if (before === undefined || before === chain) return;
    queueMicrotask(() =>
      resetConfirmations("Wallet network changed — confirm again."),
    );
    if (
      chain === EXPECT.chainId &&
      snap &&
      ["READY", "BLOCKED", "DRY_RUN_COMPLETE"].includes(snap.state) &&
      !busyRef.current
    ) {
      busyRef.current = true;
      queueMicrotask(() => setBusy(true));
      void api("refresh")
        .then(() =>
          resetConfirmations(
            "Wallet is on ONEchain — the full safety check ran again. Review and confirm.",
          ),
        )
        .catch((e) =>
          setMsg({ text: `Safety check failed: ${e.code}`, tone: "bad" }),
        )
        .finally(() => {
          busyRef.current = false;
          setBusy(false);
        });
    }
  }, [chain, snap, api, resetConfirmations]);
  useEffect(() => {
    queueMicrotask(() => resetConfirmations());
  }, [account, resetConfirmations]);

  const review = snap?.preflight?.review ?? null;
  const summary = snap?.preflight?.summary ?? null;
  const phraseOk = phrase === EXPECT.phrase;
  const canReview =
    !!snap &&
    snap.state === "READY" &&
    !snap.busy &&
    snap.sendCapability &&
    !!review &&
    check.ok &&
    check.forDigest === review.intentDigest &&
    authorized &&
    rightChain &&
    providerAllowed &&
    !armedLocally &&
    !busy;
  const canSend =
    canReview &&
    scope &&
    trust &&
    phraseOk &&
    !sendAttempted(snap?.sessionId ?? "");

  async function identity() {
    if (!provider || provider.revoked) throw new Error("WALLET_SESSION_STALE");
    if (provider.address.toLowerCase() !== EXPECT.account)
      throw new Error("WALLET_NOT_AUTHORIZED_FOR_PILOT");
    const live = await provider.identity();
    const a = live.account.toLowerCase();
    if (a !== EXPECT.account)
      throw new Error("WALLET_NOT_AUTHORIZED_FOR_PILOT");
    if (live.chainId !== EXPECT.chainId)
      throw new Error("WALLET_NOT_ON_ONECHAIN");
    return { account: a, chainId: EXPECT.chainIdHex };
  }
  async function report(armId: string, body: Record<string, unknown>) {
    for (let i = 0; i < 4; i++) {
      try {
        return await api("wallet-result", { armId, ...body });
      } catch (e) {
        const code = String((e as { code?: string }).code ?? "");
        if (code && !/^HTTP_5|INTERNAL/.test(code)) throw e;
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    }
    throw new Error("WALLET_RESULT_NOT_RECORDED");
  }
  async function reviewInWallet() {
    // Synchronous guard: a double click cannot start a second flow before React re-renders.
    if (busyRef.current || !canSend || !snap || !review || !provider) return;
    busyRef.current = true;
    setBusy(true);
    const reviewed = review;
    const digest = reviewed.intentDigest;
    let armed = false;
    try {
      setMsg({ text: "Checking your wallet…", tone: "" });
      let wallet = await identity();
      const local = await verifyReview(reviewed);
      if (!local.ok || local.digest !== digest)
        throw new Error(`BROWSER_CHECK_FAILED ${local.failures.join(",")}`);
      setMsg({ text: "Running the final safety check on mainnet…", tone: "" });
      const fin = await api("final", {
        intentDigest: digest,
        confirmations: { scope, trust, phrase },
        wallet,
      });
      if (fin.outcome !== "ARMABLE") {
        const text: Record<string, string> = {
          INTENT_CHANGED:
            "The final check changed the transaction values. Review them and confirm again.",
          QUOTE_TOO_OLD:
            "The final quote was too old. Press Review in wallet again.",
          OWNER_REAPPROVAL_REQUIRED: STOPS.OWNER_REAPPROVAL_REQUIRED,
          BLOCKED: STOPS.BLOCKED,
          EXPIRED: STOPS.EXPIRED,
        };
        const retry =
          fin.outcome === "BLOCKED" ? retryableStop(fin.preflight) : null;
        setMsg({
          text: retry
            ? `${retry.title}. ${retry.body}`
            : `${text[fin.outcome] ?? fin.outcome} No wallet request was made.`,
          tone: "bad",
        });
        return;
      }
      const fresh = fin.preflight?.review as Review | undefined;
      const freshCheck = fresh ? await verifyReview(fresh) : null;
      if (
        !fresh ||
        fresh.intentDigest !== digest ||
        !freshCheck?.ok ||
        freshCheck.digest !== digest
      )
        throw new Error("FINAL_REVIEW_NOT_IDENTICAL");
      wallet = await identity();
      const t0 = performance.now();
      const arm = await api("arm", {
        candidateId: fin.candidateId,
        intentDigest: digest,
        wallet,
      });
      if (arm.dryRun) {
        setMsg({
          text: "Dry run complete — every check passed and the wallet request was suppressed.",
          tone: "ok",
        });
        return;
      }
      // Armed: the one-time capability is consumed on the server. From here on there is no retry of any kind.
      armed = true;
      setArmedLocally(true);
      let abort: string | null = null;
      if (arm.intentDigest !== digest) abort = "ARMED_DIGEST_DIFFERS";
      else if (!sameTx(arm.tx, fresh.tx) || !sameTx(arm.tx, reviewed.tx))
        abort = "ARMED_TX_DIFFERS_FROM_REVIEW";
      else {
        const v = await verifyReview({
          intent: arm.intent,
          intentDigest: arm.intentDigest,
          tx: arm.tx,
        });
        if (!v.ok) abort = `ARMED_TX_CHECK:${v.failures.join(",")}`;
      }
      if (!abort)
        try {
          await identity();
        } catch (e) {
          abort = (e as Error).message;
        }
      const quoteAge = Math.ceil(arm.quoteAgeMs + (performance.now() - t0));
      if (!abort && quoteAge > EXPECT.quoteMaxAgeAtWalletMs)
        abort = `QUOTE_AGE_${quoteAge}MS_ABOVE_20S`;
      if (abort) {
        await report(arm.armId, {
          outcome: "ABORTED_BEFORE_WALLET_REQUEST",
          errorMessage: abort,
        });
        setMsg({
          text: `Stopped before any wallet request (${abort}). No retry.`,
          tone: "bad",
        });
        return;
      }
      setMsg({
        text: "Confirm in your wallet. Check the amount, contract and network there — reject if anything differs.",
        tone: "",
      });
      const common = {
        quoteAgeAtWalletRequestMs: quoteAge,
        walletRequestAt: Date.now(),
      };
      let result: unknown, error: unknown;
      try {
        // Canonical = the transaction the server released at arm; request = the reviewed transaction. The adapter
        // compares them field by field right before the single wallet send.
        await api("wallet-attempt", { armId: arm.armId });
        result = await requestWalletConfirmationOnce(
          provider,
          exactTx(arm.tx),
          exactTx(reviewed.tx),
          snap.sessionId,
        );
      } catch (e) {
        error = e ?? new Error("UNKNOWN_PROVIDER_ERROR");
      }
      if (
        error &&
        (error as { beforeWalletRequest?: unknown }).beforeWalletRequest ===
          true
      ) {
        // The wallet adapter refused before asking the wallet (stale session, changed identity, mismatch).
        const refusal = String((error as { code?: unknown }).code ?? "REFUSED");
        await report(arm.armId, {
          outcome: "ABORTED_BEFORE_WALLET_REQUEST",
          errorMessage: `WALLET_ADAPTER_REFUSED:${refusal}`,
        });
        setMsg({
          text: `Stopped before any wallet request (${refusal}). No retry.`,
          tone: "bad",
        });
        return;
      }
      if (error) {
        const code = (error as { code?: unknown }).code;
        const message = String((error as Error)?.message ?? error).slice(
          0,
          300,
        );
        if (code === 4001) {
          await report(arm.armId, {
            outcome: "USER_REJECTED",
            errorCode: 4001,
            errorMessage: message,
            ...common,
          });
          setMsg({ text: STOPS.USER_REJECTED, tone: "bad" });
        } else {
          await report(arm.armId, {
            outcome: "PROVIDER_ERROR",
            errorCode:
              typeof code === "number" || typeof code === "string"
                ? code
                : null,
            errorMessage: message,
            ...common,
          });
          setMsg({ text: STOPS.MANUAL_REVIEW_REQUIRED, tone: "bad" });
        }
        return;
      }
      if (typeof result === "string" && /^0x[0-9a-fA-F]{64}$/.test(result)) {
        setLastHash(result);
        await report(arm.armId, {
          outcome: "TX_HASH",
          txHash: result,
          ...common,
        });
        setMsg({
          text: "Submitted. Tracking on ONEchain and BSC.",
          tone: "ok",
        });
        dialog.current?.close();
      } else {
        await report(arm.armId, {
          outcome: "PROVIDER_ERROR",
          errorMessage: `UNEXPECTED_RESULT:${String(result).slice(0, 120)}`,
          ...common,
        });
        setMsg({ text: STOPS.MANUAL_REVIEW_REQUIRED, tone: "bad" });
      }
    } catch (e) {
      const code = (e as { code?: string }).code ?? (e as Error).message;
      setMsg({
        text: `${code}${
          armed
            ? " — the one-time authorization is used up; do not retry."
            : " — no wallet request was made."
        }`,
        tone: "bad",
      });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function recheck() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await api("refresh");
    } catch (e) {
      setMsg({
        text: `Safety check failed: ${(e as { code?: string }).code}`,
        tone: "bad",
      });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const one = (wei: string | bigint) => `${units(wei)} ONE`;
  const row = (label: string, value: string, mono = false) => (
    <div className="data-row">
      <span>{label}</span>
      <strong className={mono ? styles.mono : undefined}>{value}</strong>
    </div>
  );
  const balance = summary?.balance
    ? BigInt(summary.balance)
    : props.liveBalance;
  const intent = review?.intent;
  const retry =
    snap?.state === "BLOCKED" && !busy ? retryableStop(snap.preflight) : null;
  const stop =
    snap && STOPS[snap.state] && !(snap.state === "BLOCKED" && busy)
      ? STOPS[snap.state]
      : null;
  const pin = summary?.bscPin ?? null;
  const tracking = !!snap?.txHash;
  const states = snap ? stepStates(snap) : [];
  const quoteAge =
    review && snap && now
      ? Math.max(0, (now - review.quote.observedAt) / 1000).toFixed(0)
      : null;
  const holdOnBsc = snap?.tracking?.destination.event === "BridgePending";

  return (
    <>
      <div className="amount-label">
        <label htmlFor="pilot-amount">{t("amount")}</label>
        <span>
          {t("balance")}: {balance !== undefined ? one(balance) : "—"}
        </span>
      </div>
      <div className="amount-input">
        <input
          id="pilot-amount"
          value="5"
          readOnly
          aria-readonly="true"
          aria-describedby="pilot-amount-hint"
        />
        <span>ONE</span>
      </div>
      <p id="pilot-amount-hint" className="input-hint">
        Controlled pilot: the amount is fixed at exactly 5 ONE.
      </p>
      {account && (
        <div className="recipient">
          <span className="micro">
            {t("recipient")} · {t("same")}
          </span>
          <div className="address">
            <code dir="ltr">{account}</code>
          </div>
        </div>
      )}
      {account && !authorized && (
        <div className="notice error" role="alert">
          <p>This wallet is not authorized for the G7 pilot.</p>
        </div>
      )}
      {account && authorized && provider && snap && !providerAllowed && (
        <div className="notice error" role="alert">
          <p>This wallet cannot be used in this pilot session.</p>
        </div>
      )}
      {account && authorized && !rightChain && !tracking && (
        <div className="notice">
          <p>{t("wrongChain")}</p>
          <button disabled={busy} onClick={props.switchToOneChain}>
            Switch to ONEchain
          </button>
          <button className="small" disabled={busy} onClick={props.addOneChain}>
            {t("addChain")}
          </button>
          <p className="input-hint">{t("networkNote")}</p>
        </div>
      )}
      <div className="fees">
        {row(t("fee"), intent ? one(intent.networkFee) : t("unknown"))}
        {row(t("ourFee"), "0 ONE")}
        {row(
          "Estimated gas",
          review ? one(review.estimatedGas.cost) : t("unknown"),
        )}
        {row(
          "Maximum wallet debit",
          intent ? one(intent.maximumWalletDebit) : t("unknown"),
        )}
        <div className="receive">{row("You receive", "5 CROSS")}</div>
      </div>
      {tokenMissing && (
        <p className="notice">
          The controlled pilot runs locally. Open the exact link printed by{" "}
          <code>pnpm g7:product-pilot</code> to continue.
        </p>
      )}
      {!snap && !tokenMissing && (
        <p className="input-hint">Checking the route…</p>
      )}
      {snap?.state === "PREFLIGHT_RUNNING" && (
        <p className="input-hint" role="status">
          Running the fresh mainnet safety check…
        </p>
      )}
      {stop && !tracking && (
        <div className="notice error" role="alert">
          {retry ? (
            <>
              <p>
                <strong>{retry.title}</strong>
              </p>
              <p>{retry.body}</p>
            </>
          ) : (
            <p>{stop}</p>
          )}
          {retry && (
            <details className={styles.safety}>
              <summary>Advanced details</summary>
              <dl>
                <dt>Failing gate</dt>
                <dd>{retry.gate}</dd>
                <dt>Reason</dt>
                <dd className={styles.mono}>{retry.reason || "—"}</dd>
                <dt>Chain</dt>
                <dd>{retry.chain}</dd>
                <dt>Data sources (operator group)</dt>
                {retry.sources.length ? (
                  retry.sources.map((x) => (
                    <dd key={x} className={styles.mono}>
                      {x}
                    </dd>
                  ))
                ) : (
                  <dd>—</dd>
                )}
                <dt>Last verified BSC pin</dt>
                <dd>
                  {pin ? `block ${pin.block} · ${pin.ageSec} s old` : "—"}
                </dd>
                <dt>Wallet request</dt>
                <dd>None was made</dd>
              </dl>
            </details>
          )}
          {snap?.state === "BLOCKED" && (
            <button
              className="small"
              disabled={busy}
              onClick={() => void recheck()}
            >
              Try again
            </button>
          )}
        </div>
      )}
      {tracking && snap && (
        <section className={styles.progress} aria-label="Transfer progress">
          <ol>
            {STEPS.map((label, i) => (
              <li key={label} className={styles[states[i]]}>
                <span aria-hidden="true">
                  {states[i] === "done"
                    ? "✓"
                    : states[i] === "active"
                      ? "…"
                      : "·"}
                </span>
                {label}
              </li>
            ))}
          </ol>
          <p className="micro">Transaction</p>
          <div className="address">
            <code dir="ltr">{snap.txHash}</code>
          </div>
          {snap.hashSource === "chain-detected" && (
            <p className="notice">
              Detected on chain (not reported by the wallet). Manual review
              required.
            </p>
          )}
          {(snap.state === "MANUAL_REVIEW_REQUIRED" ||
            snap.tracking?.status === "MANUAL_REVIEW_REQUIRED") && (
            <p className="notice error" role="alert">
              Manual review required: {snap.tracking?.reasons.join("; ")}. No
              automatic retry or release.
            </p>
          )}
          {holdOnBsc && (
            <p className="notice error" role="alert">
              Held as pending on BSC. Nothing is released automatically.
            </p>
          )}
          {snap.state === "G7_PASS" && (
            <p className="notice" role="status">
              Completed: exactly 5 CROSS delivered to {EXPECT.accountDisplay} on
              a finalized BSC block.
            </p>
          )}
        </section>
      )}
      {!tracking &&
        (!account ? (
          <button className="primary" onClick={props.openWallet}>
            {t("connect")} <span>↗</span>
          </button>
        ) : (
          <button
            className="primary"
            disabled={!canReview}
            onClick={() => dialog.current?.showModal()}
          >
            {t("review")} <span>→</span>
          </button>
        ))}
      <p className="under-button">One transaction · 5 ONE · no approval</p>
      {msg.text && !tracking && (
        <p className={`${styles.msg} ${styles[msg.tone] ?? ""}`} role="status">
          {msg.text}
        </p>
      )}
      <dialog
        ref={dialog}
        className={styles.dialog}
        aria-labelledby="pilot-review-title"
        onKeyDown={trapDialog}
      >
        <div className="dialog-top">
          <h2 id="pilot-review-title">Review the 5 ONE pilot transfer</h2>
          <button
            className="icon-button"
            aria-label={t("close")}
            onClick={() => dialog.current?.close()}
          >
            ×
          </button>
        </div>
        <LocalPilotBadge />
        {intent && review && (
          <>
            <div className={styles.route}>
              <span>ONEchain</span>
              <span aria-hidden="true">→</span>
              <span>BNB Smart Chain</span>
            </div>
            {row("You pay", "5 ONE")}
            {row(t("fee"), one(intent.networkFee))}
            {row(t("ourFee"), "0 ONE")}
            {row("Estimated gas", one(review.estimatedGas.cost))}
            {row("Maximum wallet debit", one(intent.maximumWalletDebit))}
            <div className="receive">{row("You receive", "5 CROSS")}</div>
            {row("Approval", "None")}
            <p className="micro">From · ONEchain</p>
            <div className="address">
              <code dir="ltr">{intent.from}</code>
            </div>
            <p className="micro">Recipient · BSC · same wallet</p>
            <div className="address">
              <code dir="ltr">{intent.recipient}</code>
            </div>
            <details className={styles.safety}>
              <summary>Safety details</summary>
              <dl>
                <dt>RPC consensus (BSC common finalized pin)</dt>
                <dd className={styles.mono}>
                  {pin
                    ? `block ${pin.block} · ${pin.ageSec} s old · ${pin.operatorGroups.join(" + ")} (${pin.hosts.join(", ")})`
                    : "—"}
                </dd>
                <dt>Fresh check</dt>
                <dd>
                  {snap?.preflight?.status} ·{" "}
                  {
                    snap?.preflight?.gates.filter((g) => g.status === "PASS")
                      .length
                  }
                  /{snap?.preflight?.gates.length} gates pass · quote{" "}
                  {quoteAge ?? "—"} s old (re-checked when you continue; must be
                  ≤ 20 s at the wallet request)
                </dd>
                <dt>Runtime pins</dt>
                <dd className={styles.mono}>
                  ONE proxy {intent.routePins.source.proxy} → implementation{" "}
                  {intent.routePins.source.implementation} (
                  {intent.routePins.source.implementationCodeHash}) · BSC
                  implementation {intent.routePins.destination.implementation} (
                  {intent.routePins.destination.implementationCodeHash}) ·{" "}
                  {summary?.runtimeDrift}
                </dd>
                <dt>Authority</dt>
                <dd className={styles.mono}>
                  admin {intent.trust.source.admins.join(", ")} (single EOA) ·
                  validators {intent.trust.source.validators.join(", ")} ·
                  threshold {intent.trust.source.threshold}-of-
                  {intent.trust.source.validators.length} · VERIFIER_ROLE{" "}
                  {intent.trust.source.verifierRole.join(", ")} ·{" "}
                  {summary?.authorityDrift}
                </dd>
                <dt>Reserve</dt>
                <dd>
                  {summary?.reserve.status} · spendable{" "}
                  {summary?.reserve.spendable} CROSS · verified{" "}
                  {String(summary?.reserve.verified)} · BSC finalized block{" "}
                  {summary?.reserve.block}
                </dd>
                <dt>Pending / in-flight</dt>
                <dd>
                  {summary?.pending.status} · pendingAmount{" "}
                  {summary?.pending.pendingAmount} · valued pending{" "}
                  {summary?.pending.valuedActivePendingCross} · in-flight{" "}
                  {summary?.pending.inFlightCount} (enumerated{" "}
                  {String(summary?.pending.inFlightEnumerated)})
                </dd>
                <dt>Simulation</dt>
                <dd>
                  {summary?.simulation.status} · eth_call{" "}
                  {summary?.simulation.ethCall.join(" | ")} · estimateGas{" "}
                  {summary?.simulation.estimateGas.join(" | ")} · negative
                  controls {summary?.simulation.negativeControls}
                </dd>
                <dt>Firewall</dt>
                <dd>
                  {summary?.firewall.status} · mutations rejected{" "}
                  {summary?.firewall.mutationsRejected} · hostile replay{" "}
                  {summary?.firewall.hostileReplay} · production gate closed{" "}
                  {String(summary?.firewall.productionGateClosed)}
                </dd>
                <dt>RPC consensus</dt>
                <dd>
                  {summary?.dualRpc} (two official ONEchain endpoints, two BSC
                  sources)
                </dd>
                <dt>Contract</dt>
                <dd className={styles.mono}>
                  {intent.to} · {intent.function} · {intent.selector}
                </dd>
                <dt>Calldata hash</dt>
                <dd className={styles.mono}>{intent.calldataKeccak256}</dd>
                <dt>Intent digest</dt>
                <dd className={styles.mono}>
                  {review.intentDigest}{" "}
                  {check.forDigest === review.intentDigest
                    ? check.ok
                      ? "· re-verified in this browser ✓"
                      : `· BROWSER CHECK FAILED: ${check.failures.join(", ")}`
                    : "· verifying…"}
                </dd>
                <dt>Exact wallet request</dt>
                <dd className={styles.mono}>
                  {JSON.stringify(exactTx(review.tx))}
                </dd>
                <dt>Trust model</dt>
                <dd>
                  Settlement and upgrades are controlled by EOAs: a single admin
                  EOA and 2-of-3 validator EOAs. This is a centralized trust
                  assumption, not a trustless bridge.
                </dd>
              </dl>
            </details>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={scope}
                disabled={!canReview}
                onChange={(e) => setScope(e.target.checked)}
              />
              <span>I reviewed the 5 ONE pilot transaction.</span>
            </label>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={trust}
                disabled={!canReview}
                onChange={(e) => setTrust(e.target.checked)}
              />
              <span>
                I accept the centralized ONEbridge trust model for this pilot.
              </span>
            </label>
            <label className={styles.phrase} htmlFor="pilot-phrase">
              Type <code>{EXPECT.phrase}</code> to continue
            </label>
            <input
              id="pilot-phrase"
              className={styles.phraseInput}
              autoComplete="off"
              spellCheck={false}
              value={phrase}
              disabled={!canReview}
              onChange={(e) => setPhrase(e.target.value)}
            />
            <button
              className="primary"
              disabled={!canSend}
              onClick={() => void reviewInWallet()}
            >
              Review in wallet <span>↗</span>
            </button>
            <p className="under-button">
              One transaction · 5 ONE · no approval
            </p>
            {(msg.text || lastHash) && (
              <p
                className={`${styles.msg} ${styles[msg.tone] ?? ""}`}
                role="status"
              >
                {msg.text}
              </p>
            )}
          </>
        )}
      </dialog>
    </>
  );
}
