# Start here

{{BRAND}} helps you **find where your assets are**, **move them across difficult networks** and **swap them where you need them**. It is a non-custodial interface: your wallet holds your keys and signs; {{BRAND}} reads public data and prepares what your wallet will review.

## What {{BRAND}} is

- **Portfolio discovery** across many networks, with honest coverage: every network is shown as checked, pending, failed or not supported. An unchecked network is never shown as zero.
- **Bridge** routes between networks, including verified custom routes for networks most aggregators do not cover (today: ONEchain → BNB Smart Chain over ONEbridge).
- **Swap** on a single network with tokens identified by exact contract address — never by symbol.
- **Self-hosted data**: vetted RPC endpoints, an own index on selected networks and a Data API.

## Product status

> Sending is **{{SENDING}}** in the public app today. Routes, quotes and reviews are read-only. Every send control says so, and the global execution gate stays closed until the release gates are passed.

| Area | Status today |
| --- | --- |
| Portfolio scan | Read-only, available |
| Bridge quotes and review | Read-only, available |
| Swap quotes and review | Read-only, available |
| ONEchain → BSC route verification (G5) | {{G5_STATUS}} (point-in-time technical verification) |
| Sending, approvals, permits | {{SENDING}} |
| {{BRAND}} fee | {{FEE_PERCENT}} |

## Connect a wallet

1. Open the app with **Launch App** and choose **Connect wallet**.
2. Pick your wallet. Connecting is connect-only: it asks for **no signature** and **no transaction**.
3. Your portfolio starts scanning automatically (read-only). Changing the account or disconnecting stops that scan; nothing from one account is ever merged into another.

You can also read quotes or view a portfolio for any address without connecting: choose **View another address** in Portfolio, or type an address where a quote needs one.

## Documentation languages

The app is available in {{LOCALES}} languages. The documentation is written in **English and Turkish**, which are its canonical languages. Technical documentation is not machine-filled into every app language, because an inaccurate safety explanation is worse than none. Other app languages show the English documentation.

## Where to go next

- [Portfolio](/docs/portfolio) — scanning, coverage and prices
- [Bridge](/docs/bridge) — routes, assets, fees and tracking
- [Swap](/docs/swap) — token discovery and imports
- [Safety](/docs/safety) — what {{BRAND}} checks and what you still trust
