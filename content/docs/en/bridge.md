# Bridge

Bridging moves an asset from one network to another. {{BRAND}} shows routes from its routing provider for {{ROUTE_NETWORKS}} mainnet networks, plus verified custom routes where aggregators stop.

## Routes

- **Routing provider routes** are read through a fixed, read-only integration. A listed connection does not guarantee a quote.
- **ONEbridge (ONEchain → BNB Smart Chain)** is a custom route. Its contracts, roles, reserve and settlement were technically verified at pinned blocks (G5: {{G5_STATUS}}). That verification is point-in-time: any drift makes the route review-required again.

Mainnet and testnet networks are never combined in one route.

## Assets

Bridge is not native-only. The asset picker lists, in order: assets you hold that have a route, canonical assets, curated assets, searchable route-supported assets and — only if the route supports them — imported exact addresses.

For ONEbridge, only token pairs **registered on-chain on both chains** are listed, each confirmed through two independent sources per chain. {{ONEBRIDGE_PAIRS}} pairs are registered today; {{ONEBRIDGE_VERIFIED}} has a verified {{BRAND}} route (native ONE → CROSS). A registered pair without verification shows **No verified route** and cannot be quoted or sent. Pairs are matched by exact token addresses, never by symbol.

## The route card

The route card keeps the essentials up front: source and destination network, tokens, **You receive**, **Fee** and **Estimated time** ("Not reported" when a route does not report it). **Route details** opens the protocol, contracts, chain IDs, quote ID and exact steps.

## Route health

Route health shows one state:

| State | Meaning |
| --- | --- |
| Route ready | Every check passed and sending is enabled. |
| Needs refresh | Data or the quote is too old — refresh it. |
| Temporarily unavailable | A data source or the route itself is unavailable. |
| Sending disabled | Checks may pass, but the execution gate is closed (today's public status). |

Below it, at most three lines summarize route verification, liquidity/reserve and live data. **Safety details** opens runtime pins, authority, reserve, RPC consensus, pending/in-flight checks and the last check time.

## Fees

The review shows every fee before any wallet request: the route/network fee, gas, any provider fee and the {{BRAND}} fee ({{FEE_PERCENT}}). See [Fees](/docs/fees).

## Recipient

By default the recipient is the same wallet. **Send to another address** is an explicit choice; for a destination in a different ecosystem (for example EVM → Solana) you must enter an address of that ecosystem.

## Tracking and failures

Activity tracks transfers read-only from the source chain to the destination. If a check fails or data sources disagree, nothing is sent and the reason is shown. See [Troubleshooting](/docs/troubleshooting).

## A compact preview

The main card shows what you pay, what you receive, the fee summary and one primary next step. **Route details**, **Fee breakdown** and **Safety details** expand on demand. Slippage settings and route diagnostics live under the settings disclosure. A route preview does not execute a trade; sending stays disabled. If the quote expires, refresh it before review.
