"use client";
import { useEffect, useRef, useState } from "react";
import type { VerifiedTransaction } from "../activity/model";
import { matchingBridge } from "../activity/model";
import { PageHeader, shortAddress } from "./ui";
import { Icon } from "./icons";
import "./verified-activity.css";
interface Reference {
  chainId: "8453" | "42161";
  hash: string;
}
const key = (address: string) =>
  `veined:verified-imports:v1:${address.toLowerCase()}`;
function references(address: string): Reference[] {
  try {
    const v = JSON.parse(localStorage.getItem(key(address)) ?? "[]");
    return Array.isArray(v)
      ? v
          .filter(
            (r) =>
              r &&
              ["8453", "42161"].includes(r.chainId) &&
              /^0x[0-9a-fA-F]{64}$/.test(r.hash),
          )
          .map((r) => ({ chainId: r.chainId, hash: r.hash }))
          .slice(0, 30)
      : [];
  } catch {
    return [];
  }
}
const errors: Record<string, string> = {
  ADDRESS_NOT_INVOLVED:
    "This address is not involved in the verified transaction. It was not imported.",
  VERIFICATION_UNAVAILABLE:
    "A network provider could not verify the receipt. No unverified transaction was added. Try again.",
  OPERATORS_DISAGREE:
    "The two network operators disagree. The transaction was not imported.",
  PENDING_CONFIRMATIONS:
    "The receipt needs more confirmations. Check again later.",
  RATE_LIMITED:
    "The read-only request limit was reached. Wait a minute and try again.",
  RPC_POLICY_CLOSED:
    "The RPC policy does not allow this provider in this deployment.",
};
export default function VerifiedActivity({
  account = "",
  onConnect,
  embedded = false,
}: {
  account?: string;
  onConnect?: () => void;
  embedded?: boolean;
}) {
  const RowHeading = embedded ? "h3" : "h2";
  const [mode, setMode] = useState<"wallet" | "address">(
    account ? "wallet" : "address",
  );
  const [query, setQuery] = useState("");
  const address = mode === "wallet" ? account : query.trim();
  const [chainId, setChain] = useState<"8453" | "42161">("8453"),
    [hash, setHash] = useState("");
  const [consent, setConsent] = useState(false),
    [rows, setRows] = useState<VerifiedTransaction[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [sourceErrors, setSourceErrors] = useState<
    { operator: string; code: string }[]
  >([]);
  const request = useRef<AbortController | null>(null),
    sequence = useRef(0);
  useEffect(() => () => request.current?.abort(), []);
  function reset() {
    request.current?.abort();
    sequence.current++;
    setRows([]);
    setError("");
    setSourceErrors([]);
    setBusy(false);
    setConsent(false);
  }
  async function verify(saved = false) {
    if (!consent || busy || !/^0x[0-9a-fA-F]{40}$/.test(address)) return;
    const refs = saved ? references(address) : [{ chainId, hash: hash.trim() }];
    if (!refs.length) {
      setError(
        "No hashes saved for this address. Import a known transaction below.",
      );
      return;
    }
    if (refs.some((r) => !/^0x[0-9a-fA-F]{64}$/.test(r.hash))) {
      setError("Enter a complete transaction hash.");
      return;
    }
    request.current?.abort();
    const c = new AbortController(),
      attempt = ++sequence.current;
    request.current = c;
    setBusy(true);
    setError("");
    setSourceErrors([]);
    try {
      for (const ref of refs) {
        const r = await fetch("/api/activity", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...ref, address, consent: true }),
          signal: AbortSignal.any([c.signal, AbortSignal.timeout(30000)]),
        });
        const body = await r.json();
        if (attempt !== sequence.current || c.signal.aborted) return;
        if (!r.ok) {
          setSourceErrors(body.sources ?? []);
          throw Error(
            `${errors[body.error] ?? "The transaction could not be verified."} (${body.error}; request ${body.requestId ?? "unknown"})`,
          );
        }
        const tx = body.transaction as VerifiedTransaction;
        if (
          tx.address !== address.toLowerCase() ||
          tx.hash !== ref.hash.toLowerCase() ||
          tx.chainId !== ref.chainId
        )
          throw Error(
            "The response does not match the requested address and transaction.",
          );
        setRows((v) =>
          [
            ...v.filter((x) => x.hash !== tx.hash || x.chainId !== tx.chainId),
            tx,
          ].sort((a, b) => b.timestamp - a.timestamp),
        );
        try {
          const next = [
            ...references(address).filter(
              (x) =>
                x.hash.toLowerCase() !== tx.hash || x.chainId !== tx.chainId,
            ),
            { chainId: tx.chainId, hash: tx.hash },
          ].slice(-30);
          localStorage.setItem(key(address), JSON.stringify(next));
        } catch {
          /* Verification does not depend on storage. */
        }
      }
    } catch (e) {
      if (attempt === sequence.current && !c.signal.aborted)
        setError(
          e instanceof Error
            ? e.message
            : "Provider unavailable. Retry the read-only verification.",
        );
    } finally {
      if (attempt === sequence.current) setBusy(false);
    }
  }
  return (
    <section
      className="verified-activity"
      aria-label="Verified wallet activity"
    >
      {embedded ? (
        <h2>Verify a transaction</h2>
      ) : (
        <PageHeader
          title="Activity, verified."
          lede="Real receipts for your address. Read directly from two network operators."
        />
      )}
      <div className="card va-import">
        <div
          className="segmented"
          role="group"
          aria-label="Activity address mode"
        >
          <button
            aria-pressed={mode === "wallet"}
            onClick={() => {
              reset();
              setMode("wallet");
            }}
          >
            My wallet
          </button>
          <button
            aria-pressed={mode === "address"}
            onClick={() => {
              reset();
              setMode("address");
            }}
          >
            View another address
          </button>
        </div>
        {mode === "wallet" ? (
          account ? (
            <p className="va-address">
              <Icon name="wallet" size={16} />
              <span>Connected wallet</span>
              <bdi>{account}</bdi>
            </p>
          ) : (
            <p>
              Connect your wallet to use its address.{" "}
              <button className="button" onClick={onConnect}>
                Connect Wallet
              </button>
            </p>
          )
        ) : (
          <label className="va-field">
            Wallet address
            <input
              aria-label="Activity wallet address"
              value={query}
              placeholder="0x…"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                reset();
                setQuery(e.target.value);
              }}
            />
          </label>
        )}
        <div className="va-import-fields">
          <label className="va-field">
            Network
            <select
              aria-label="Transaction network"
              value={chainId}
              onChange={(e) => setChain(e.target.value as "8453" | "42161")}
            >
              <option value="8453">Base · 8453</option>
              <option value="42161">Arbitrum · 42161</option>
            </select>
          </label>
          <label className="va-field">
            Known transaction hash
            <input
              aria-label="Transaction hash"
              value={hash}
              onChange={(e) => setHash(e.target.value)}
              placeholder="0x…"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </div>
        <label className="va-consent">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => {
              setConsent(e.target.checked);
              if (!e.target.checked) {
                request.current?.abort();
                sequence.current++;
                setBusy(false);
              }
            }}
          />
          I agree to send this address and hash to the selected network’s RPC
          operators for read-only verification.
        </label>
        <div className="va-actions">
          <button
            className="button primary"
            disabled={!consent || busy || !/^0x[0-9a-fA-F]{40}$/.test(address)}
            onClick={() => void verify()}
          >
            {busy ? "Verifying…" : "Verify transaction"}
          </button>
          <button
            className="button"
            disabled={!consent || busy || !/^0x[0-9a-fA-F]{40}$/.test(address)}
            onClick={() => void verify(true)}
          >
            Verify saved imports
          </button>
        </div>
        <p className="va-scope">
          Coverage: Base and Arbitrum · imported hashes only, at their receipt
          dates. Complete transaction history is not indexed. Saved hashes are
          scoped to this address on this device and reverified before display.
          Balance scanning is separate.
        </p>
      </div>
      {error && (
        <div className="notice error" role="alert">
          {error}
          {sourceErrors.map((s) => (
            <p key={s.operator}>
              {s.operator}: {s.code}
            </p>
          ))}
        </div>
      )}
      {rows.length === 0 && (
        <div className="va-empty">
          <Icon name="clock" size={24} />
          <RowHeading>No verified imports yet</RowHeading>
          <p>
            Import a known hash to verify a transaction involving this address.
            An empty list does not mean the wallet has no history.
          </p>
        </div>
      )}
      {rows.length > 0 && (
        <p className="va-scope">
          Showing {rows.length} independently verified{" "}
          {rows.length === 1 ? "receipt" : "receipts"} for{" "}
          <bdi>{shortAddress(address)}</bdi>. Imported date range:{" "}
          {new Date(
            Math.min(...rows.map((r) => r.timestamp)),
          ).toLocaleDateString()}{" "}
          –{" "}
          {new Date(
            Math.max(...rows.map((r) => r.timestamp)),
          ).toLocaleDateString()}
          .
        </p>
      )}
      <div className="va-rows">
        {rows.map((tx) => (
          <article
            className="card va-row"
            key={`${tx.chainId}:${tx.hash}`}
            aria-label={`Verified ${tx.kind}`}
          >
            <div className="va-row-title">
              <RowHeading>{tx.kind}</RowHeading>
              <span className={tx.status === "CONFIRMED" ? "mw-ok" : "mw-warn"}>
                {tx.status} · two operators
              </span>
            </div>
            <p>
              {tx.chainId === "8453" ? "Base" : "Arbitrum"} ·{" "}
              {new Date(tx.timestamp).toLocaleString()} · block {tx.block}
            </p>
            <div className="va-amounts">
              {tx.amounts.map((a, i) => (
                <strong key={i}>
                  {a.direction === "out"
                    ? "−"
                    : a.direction === "in"
                      ? "+"
                      : "Permission: "}
                  {a.amount} {a.symbol}
                </strong>
              ))}
            </div>
            {tx.spender && (
              <p>
                Spender: <bdi>{tx.spender}</bdi>
              </p>
            )}
            {tx.deposit && (
              <p>
                Across deposit {tx.deposit.id} · {tx.deposit.origin} →{" "}
                {tx.deposit.destination}.{" "}
                {rows.some(
                  (other) =>
                    matchingBridge(tx, other) || matchingBridge(other, tx),
                )
                  ? "Source and destination receipts match this Across deposit."
                  : tx.kind === "Bridge"
                    ? "Source receipt verified; verify the destination fill separately."
                    : "Destination fill receipt verified; source correlation requires the matching source import."}
              </p>
            )}
            <a
              href={tx.explorer}
              target="_blank"
              rel="noreferrer"
              className="va-hash"
            >
              <bdi>{tx.hash}</bdi>
              <Icon name="external" size={14} />
            </a>
            <details>
              <summary>Verification sources</summary>
              <p>
                {tx.operators.join(" · ")} · {tx.confirmations} confirmations ·
                checked {new Date(tx.verifiedAt).toLocaleString()}
              </p>
              <p>
                Block hash: <bdi>{tx.blockHash}</bdi>. Policy depth is not L1
                finality.
              </p>
            </details>
          </article>
        ))}
      </div>
    </section>
  );
}
