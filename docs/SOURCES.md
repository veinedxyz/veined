# Sources and live observations

1 October 2026 historical inventory; the initial observations below belong to the earlier delivery. All 40 URLs in Master Appendix A/B were inventoried. HTTP200 is not a full content review or live readiness. The current R1 evidence and its relationship to the missing build are in [R1_READONLY_EVIDENCE](R1_READONLY_EVIDENCE.md); the dynamic token/bridge surface and the whitepapers were not used in place of the deployment ABI.

## Critical findings

- A07 README: the canonical BSC Cross/CROSS address and the special ONE/CROSS mechanism between reserves. An on-chain read confirmed name=Cross, symbol=CROSS, decimals=18 and the presence of code.
- A08 generic bridge README/API: native sentinel address(1), empty extraData, exact msg.value. This behavior was not considered to carry over to the live native ONE deployment. Reviewed generic interface commit 3a8347cd005d00e50af9194204a55da69f96ddfc.
- B01/B02 SDK 1.4.2 npm metadata MIT, React19/wagmi2–3/query5 peers; the documentation requires an owned CROSS/Reown project ID. The SDK was not installed; there is no borrowed ID.
- Public pair/chain-info GET 200 via the official legacy B04a endpoint source: a candidate native ONE 612055 → CROSS BSC56 route was found. The ONE RPC was selected from chain-info and the BSC RPC [from the official BNB Chain source](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/); the keyed BSC RPC URL in the API was not copied or used. Evidence chain-info keyed paths are redacted.
- 2026-10-01T11:18:00Z (14:18 Istanbul) live probe: chain IDs 612055/56, token code4338bytes, proxy code163bytes. Source proxy 0xb81d6e000000000000000000000000000000c0de, source implementation 0x2827865ad5330faf855af8b743c701ae9c818034. Destination proxy 0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5, implementation 0xac7b8ffed19d670930b8caa0693189b33454e8d8. These are observations; they are not an audit/code-match.
- The [ONEchain explorer source contract](https://explorer.onechain.nexus/612055/address/0xb81d6e000000000000000000000000000000c0de) showed the address as Cross Bridge. BscScan contract code web access 403; no bypass was performed. Source/destination public sample matching, finality, spendable reserve and live quote/limit/pause evidence were not completed. The total balance was not counted as usable reserve.
- The A13 audit scope was not verified against the deployment/commit; no audit badge was granted. A14–A18 are a commercial/historical context inventory; they were not converted into new token/grant/onramp scope.
- Next16.3.8 bundle AGENTS generator files were preserved; the bundled layouts/pages, route-handlers, CSP and devIndicators guides were reviewed. The EIP1193/6963/3085/3326 standards are the basis of the selected injected connection. The viem encode/decode and Playwright APIs were verified on the installed version with type/build/browser.

## Source inventory

| ID | URL | Status | HTTP / access |
|---|---|---|---|
| A01 | [source](https://www.onechain.nexus/gametoken/tokens) | partially accessed — access/inventory only; not a full content review | 200 |
| A02 | [source](https://www.onechain.nexus/gametoken/bridge) | partially accessed — access/inventory only; not a full content review | 200 |
| A03 | [source](https://www.onechain.nexus/gametoken/faq) | partially accessed — access/inventory only; not a full content review | 200 |
| A04 | [source](https://explorer.onechain.nexus/612055) | partially accessed — access/inventory only; not a full content review | 200 |
| A05 | [source](https://www.onechain.nexus/skills/) | partially accessed — access/inventory only; not a full content review | 200 |
| A06 | [source](https://github.com/to-nexus) | partially accessed — access/inventory only; not a full content review | 200 |
| A07 | [source](https://github.com/to-nexus/cross-token) | read — V1-relevant sections | 200 |
| A08 | [source](https://github.com/to-nexus/bridge-contracts) | read — V1-relevant sections | 200 |
| A09 | [source](https://github.com/orgs/to-nexus/repositories?type=all) | partially accessed — access/inventory only; not a full content review | 200 |
| A10 | [source](https://github.com/to-nexus/cross-ramp-token-preset-contracts) | partially accessed — access/inventory only; not a full content review | 200 |
| A11 | [source](https://explorer.onechain.nexus/612055/tokens) | partially accessed — access/inventory only; not a full content review | 200 |
| A12 | [source](https://explorer.onechain.nexus/612055/token/0xfeed00000000000000000000000000000000c0de) | partially accessed — access/inventory only; not a full content review | 200 |
| A13 | [source](https://skynet.certik.com/projects/one) | partially accessed — access/inventory only; not a full content review | 200 |
| A14 | [source](https://blog.opengamefoundation.org/) | not accessible | 403 |
| A15 | [source](https://www.ogfcorp.com/) | partially accessed — access/inventory only; not a full content review | 200 |
| A16 | [source](https://contents.crosstoken.io/white-paper/ONE_Whitepaper_V2.0_072026.pdf) | partially accessed — access/inventory only; not a full content review | 200 |
| A17 | [source](https://contents.crosstoken.io/white-paper/260713_WhitePaper_ONE_Token_OGF_BVI_Ltd_VG_EN_ID_3557280.xhtml) | partially accessed — access/inventory only; not a full content review | 200 |
| A18 | [source](https://contents.crosstoken.io/white-paper/CROSS_White_Paper_v1.0.pdf) | partially accessed — access/inventory only; not a full content review | 200 |
| A19 | [source](https://docs.onechain.nexus/docs/dev_chain) | read — V1-relevant sections | 200 |
| A20 | [source](https://docs.onechain.nexus/docs/bridge) | partially accessed — access/inventory only; not a full content review | 200 |
| A21 | [source](https://docs.onechain.nexus/docs/bridge-in-crossx) | partially accessed — access/inventory only; not a full content review | 200 |
| A22 | [source](https://docs.onechain.nexus/docs/dev_getting-started) | partially accessed — access/inventory only; not a full content review | 200 |
| B01 | [source](https://docs.onechain.nexus/docs/app-launcher-getting-started) | read — V1-relevant sections | 200 |
| B02 | [source](https://docs.onechain.nexus/docs/app-launcher-features) | read — V1-relevant sections | 200 |
| B03 | [source](https://docs.onechain.nexus/docs/one-explorer) | partially accessed — access/inventory only; not a full content review | 200 |
| B04 | [source](https://github.com/to-nexus/skill-cross-crossd) | partially accessed — access/inventory only; not a full content review | 200 |
| B04a | [source](https://github.com/to-nexus/skill-cross-crossd/blob/main/skills/cross-crossd/scripts/_api.mjs) | read — V1-relevant sections | 200 |
| B05 | [source](https://eips.ethereum.org/EIPS/eip-6963) | read — V1-relevant sections | 200 |
| B06 | [source](https://eips.ethereum.org/EIPS/eip-1193) | read — V1-relevant sections | 200 |
| B07 | [source](https://eips.ethereum.org/EIPS/eip-3085) | read — V1-relevant sections | 200 |
| B08 | [source](https://eips.ethereum.org/EIPS/eip-3326) | read — V1-relevant sections | 200 |
| B09 | [source](https://wagmi.sh/react/guides/connect-wallet) | partially accessed — access/inventory only; not a full content review | 200 |
| B10 | [source](https://viem.sh/docs/contract/simulateContract) | partially accessed — access/inventory only; not a full content review | 200 |
| B11 | [source](https://viem.sh/docs/actions/public/waitForTransactionReceipt) | partially accessed — access/inventory only; not a full content review | 200 |
| B12 | [source](https://playwright.dev/docs/test-assertions) | partially accessed — access/inventory only; not a full content review | 200 |
| B13 | [source](https://nextjs.org/docs/app/getting-started/installation) | read — V1-relevant sections | 200 |
| B14 | [source](https://docs.onechain.nexus/llms.txt) | partially accessed — access/inventory only; not a full content review | 200 |
| B15 | [source](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex) | partially accessed — access/inventory only; not a full content review | 200 |
| B16 | [source](https://developers.openai.com/api/docs/models/gpt-6.1-sol) | partially accessed — access/inventory only; not a full content review | 200 |
| B17 | [source](https://developers.openai.com/codex/security/) | not accessible | unreachable |

The actual observation times are in source-inventory.json; public API, repo and chain evidence are kept separate. G5: BLOCKED. MAINNET_E2E: NOT_RUN.
