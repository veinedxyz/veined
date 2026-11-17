"use client";
import Link from "next/link";
import { formatUnits } from "viem";
import { useEffect, useRef, useState } from "react";
import type { ScanRecord } from "../scan/model";
import { PageHeader, shortAddress } from "./ui";
import { Icon } from "./icons";
import "./scan-center.css";
const network = (c: string) => (c === "8453" ? "Base" : "Arbitrum");
const messages: Record<string, string> = {
  INVALID_SEARCH: "Enter a complete transaction hash or public wallet address.",
  SELECT_TRANSACTION_CHAIN:
    "Select Base or Arbitrum for this transaction hash.",
  VERIFICATION_UNAVAILABLE:
    "Network verification is unavailable. The last verified record stays visible. Try again.",
  OPERATORS_DISAGREE:
    "Network operators disagree. This transaction is not verified.",
  RATE_LIMITED: "Read limit reached. Wait a moment before trying again.",
  SCAN_LEDGER_NEEDS_ATTENTION:
    "The local transaction ledger needs review. It has not been reset.",
};
export default function ScanCenter({
  account = "",
  compact = false,
  onConnect,
}: {
  account?: string;
  compact?: boolean;
  onConnect?: () => void;
  lang?: unknown;
}) {
  const [query, setQuery] = useState("");
  const [chain, setChain] = useState("all");
  const [active, setActive] = useState<{ q: string; chain: string }>({
    q: compact ? account.toLowerCase() : "",
    chain: "all",
  });
  const [rows, setRows] = useState<ScanRecord[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [asOf, setAsOf] = useState(0);
  const [filter, setFilter] = useState("All");
  const [asset, setAsset] = useState("");
  const sequence = useRef(0),
    request = useRef<AbortController | null>(null);
  const latest = useRef(active);
  const pending = useRef(false);
  async function read(search: { q: string; chain: string }, refresh = false) {
    if (pending.current && !refresh) return;
    request.current?.abort();
    const c = new AbortController(),
      id = ++sequence.current;
    request.current = c;
    pending.current = true;
    if (refresh) setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...search, refresh }),
        signal: AbortSignal.any([c.signal, AbortSignal.timeout(25000)]),
        cache: "no-store",
      });
      const body = await response.json();
      if (c.signal.aborted || id !== sequence.current) return;
      if (!response.ok) throw Error(body.error);
      // The response's address scope must match, even when identity changed mid-request.
      const records = body.records as ScanRecord[];
      if (
        search.q.length === 42 &&
        records.some((r) => r.account !== search.q.toLowerCase())
      )
        throw Error("SCAN_ACCOUNT_BINDING");
      setRows(records);
      setAsOf(body.asOf);
      if (body.errors?.length)
        setError(messages[body.errors[0]] ?? "Local ledger unavailable.");
    } catch (e) {
      if (!c.signal.aborted && id === sequence.current)
        setError(
          messages[(e as Error).message] ??
            "Verification unavailable. Retry the read-only search.",
        );
    } finally {
      if (id === sequence.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    const initial = setTimeout(() => {
      let search = { q: compact ? account.toLowerCase() : "", chain: "all" };
      if (!compact) {
        const params = new URLSearchParams(window.location.search);
        const q = params.get("q") ?? "",
          c = params.get("chain") ?? "all";
        if (
          /^0x[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?$/.test(q) &&
          ["all", "8453", "42161"].includes(c)
        )
          search = { q: q.toLowerCase(), chain: c };
        const token = params.get("asset") ?? "";
        setAsset(["USDC", "WETH", "ETH"].includes(token) ? token : "");
        setQuery(search.q);
        setChain(search.chain);
      }
      setRows([]);
      setActive(search);
      latest.current = search;
      if (!compact || account)
        void read(search, Boolean(search.q.length === 66));
    }, 0);
    const timer = setInterval(() => {
      if (!document.hidden && (!compact || account)) void read(latest.current);
    }, 3000);
    const cancel = () => {
      request.current?.abort();
      sequence.current++;
      pending.current = false;
    };
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
      cancel();
    };
  }, [account, compact]);
  const shown = rows
    .filter(
      (r) => !asset || r.transaction?.amounts.some((a) => a.symbol === asset),
    )
    .filter(
      (r) =>
        filter === "All" ||
        (filter === "Pending"
          ? [
              "SUBMITTED",
              "PENDING",
              "UNKNOWN",
              "SOURCE_CONFIRMED",
              "FILL_PENDING",
              "REFUND_PENDING",
            ].includes(r.status)
          : filter === "Completed"
            ? ["CONFIRMED", "SETTLED_VERIFIED"].includes(r.status)
            : r.kind === filter),
    );
  function search() {
    setAsset("");
    const next = { q: query.trim().toLowerCase(), chain };
    setRows([]);
    setActive(next);
    latest.current = next;
    const params = new URLSearchParams();
    if (next.q) params.set("q", next.q);
    if (chain !== "all") params.set("chain", chain);
    window.history.replaceState(
      null,
      "",
      `/scan${params.size ? `?${params}` : ""}`,
    );
    void read(next, true);
  }
  return (
    <section
      className="scan-center"
      aria-label={compact ? "Wallet activity" : "VEINED Scan"}
    >
      <p className="visual-eyebrow">
        {compact ? "YOUR TRANSACTIONS" : "VEINED SCAN"}
      </p>
      <PageHeader
        title={compact ? "Activity." : "Follow every transaction."}
        lede={
          compact
            ? "Your wallet’s transactions and verified imports, with live status."
            : "Search a transaction or public address. Verify the chain behind it."
        }
      />
      {!compact && (
        <form
          className="sc-search card"
          aria-label="Scan search"
          onSubmit={(e) => {
            e.preventDefault();
            search();
          }}
        >
          <label className="sc-query">
            <span>Transaction hash or public wallet address</span>
            <input
              aria-label="Transaction hash or public wallet address"
              type="search"
              value={query}
              maxLength={66}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search 0x…"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="sc-chain">
            <span>Network</span>
            <select
              aria-label="Scan network"
              value={chain}
              onChange={(e) => setChain(e.target.value)}
            >
              <option value="all">Supported networks</option>
              <option value="8453">Base</option>
              <option value="42161">Arbitrum</option>
            </select>
          </label>
          <button className="button primary" disabled={busy}>
            {busy ? "Verifying…" : "Search"}
            <Icon name="arrowRight" size={17} />
          </button>
          <p className="sc-scope">
            Base & Arbitrum · Hash searches are sent to the selected network’s
            RPC operators for read-only verification. Address results cover
            VEINED records and verified imports; complete blockchain history is
            not indexed.
          </p>
        </form>
      )}
      {compact && !account ? (
        <div className="card sc-empty">
          <h2>Connect to view your activity</h2>
          <button className="button primary" onClick={onConnect}>
            Connect Wallet
          </button>
          <p>
            Or search a public address in <Link href="/scan">Scan →</Link>
          </p>
        </div>
      ) : (
        <>
          <div className="sc-list-top">
            <h2>
              {active.q.length === 66
                ? "Transaction details"
                : active.q
                  ? `Records for ${shortAddress(active.q)}`
                  : "VEINED transactions"}
            </h2>
            <span role="status">
              {asOf
                ? `Updated ${new Date(asOf).toLocaleTimeString()}`
                : "Loading…"}
            </span>
          </div>
          {compact && (
            <div
              className="segmented sc-filters"
              role="group"
              aria-label="Activity filter"
            >
              {[
                "All",
                "Swap",
                "Bridge",
                "Approval",
                "Pending",
                "Completed",
              ].map((f) => (
                <button
                  key={f}
                  aria-pressed={filter === f}
                  onClick={() => setFilter(f)}
                >
                  {f}
                </button>
              ))}
            </div>
          )}
          {error && (
            <div className="notice error" role="alert">
              {error}
              <button
                className="button"
                onClick={() => void read(active, true)}
              >
                Retry verification
              </button>
            </div>
          )}
          {!shown.length && !busy && (
            <div className="card sc-empty">
              <Icon name="clock" size={25} />
              <h3>No matching records yet</h3>
              <p>
                New VEINED submissions appear automatically. An empty result
                does not mean an address has no blockchain history.
              </p>
            </div>
          )}
          {asset && (
            <p className="sc-scope">
              Token: {asset} · verified transfer logs only.{" "}
              <button className="button" onClick={() => setAsset("")}>
                Show all tokens
              </button>
            </p>
          )}
          <div className="sc-records">
            {shown.map((r) => (
              <article
                className="card sc-record"
                key={r.id}
                aria-label={`${r.kind} ${r.status}`}
              >
                <div className="sc-record-title">
                  <h3>{r.kind}</h3>
                  <span
                    className={
                      ["CONFIRMED", "SETTLED_VERIFIED"].includes(r.status)
                        ? "mw-ok"
                        : "mw-warn"
                    }
                  >
                    {r.status.replaceAll("_", " ")}
                  </span>
                </div>
                <p className="sc-meta">
                  {network(r.chainId)} ·{" "}
                  {r.provider ??
                    (r.kind === "Destination settlement"
                      ? "Across"
                      : "On-chain receipt")}{" "}
                  ·{" "}
                  {new Date(
                    r.transaction?.timestamp ?? r.observedAt,
                  ).toLocaleString()}
                </p>
                <p className="sc-origin">
                  {r.provenance === "HISTORICAL_IMPORT"
                    ? "Historical import · no claim of wallet ownership or VEINED UI submission"
                    : r.provenance === "VEINED_SUBMISSION"
                      ? "Automatically recorded VEINED wallet submission"
                      : "Public hash lookup · sender derived from chain"}
                </p>
                {r.transaction?.amounts.length ? (
                  <p className="sc-amounts">
                    {r.transaction.amounts.map((a, i) => (
                      <strong key={i}>
                        {a.direction === "out"
                          ? "−"
                          : a.direction === "in"
                            ? "+"
                            : "Permission: "}
                        {a.amount} {a.symbol}{" "}
                      </strong>
                    ))}
                  </p>
                ) : (
                  <p className="sc-meta">Amounts await chain verification.</p>
                )}
                {r.sourceStatus && (
                  <p className="sc-meta">
                    SOURCE CONFIRMED · destination{" "}
                    {r.status === "SETTLED_VERIFIED"
                      ? "verified"
                      : "is tracked separately"}
                  </p>
                )}
                {r.hash ? (
                  <Link
                    className="sc-hash"
                    href={`/scan?chain=${r.chainId}&q=${r.hash}`}
                    onClick={() => {
                      if (!compact) {
                        setQuery(r.hash!);
                        setChain(r.chainId);
                        setActive({ q: r.hash!, chain: r.chainId });
                        latest.current = { q: r.hash!, chain: r.chainId };
                        void read({ q: r.hash!, chain: r.chainId }, true);
                      }
                    }}
                  >
                    <bdi>{r.hash}</bdi>
                    <Icon name="arrowRight" size={14} />
                  </Link>
                ) : (
                  <p className="sc-meta">
                    Wallet response unknown · no automatic resend.
                  </p>
                )}
                {r.error && (
                  <p className="mw-warn">
                    Verification unavailable · last observation retained
                  </p>
                )}
                {!compact && (
                  <details className="sc-details" open={active.q.length === 66}>
                    <summary>Transaction & verification details</summary>
                    <dl>
                      <div>
                        <dt>Sender</dt>
                        <dd>
                          <bdi>{r.transaction?.from ?? r.account}</bdi>
                        </dd>
                      </div>
                      <div>
                        <dt>Recipient / contract</dt>
                        <dd>
                          <bdi>
                            {r.transaction?.to ?? r.recipient ?? "Unverified"}
                          </bdi>
                        </dd>
                      </div>
                      <div>
                        <dt>Gas used</dt>
                        <dd>{r.transaction?.gas?.gasUsed ?? "Unavailable"}</dd>
                      </div>
                      <div>
                        <dt>Total chain fee</dt>
                        <dd>
                          {r.transaction?.gas?.totalFeeWei
                            ? `${formatUnits(BigInt(r.transaction.gas.totalFeeWei), 18)} ETH`
                            : "Unavailable · no estimate substituted"}
                        </dd>
                      </div>
                      <div>
                        <dt>Block</dt>
                        <dd>{r.transaction?.block ?? "Pending"}</dd>
                      </div>
                      <div>
                        <dt>Verification</dt>
                        <dd>
                          {r.transaction
                            ? `${r.transaction.operators.join(" · ")} · ${r.transaction.confirmations} confirmations`
                            : "Awaiting two-operator receipt verification"}
                        </dd>
                      </div>
                      <div>
                        <dt>Finality</dt>
                        <dd>
                          Policy confirmation depth; not a claim of L1 finality.
                        </dd>
                      </div>
                      <div>
                        <dt>Last verified</dt>
                        <dd>
                          {r.transaction
                            ? new Date(
                                r.transaction.verifiedAt,
                              ).toLocaleString()
                            : "Pending"}
                        </dd>
                      </div>
                    </dl>
                    {r.transaction && (
                      <a
                        href={r.transaction.explorer}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open chain explorer
                      </a>
                    )}
                    {(r.sourceHash || r.destinationHash) && (
                      <p>
                        Linked receipt:{" "}
                        <Link
                          href={`/scan?chain=${r.sourceHash ? "8453" : "42161"}&q=${r.sourceHash ?? r.destinationHash}`}
                        >
                          <bdi>{r.sourceHash ?? r.destinationHash}</bdi>
                        </Link>
                      </p>
                    )}
                    {r.tracking && (
                      <details>
                        <summary>Complete reconciliation record</summary>
                        <pre>{JSON.stringify(r.tracking, null, 2)}</pre>
                      </details>
                    )}
                  </details>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
