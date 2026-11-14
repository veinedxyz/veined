# Portfolio

The portfolio finds balances for an address across supported networks. It is **read-only**: no signature, no transaction, no approval.

## Auto scan

When a wallet is connected, **My wallet** scans it automatically:

- the network your wallet is on is scanned first, then networks where you already hold assets, then the remaining healthy mainnets;
- results arrive progressively; the scan continues until every planned network has an answer or a clear status;
- changing the account or disconnecting cancels the running scan and clears the previous account's results;
- while the page is open, the scan refreshes every two minutes; **Refresh** runs it immediately.

Requests run with bounded concurrency and per-network timeouts; a slow network becomes **pending** instead of slowing everything else down. Two tabs scanning the same wallet at the same time share one scan.

## View another address

**View another address** scans any address you paste (EVM, and where supported Solana, Bitcoin, Sui, Tron and Stellar). It is watch-only: nothing about that address is stored as an account.

## Coverage

Every network gets exactly one coverage class:

| Class | Meaning |
| --- | --- |
| Full index | {{BRAND}} indexes this network itself; token transfers reveal candidates, balances are read live with `balanceOf`. |
| Curated balance scan | Native balance plus an exact `balanceOf` sweep of the curated token registry through a verified Multicall3 contract. |
| Known tokens | Native balance plus the token universe {{BRAND}} knows for this network. |
| Native only | Only the native balance could be read. |
| Not checked (catalog) | No healthy vetted data source — the network is listed but not checked. |
| Check failed | The data source answered with an error; try again later. |
| Pending | Not answered yet. |

Balances are always read live; {{BRAND}} never computes a balance by adding up transfers. Testnets are never scanned for value. Bitcoin, Sui, Tron and Stellar addresses are listed as not checked unless a vetted read method exists for them — they are never shown with EVM-level coverage.

## Token levels

Tokens carry the same levels everywhere in the app: **Canonical** (native assets and protocol route tokens), **Curated**, **Market listed**, **DEX discovered**, **Imported · unverified** and **Blocked**. A level describes evidence, not safety. See [Swap](/docs/swap#token-levels).

## Prices

- The headline is **Total known value**: the sum of assets with a known price. Assets without a price stay visible and are counted as **unpriced**.
- Prices are informational. They carry their source and observation time, and they **never** enter route or transaction math.
- Testnet assets never count toward the total.

## Spam and dust

Suspicious tokens (for example a symbol copied from a curated token, links in the name, or invisible characters) are flagged and excluded from the total. Small balances can be filtered. Nothing is ever deleted silently: toggle **Spam** or **Small balances** to see everything.

## Bridge and Swap from the portfolio

Bridge and Swap buttons appear only for assets with a route on a mainnet network, and never for suspicious or unverified tokens.

## Wallet and DeFi

Choose **All assets**, **Wallet** or **DeFi** to filter the asset table. Known asset value is split into wallet and DeFi balances. Borrowing is shown separately and never added to the asset total. This is **not net worth**; unknown debt prices and unchecked protocols can make the view incomplete.

The read-only scan now checks 43 exact receipt/debt token contracts on Ethereum, Base, Arbitrum, Optimism and Polygon: selected Aave V3 reserves (lending and variable borrowing), Ethereum Lido stETH/wstETH (staking) and sDAI (vault shares). These are bounded balance checks, not complete protocol account discovery. Amounts remain in receipt/debt token units; the app does not estimate underlying conversions, yield or health factors. Logos and prices match the exact chain and contract. No price means the position remains visible as unpriced.

**Protocol coverage** reports the number of successfully read contracts in each chain/protocol/category. A successful zero is checked; failed or missing reads are not zero. Pending scans continue with the wallet scan. LP/NFT positions, restaking, claimable rewards, other protocols and other reserves remain **not checked**. A wallet-token scan marked complete does not imply complete DeFi coverage.

Sources: [pinned Aave address book](https://github.com/aave-dao/aave-address-book/tree/e5bed1f0b32279b3f3259708b0a3b0fa29c058fc) and [Lido deployments](https://docs.lido.fi/deployed-contracts/). No RPC allowlist expansion; existing pinned-block balanceOf reads and verified Multicall are reused.


## DeFi intelligence

[Positions](/docs/portfolio/defi) · [Coverage](/docs/portfolio/coverage) · [Risk metrics](/docs/portfolio/risk)

