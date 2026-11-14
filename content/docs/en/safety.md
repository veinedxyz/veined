# Safety

{{BRAND}} is designed to fail closed and to say what it checked. It does not claim to be safe, trustless or audited.

## Non-custodial

Your keys stay in your wallet. {{BRAND}} never holds funds, never asks for a seed phrase and cannot move assets on its own. Connecting a wallet asks for no signature.

## Transaction firewall

Before any wallet request, the exact transaction is checked against independently re-read state: chain, contract, function, amount, fees, recipient, value and gas limits. A single mismatch stops the flow. The firewall is also tested with mutated transactions that must all be rejected.

## Simulation

Where the route allows it, the exact transaction is simulated (`eth_call` and gas estimation) on two independent endpoints before review, including negative controls that must fail.

## Runtime drift

Bridge contracts are pinned: implementation code hashes, admin and validator roles, pauses, thresholds and registered pairs. Any change after the pinned blocks makes the route review-required instead of silently continuing.

## RPC consensus

Critical state is read from **two independent sources** (different operator groups) and must agree. For BNB Smart Chain, {{BRAND}} uses a canonical **common finalized pin**: the highest finalized block that both sources can serve, with the identical block hash, no older than {{BSC_PIN_MAX_AGE}} seconds. If one source lags, another vetted independent source can take its place; if no independent pair agrees, the check stops with "Safety check needs another attempt" and no wallet request is made. A hash disagreement at a finalized height always stops.

## Trust assumptions

- **ONEbridge**: settlement and upgrades are controlled by externally owned accounts — a single admin and a 2-of-3 validator set at the pinned blocks. That is a centralized trust assumption, shown in Safety details.
- **Routing provider**: quotes and steps come from a third-party router; {{BRAND}} checks that every step uses a tool from the current catalog, but the router's contracts are its own.
- **Data sources**: public RPC endpoints, market and DEX sources can be wrong or late; {{BRAND}} cross-checks the critical ones and labels the rest.

## Approvals

The public app requests no token approvals or permits today (sending is {{SENDING}}). When a route needs an approval, the review lists the spender and the exact amount — never an unlimited approval by default.

## Token and logo safety

Tokens are identified by exact contract; symbol look-alikes, invisible characters and link-like names are flagged. Logos are never loaded from third parties by your browser: they are fetched server-side, decoded, re-encoded without metadata and served from {{BRAND}}'s own domain. SVG and HTML disguised as images are rejected.
