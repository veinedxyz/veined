# Portfolio discovery and coverage (V1.11)

Goal: find what a wallet holds across networks, read-only, and say exactly what was and was not checked.
**An unchecked network is never shown as zero.**

## Modes

- **My wallet** (default once a wallet is connected through Privy): the scan starts automatically — no signature,
  no transaction, no address typing. Results arrive progressively; an account change aborts the running scan and
  drops the previous wallet's result (never merged into the new account); a disconnect stops the connected scan and
  switches to *View another address*. While the page is visible the connected wallet is refreshed every 2 minutes;
  **Refresh** is always available.
- **View another address** (watch-only): manual EVM/Solana/Bitcoin/Sui/Tron/Stellar inputs and an explicit
  *Scan balances*; never automatic.

## Coverage classes (per network)

| Class | Meaning | Token discovery |
| --- | --- | --- |
| `FULL_INDEXED` | own transfer index (witnessed windows) within lag limits | index candidates + known tokens + curated + imported; balances via live `balanceOf` |
| `CURATED_BALANCE_SCAN` | no index, but a healthy vetted RPC and a **code-hash-verified Multicall3** | curated registry contracts + imported, batch `balanceOf` |
| `ON_DEMAND` (known tokens) | token universe from routing provider/datastore | universe + curated + imported, live `balanceOf` |
| `NATIVE_ONLY` | native balance only (no verified Multicall3 / non-EVM limits) | none |
| `CATALOG_ONLY` | listed network, not checked | none — shown as *Not checked*, never zero |
| `FAILED` | read failed (RPC unavailable, timeout) | — |
| `PENDING` | not reached yet (deadline / continuation) | — |

Current balance is **always** `balanceOf` / `eth_getBalance` at an observed block — never a sum of transfer logs.

## Curated balance sweep (EVM)

- Candidate set = exact contracts from the unified registry (CANONICAL + CURATED for that chain) + routing/datastore
  universe + up to 25 imported contracts per chain (≤ 5 chains), deduplicated by chain + contract.
- Multicall3 only at `0xca11…ca11` **and** only when its runtime code hash equals
  `0xd5c15df6…770891` (checked through the vetted pool, cached per data plane for 1 h). Otherwise the chain stays
  `NATIVE_ONLY` — there is no arbitrary call target.
- Bounded: ≤ 1,000 candidates per chain (200 slots reserved for index-only candidates), batches of 200
  `balanceOf` calls, ≤ 40 aggregate calls per chain, failing batches bisected, 5 s per call, 2 MB response cap.

## Progressive all-mainnet scan

| Phase | Content |
| --- | --- |
| A | the connected wallet's chain, then chains this same wallet already holds value on (refreshes), ≤ 5 priority ids; native balances |
| B | curated fungible sweeps (`CURATED_BALANCE_SCAN`) |
| C | indexed token discoveries (`FULL_INDEXED`) |
| D | remaining healthy supported mainnets, continued by a continuation token |

Limits: 3 networks in parallel, a 20 s deadline per request, unfinished networks returned as `PENDING`, the client
continues automatically (≤ 15 rounds for the connected wallet) and then on request. Identical concurrent scans
(two tabs, double click) share one upstream scan (single-flight keyed by identity scope, continuation, priority and
extra contracts); different identities never share. UI shows checked / pending / failed / not supported counts and a
per-network class pill.

## Non-EVM

Solana, Bitcoin, Sui, Tron and Stellar keep their existing truthful coverage (native and the token standards each
reader supports); they are never presented as if they had EVM-level discovery. No new non-EVM method was added in
V1.11.

## Prices and value

- **Total known value** sums priced, non-spam holdings on mainnets only. Testnet holdings are listed but never
  valued.
- Unpriced assets stay visible and are counted (*N unpriced*); prices show their source (*via …*) and are
  informational — portfolio USD never enters route or transaction math.
- Spam/suspicious tokens are flagged (badge, optional hide, small-balance filter) and never silently deleted.
- Bridge/Swap shortcuts appear only for routable, non-flagged holdings.

## Privacy

| Data | Goes to | Notes |
| --- | --- | --- |
| Wallet address (scan) | Otherbridge server → vetted RPC endpoints of the scanned networks (`eth_getBalance`, `balanceOf` calldata) and, on indexed networks, the own datastore | that is how balances are read; no third-party portfolio API |
| Wallet address (storage) | own datastore only when configured | pseudonymized with a keyed hash (`OTHERBRIDGE_DATA_PSEUDONYM_KEY`) before storage; never plain text in logs; never a metric label |
| Token lookups / registry | `/api/assets`, DEXScreener (token contract only) | no wallet address is accepted |
| Wallet connection | Privy (connect-only) | portfolio data is never sent to Privy |
| Analytics | none | no third-party analytics |

## Tests

`tests/integration/v111-portfolio.test.ts` (curated sweep exact contracts, verified Multicall3 required, imported
bounded/deduplicated/never routable, connected chain first, class mapping), `tests/integration/v111-api.test.ts`
(single-flight, identity isolation, bounded priority/extra tokens), existing V1.4/V1.5 data-plane suites (fan-out,
deadlines, continuation, cache), `tests/e2e/v111.spec.ts` (auto scan on connect with priority, testnet excluded from
value, unpriced count, classes, account switch rescans the new account only, watch mode never auto-scans, mobile).
