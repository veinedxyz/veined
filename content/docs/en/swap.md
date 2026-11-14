# Swap

Swap exchanges one token for another on the same network. Quotes and reviews are read-only today (sending is {{SENDING}}).

## Token discovery

The token picker never shows a raw dump of every token a router knows. Its default list, in order:

1. tokens you hold on this network that have a route;
2. the native asset and canonical tokens;
3. curated tokens;
4. market-listed tokens from the registry;
5. your recent and imported tokens.

Rows show the logo, symbol, name, network, your balance and value, and a source label. A token without a route on this network shows **No verified route** and cannot be selected.

## Token levels

| Level | What it means | What it does not mean |
| --- | --- | --- |
| Canonical | The network's native asset, or a token of a protocol-canonical route (for example a registered ONEbridge pair). | Not a guarantee of the protocol. |
| Curated | The exact network + contract is in the {{BRAND}} curated registry: Trust Wallet's curated list and the routing provider agree on contract and decimals. | Not "safe" or "audited". |
| Market listed | The exact platform + contract is listed on a market source (CoinGecko). | Not "safe", not "audited". |
| DEX discovered | DEX pair evidence exists for the exact network + contract (DEXScreener). | Not "verified"; boosts or profiles mean nothing for safety. |
| Imported · unverified | You imported the exact address yourself. | No curated evidence at all. |
| Blocked | Spam, scam pattern, malformed metadata or policy. | Never selectable. |

There are {{CURATED}} curated and {{CANONICAL}} canonical assets in the registry today.

## Search

- **Name or symbol**: curated matches come first, then exact market listings from the route list. A symbol is never selected automatically, and a token reusing a curated token's symbol with a different contract is flagged.
- **Exact address**: the registry, the route list, on-chain metadata, CoinGecko (exact contract) and DEXScreener (exact address) are checked.

## Importing a token

Paste the exact contract address. {{BRAND}} then checks, in order: address format, contract code on chain, ERC-20 metadata, the curated registry, an exact market listing, DEX liquidity and price, a logo (downloaded and re-encoded server-side, never loaded from a third party by your browser) and route support. It shows warnings and the evidence, and only **Import token** adds it — to this device's list only, as **Imported · unverified**.

An imported token can be swapped or bridged **only** where the route supports that exact address.

## Slippage and routing

Slippage (0.5%, 1% or 3%) and the route preference (higher receive amount or shorter time) are under the settings line. The quote is bound to every input: changing the amount, token, recipient, slippage or wallet invalidates it.

## Recipient

**From** is your connected wallet. **Recipient** is the same wallet unless you choose **Send to another address**, which shows the address field and a warning in the review.

## Swap details

The summary shows the rate, what you receive, the route/network fee, gas, price impact and the quote age. **Route details** opens the steps and protocols, the minimum received and the execution checks.

## A compact preview

The main card shows what you pay, what you receive, the fee summary and one primary next step. **Route details**, **Fee breakdown** and **Safety details** expand on demand. Slippage settings and route diagnostics live under the settings disclosure. A route preview does not execute a trade; sending stays disabled. If the quote expires, refresh it before review.

## Provider comparison

Swap compares checked same-network provider routes progressively. Select a quote to keep your choice; a better later route is a suggestion. Quotes refresh while the page is active. Changing network, token, mint, amount, wallet or slippage clears the old review. Expired quotes, excessive price impact, unsupported transactions and failed economic simulation cannot be reviewed.

Solana supports exact mint import with read-only on-chain owner/decimals checks. Imported tokens and mints remain unverified. Provider access may need server credentials; an unavailable provider never counts as a participant. Network, priority, account-creation and provider fees are disclosed separately when known. Unknown costs remain unknown. {{BRAND}} fee is zero.

Review shows the exact route and validation result. Sending is closed: no approval, signature or transaction is requested. Saved Activity previews describe a read-only intention, not a completed trade.
