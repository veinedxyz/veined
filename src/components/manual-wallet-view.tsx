"use client";
import { formatUnits } from "viem";
import { Icon } from "./icons";
import { TokenMark } from "./ocean-marks";
import { PageHeader, shortAddress } from "./ui";
import type { ManualWalletViewProps } from "./manual-wallet";
type Review = NonNullable<ManualWalletViewProps["review"]>;
type SwapReview = Extract<Review, { quoteOut: string }>;
type BridgeReview = Extract<Review, { effectiveOutput: string | null }>;
const BASE = "/networks/catalog/8453-de343bd68771b135.svg";
const ARBITRUM = "/networks/catalog/42161-35cebc7f281a5f68.svg";
const USDC =
  "/assets/tokens/8453/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913-bee26115db56cfb1.png";
const WETH =
  "/assets/tokens/1/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2-776d8eed27a7ff85.png";
const units = (n: unknown, decimals = 6) => {
  try {
    return typeof n === "string" ? formatUnits(BigInt(n), decimals) : "—";
  } catch {
    return "—";
  }
};
const percent = (n: unknown) =>
  typeof n === "number" ? `${(n / 100).toFixed(2)}%` : "—";
function Reading({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mw-reading">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
const explanations: Record<string, string> = {
  USDC_BALANCE_BELOW_AMOUNT: "Your USDC balance is below the amount required.",
  NATIVE_BALANCE_BELOW_GAS_BUDGET:
    "Your ETH balance does not cover the gas budget.",
  SIMULATION_REVERTED:
    "The transaction simulation failed. No transaction can be prepared.",
  ALLOWANCE_NOT_ZERO_BEFORE_APPROVE:
    "An existing permission needs review before this restricted route can proceed.",
  ALLOWANCE_NOT_EXACT:
    "The token permission does not match the reviewed amount.",
  APPROVAL_NOT_FINAL:
    "Wait for the permission transaction to be confirmed, then refresh the quote.",
  APPROVAL_FAILED: "The permission transaction failed. Execution is stopped.",
  OWNER_RELEASE_REQUIRED:
    "Signing is closed until the owner activates this local release.",
  WALLET_CHAIN_MISMATCH: "Switch your wallet to Base and request a new quote.",
  REVIEW_EXPIRED: "This quote expired. Refresh it before continuing.",
};
function reason(codes: string[]) {
  return codes
    .map(
      (c) =>
        explanations[c] ??
        (/NONCE|RECOVERY|UNKNOWN/.test(c)
          ? "A previous transaction needs read-only reconciliation. Sending is stopped."
          : /SPENDER|CALLDATA|PIN|CODE_CHANGED/.test(c)
            ? "The contract or transaction could not be verified. Sending is stopped."
            : /BALANCE|GAS/.test(c)
              ? "The balance or transaction fee could not be verified."
              : /OPERATOR|UNAVAILABLE|TIMEOUT/.test(c)
                ? "The network providers could not verify this request. Try a fresh quote."
                : "The safety checks did not pass. Open Security details for the findings."),
    )
    .filter((s, i, a) => a.indexOf(s) === i)
    .slice(0, 2)
    .join(" ");
}
/** Presentation only: every action enters the existing controller and server gates. */
export default function ManualWalletView(p: ManualWalletViewProps) {
  const { lane, connected, review, preparation, tracking, busy, fresh } = p;
  const swap = lane === "SWAP",
    amount = swap ? "1" : "5",
    token = swap ? "WETH" : "USDC";
  const sr = review as SwapReview | undefined,
    br = review as BridgeReview | undefined;
  const output = swap ? sr?.quoteOut : br?.effectiveOutput;
  const minimum = swap ? sr?.amountOutMinimum : br?.minimumOut;
  const spender = swap
    ? "0x2626664c2603336e57b271c5c0b26f421741e481"
    : "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";
  const provider = swap ? "Uniswap V3" : "LI.FI / Across";
  const findings = Array.from(
    new Set([
      ...(review?.problems ?? []),
      ...(review?.guardian?.findings ?? []),
    ]),
  );
  const blocked = Boolean(
    review &&
    (!review.ready || ["BLOCK", "HOLD"].includes(review.guardian?.level ?? "")),
  );
  const canRead = connected && p.chainId === 8453 && !busy;
  const allowance = review?.balances?.allowance;
  const permissionAvailable =
    typeof allowance === "string" &&
    /^\d+$/.test(allowance) &&
    BigInt(allowance) >= BigInt(swap ? 1000000 : 5000000);
  const action = !connected
    ? "connect"
    : p.chainId !== 8453
      ? "switch"
      : "execute";
  const label =
    action === "connect"
      ? "Connect Wallet"
      : action === "switch"
        ? "Switch to Base"
        : swap
          ? "Swap"
          : "Bridge";
  return (
    <section
      className="manual-wallet mw-simple"
      data-lane={swap ? "swap" : "bridge"}
      aria-label={`${swap ? "Swap" : "Bridge"} manual wallet execution`}
    >
      <header className="mw-heading">
        <p className="visual-eyebrow">
          {swap
            ? "ONE NETWORK. A CLEARER EXCHANGE."
            : "TWO NETWORKS. ONE CLEAR ROUTE."}
        </p>
        <PageHeader
          title={swap ? "Swap with clarity." : "Move across. Stay in control."}
          lede="Your amount, fee and minimum receive. Clearly in view."
        />
      </header>
      <div className="mw-simple-layout">
        <section
          className="manual-card mw-instrument"
          aria-label={swap ? "Swap order" : "Bridge order"}
        >
          <div className="mw-instrument-top">
            <h2>{swap ? "Swap" : "Bridge"}</h2>
            <span className="mw-caption">{provider}</span>
          </div>
          <div className="mw-token-field">
            <div className="mw-field-label">
              <label htmlFor={`manual-${lane}-amount`}>
                From <span>· Base</span>
              </label>
              <span>
                Balance: <bdi>{units(review?.balances?.usdc)} USDC</bdi>
              </span>
            </div>
            <div className="mw-amount-row">
              <input
                id={`manual-${lane}-amount`}
                aria-label="Exact input"
                value={`${amount}.00`}
                readOnly
                inputMode="decimal"
              />
              <div className="mw-token-identity">
                <TokenMark
                  symbol="USDC"
                  logo={USDC}
                  network={{ logo: BASE }}
                  size="lg"
                />
                <div>
                  <strong>USDC</strong>
                  <span>Base</span>
                </div>
              </div>
            </div>
          </div>
          <div className="mw-flow-divider">
            <span>
              <Icon name="arrowDown" size={17} />
            </span>
          </div>
          <div className="mw-token-field mw-receive">
            <div className="mw-field-label">
              <span>
                To <span>· {swap ? "Base" : "Arbitrum"}</span>
              </span>
              <span>
                {fresh
                  ? "Live quote"
                  : review
                    ? "Refresh required"
                    : "Expected receive"}
              </span>
            </div>
            <div className="mw-amount-row">
              <output
                role="group"
                aria-label="Expected output"
                className={output ? "mw-precise-amount" : "mw-empty-amount"}
                title={units(output, swap ? 18 : 6)}
              >
                <bdi>{units(output, swap ? 18 : 6)}</bdi>
              </output>
              <div className="mw-token-identity">
                <TokenMark
                  symbol={token}
                  logo={swap ? WETH : USDC}
                  network={{ logo: swap ? BASE : ARBITRUM }}
                  size="lg"
                />
                <div>
                  <strong>{token}</strong>
                  <span>{swap ? "Base" : "Arbitrum"}</span>
                </div>
              </div>
            </div>
          </div>
          <dl className="mw-readings mw-order-summary">
            <Reading label="Minimum received">
              <bdi>
                {units(minimum, swap ? 18 : 6)} {token}
              </bdi>
            </Reading>
            <Reading label="Estimated total fee">
              <bdi>
                {swap ? "0.0005 USDC" : `${units(br?.feeTotal)} USDC`} +{" "}
                {units(review?.gas?.worstCaseTotalWei, 18)} ETH
              </bdi>
            </Reading>
            <Reading label="Slippage limit">
              {percent(swap ? (sr?.slippageBps ?? 50) : 50)}
            </Reading>
          </dl>
          {connected && (
            <div className="manual-account">
              <Icon name="wallet" size={17} />
              <div>
                <strong>{p.walletName || "EVM wallet"} · Connected</strong>
                <span title={p.address}>
                  <bdi>{p.address ? shortAddress(p.address) : "—"}</bdi> ·{" "}
                  {p.chainId === 8453 ? "Base · 8453" : `chain ${p.chainId}`}
                </span>
              </div>
            </div>
          )}
          {review && (
            <div className="mw-essential-security" aria-label="Guardian review">
              <p
                className={blocked || !fresh ? "mw-warn" : "mw-ok"}
                role="status"
              >
                <Icon name="shield" size={15} />
                {blocked
                  ? `STOP · Guardian ${review.guardian?.level ?? "HOLD"}`
                  : !fresh
                    ? "STOP · quote expired"
                    : `READY · Guardian ${review.guardian?.level ?? "reviewed"}`}
              </p>
              {blocked && <p>{reason(findings)}</p>}
              {review.step === "APPROVE" && (
                <p className="mw-caption">
                  First use needs permission for exactly {amount} USDC, then a
                  separate {swap ? "swap" : "bridge"} confirmation in your
                  wallet. Two on-chain transactions.
                </p>
              )}
              {permissionAvailable && review.step !== "APPROVE" && (
                <p className="mw-caption">
                  Permission available. No additional approval requested.
                </p>
              )}
            </div>
          )}
          {p.error && (
            <div role="alert" className="mw-stop">
              <strong>STOP · Request could not complete</strong>
              <p>{reason([p.error])}</p>
            </div>
          )}
          <button
            className="button primary mw-main-action"
            disabled={busy || (action === "execute" && blocked)}
            aria-busy={busy}
            onClick={() =>
              action === "connect"
                ? p.onConnect()
                : action === "switch"
                  ? p.onSwitch()
                  : p.onAction(action)
            }
          >
            {label}
            <Icon
              name={action === "connect" ? "wallet" : "arrowRight"}
              size={17}
            />
          </button>
          <p className="mw-caption" role="status" aria-live="polite">
            {p.status ||
              (busy ? "Checking…" : "Your wallet confirms every transaction.")}
          </p>
          {p.hash && (
            <a className="mw-caption" href={`/scan?chain=8453&q=${p.hash}`}>
              Track transaction in Scan →
            </a>
          )}
          <div className="mw-closed">
            <Icon name="lock" size={15} />
            <div>
              <strong>Execution closed</strong>
              <span>
                Quotes and preparation only. Owner release is required to sign.
              </span>
            </div>
          </div>
          <p className="mw-caption mw-recipient">
            Recipient{!swap && " & refund"}: your connected account. {amount}{" "}
            USDC · this release supports this route only.
          </p>

          <details
            className="mw-disclosure mw-advanced"
            aria-label="Advanced details"
          >
            <summary>Details · route, fees & transaction</summary>
            <p className="mw-caption">
              Gas includes the verified L1 estimate and a conservative reserve.{" "}
              {swap
                ? "The 0.05% pool fee is included in the quote; platform fee is zero."
                : "Route fee is included in the expected output."}
            </p>
            {review && (
              <p className="mw-caption">
                Existing permission: {units(review.balances?.allowance)} USDC ·
                spender <bdi>{spender}</bdi>. No unlimited approval is
                requested.
              </p>
            )}
            <section aria-label="Provider comparison">
              <h3>Provider comparison</h3>
              <p>
                {provider} · one eligible provider for this restricted release.
              </p>
              <p>
                Base → {swap ? "Base" : "Arbitrum"} · USDC → {token}
              </p>
            </section>
            <dl className="mw-readings">
              <Reading label="Spender">
                <bdi>{spender}</bdi>
              </Reading>
              <Reading label="Account / recipient">
                <bdi>{p.address ?? "Not connected"}</bdi>
              </Reading>
              <Reading label="USDC · Base">
                <bdi>0x833589fcd6edb6e08f4c7c32d4f71b54bda02913</bdi>
              </Reading>
              <Reading label={`${token} · ${swap ? "Base" : "Arbitrum"}`}>
                <bdi>
                  {swap
                    ? "0x4200000000000000000000000000000000000006"
                    : "0xaf88d065e77c8cc2239327c5edb3a432268e5831"}
                </bdi>
              </Reading>
              <Reading label="Gas · worst case, incl. L1">
                {units(review?.gas?.worstCaseTotalWei, 18)} ETH
              </Reading>
              <Reading label="L1 fee estimate">
                {units(review?.gas?.l1FeeWei, 18)} ETH
              </Reading>
              <Reading label="Gas budget">
                {units(review?.gas?.budgetWei, 18)} ETH
              </Reading>
              <Reading label="USDC allowance">
                {units(review?.balances?.allowance)} USDC
              </Reading>
              <Reading label="Native balance">
                {units(swap ? sr?.balances?.eth : br?.balances?.native, 18)} ETH
              </Reading>
              <Reading label="Price impact">
                {swap ? percent(sr?.priceImpactBps) : "Included in route cost"}
              </Reading>
              {review && (
                <Reading label="Quote remaining">
                  {Math.max(0, Math.floor((review.expiresAt - p.now) / 1000))} s
                </Reading>
              )}
            </dl>
            {review && (
              <button
                className="button"
                disabled={!canRead}
                onClick={() => p.onAction("review")}
              >
                Refresh quote
              </button>
            )}
            {preparation && (
              <details className="mw-disclosure mw-transaction-fields">
                <summary>
                  Exact transaction ·{" "}
                  {Object.keys(preparation.transaction).length} fields
                </summary>
                <dl>
                  {Object.entries(preparation.transaction).map(([k, v]) => (
                    <Reading key={k} label={k}>
                      <bdi>{v}</bdi>
                    </Reading>
                  ))}
                </dl>
              </details>
            )}
            <button
              className="button mw-track-button"
              disabled={!canRead}
              onClick={() => p.onAction("track")}
            >
              <Icon name="refresh" size={15} />
              Check receipts, settlement & balances
            </button>
            {tracking !== undefined && (
              <section
                className="mw-receipt"
                aria-label="Receipt and settlement"
              >
                <h3>Receipt and settlement</h3>
                <pre>{JSON.stringify(tracking, null, 2)}</pre>
              </section>
            )}
            <details className="mw-disclosure">
              <summary>Complete verification record</summary>
              <pre>
                {JSON.stringify(
                  { review, preparation, hash: p.hash || undefined },
                  null,
                  2,
                )}
              </pre>
            </details>
          </details>
          <details className="mw-disclosure mw-security-details">
            <summary>Security details · Ask Guardian</summary>
            <p>
              Account, network, spender, calldata, minimum output, slippage,
              freshness and replay checks run on every transaction. BLOCK and
              HOLD stop execution. These controls cannot be turned off.
            </p>
            <p>
              Guardian is an assessment, not a guarantee. A pending or unknown
              wallet response is never resent.
            </p>
            {findings.length > 0 && (
              <ul className="mw-findings">
                {findings.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            )}
            <pre>
              {JSON.stringify(
                {
                  error: p.error || undefined,
                  guardian: review?.guardian ?? { state: "Not reviewed" },
                },
                null,
                2,
              )}
            </pre>
          </details>
        </section>
      </div>
    </section>
  );
}
