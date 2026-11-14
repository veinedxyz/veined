# Wallet scan streaming (V1.14.2)

Wire schema: `src/portfolio/stream.ts` (browser-safe; shared by the route, the client, tests and the harness). Route:
`src/app/api/portfolio/route.ts`. Client reader: `src/components/wallet-stream.ts`. Tests: unit "wallet stream",
integration "progressive stream" / "app route", E2E `tests/e2e/v1142.spec.ts`.

## Negotiation

A request with `Accept: application/x-ndjson` receives `Content-Type: application/x-ndjson; charset=utf-8`; any other
client receives the accepted V1.11 JSON `PortfolioResult` (same round). The response starts only after the plan
exists, so a rejected identity / cursor / body still gets its HTTP status (422) instead of a stream.

## Lines (strict; unknown types and extra fields are rejected on both ends)

| Line | Meaning | Provisional? |
| --- | --- | --- |
| `plan` | `v`, `continued`, every scheduled network with its wave and reasons, the terminal coverage of unscheduled networks, the first-page size / deadline / chain budget, the planned DeFi networks | — |
| `native` | a confirmed nonzero native balance of a network whose token reads are still running (native fast path) | yes — replaced by that network's `chain` line |
| `chain` | the exact result of one network (holdings, coverage, receipt coverage) — or its `FAILED` coverage | yes — replaced by `result` |
| `firstPage` | the first-page rule fired (reason, elapsed, included, outstanding) | — |
| `defiReady` | the DeFi start trigger fired (reason, elapsed) | — |
| `result` | the complete reconciled round (`PortfolioResult`) + the scheduler receipt (chain-level only) | **final** |
| `error` | `SCAN_FAILED`, `INVALID_CONTINUATION`, … | final |

The server validates every line with `parseWalletLine` before it is written (an invalid line is never sent) and the
`result` line with `resultLineSchema`. The client validates every line again.

## Reconciliation

`applyWalletLine` / `progressiveResult`:

* one `chain` line per network; a repeated line replaces, never adds;
* a `native` line is shown only while its network has no `chain` line; a late `native` line never replaces an exact
  result; a line for a network outside the plan is ignored;
* every planned network without a `chain` line is `PENDING` (never empty); terminal coverage comes from the plan;
* the `result` line replaces the whole provisional view (`mergePortfolio` for continuation rounds, as accepted).

The integration test reconstructs the provisional view from every streamed line and proves it equals the final round
(holdings, values, coverage states, summary).

## Client rendering

* Coalescing: lines are applied immediately to the provisional state; renders are coalesced to one per 200 ms. The
  plan, the first meaningful asset, the first page and the DeFi start render at once. Each render records one
  `otherbridge:walletFlush` User Timing mark (render census).
* A refresh of the same identity keeps the previous complete result (with its observation time and stale marker) until
  the new first page exists — no flash back to "all pending".
* Stable order: while a scan streams, asset and network rows keep their position between milestones (plan, first page,
  final); new rows join below; the full value sort applies at the next milestone.
* Phase line (connect card): "Scanning N priority networks…" → "Scanning remaining networks…" in a `role="status"`
  element that changes only at those milestones; the counts ("N assets found · c/p networks checked") are a sibling,
  not a live region. The coverage sentence's `aria-live` is `off` while a stream runs and `polite` again for the final
  round. Not colour-only (text + icon).
* Timing receipts (User Timing, scoped to one scan of one identity, cleared on every new scan):
  `walletShellReadyMs` (plan), `firstMeaningfulAssetMs`, `firstPageCompleteMs`, `fullWalletCoverageMs`, plus the
  accepted `walletFirstResultMs` (= first page), `firstDefiResultMs`, `fullDefiScanMs`.

## Identity safety

Account change, disconnect, address edit and mode switch abort the request, bump the client sequence and clear the
result, the DeFi gate, the phase and the stable order. Every line and every coalesced render checks the sequence, so a
late line of the previous identity can never render (E2E "account switch mid-stream", "disconnect mid-stream").

## Multi-tab single flight

Identical requests (identity scope, cursor, priority, imported contracts, hints, refresh flag) share one scan. The
flight records its validated lines; a second NDJSON request replays them and follows the same scan; a JSON request
awaits the round. Different wallets never share a flight (the key carries the keyed identity scope).
