# Portfolio coverage V1.5 (current)

Tier A (FULL_INDEXED configuration) is now **Arbitrum 42161, Avalanche 43114, Ink 57073 and World Chain 480** (World Chain promoted after a bounded assessment of the top-25 routable EVM chains: two independent witness-eligible log operators, 17.5 Transfer logs/block, verified Multicall3, 21 live windows with witness MATCH; `evidence/.../witness/tier-a-assessment.json`). No other assessed chain met the bar; promotion is configuration, not code.

The Data API `index` object now reports `liveIndexedThrough`, `historicalIndexedFrom` and an `integrity` block (`FULL_INDEXED_RELEASE_ELIGIBLE` vs `FULL_INDEXED_DEVELOPMENT`, witness counts, blockers). Locally: Ink and World Chain are witness-verified (engineering-eligible; release blocked by RPC terms review); Arbitrum and Avalanche have no independent witness operator and stay `FULL_INDEXED_DEVELOPMENT`. The public UI keeps its plain wording: a paused (consensus-unresolved) index is shown as indexing/lagging, never as complete; balances are always direct reads, so a paused or lagging index never invents or hides holdings beyond its stated coverage. `historicalComplete` remains false everywhere; backward backfill extends history without claiming genesis completeness.

---

# Portfolio coverage V1.4

Measured 2026-10-04 (`evidence/otherbridge-v1-4/<run>/data/`): 348 registry chains; 155 chains with admitted, healthy vetted public RPC (220 endpoints); 97 with a verified Multicall3 runtime hash; 24,989 routable tokens in the known-token universe (66 chains).

| Tier | Chains | Token coverage |
|---|---|---|
| FULL_INDEXED | Arbitrum, Avalanche, Ink | Indexed ERC20 discovery in a recent 20,000-block window + known tokens; `historicalComplete=false` |
| ON_DEMAND_FUNGIBLE | 60 (incl. Solana) | Known/routable/previously discovered token `balanceOf`; Solana enumerates SPL/Token-2022 accounts |
| NATIVE_ONLY | 92 | Native `eth_getBalance` (+nonce) only |
| CATALOG_ONLY | 193 | Not checked; never shown as empty |

Bitcoin, Sui, Tron and Stellar identities are reported as unsupported ecosystems (CATALOG_ONLY). EVM native reads verify chain ID in the same batch; Solana uses finalized commitment and the mainnet genesis hash at admission. Native symbols for chains outside the routing catalog come from the bounded TVL-catalog gas-token symbol.

A live read-only sample of the user's previously supplied public address (redacted in evidence) checked 152 networks over two pages and found assets on 24 networks (first page 117 checked, 34 pending → continuation checked them). USD was known for 39 of 73 holdings using derived routing-list prices; the rest stay "unknown". A public contract sample observed in indexed Arbitrum Transfer logs showed 10 non-zero token balances, 5 discovered by the Otherbridge index. Indexed counts are timestamped observations, not standing guarantees.

Totals include only known, current USD values and exclude spam. Native ≥2^128 base units is treated as an RPC sentinel (`IMPLAUSIBLE_BALANCE`). Needs attention covers missing gas, route-limited/catalog-only networks, old activity and networks still indexing or pending. Nothing moves funds.

The V1.3 statement "Activity discovery caps its scan at 40 networks" and the `BLOCKED_CREDENTIAL_REQUIRED` state are superseded: there is no chain cap and no paid credential.

---

## Historical V1.3 text (superseded by V1.4, preserved verbatim)

### Portfolio coverage V1.3

The direct native adapter supports Ethereum, Base, BNB Smart Chain and Solana when the corresponding public address exists. EVM reads independently check chain ID before balance. Solana uses finalized balance and rejects unsafe numeric amounts. Native USD is null without actual price evidence.

The broad EVM token indexer adapter is implemented and tested with address/chain-bound schemas, activity discovery, spam flags and dated USD values. Live broad coverage requires `OTHERBRIDGE_PORTFOLIO_API_KEY` on the server. No key is bundled or sent to the browser. The current delivery records the actual credential and read-only observation status in V13_TEST_MATRIX.md; fixtures are never live coverage evidence.

Other ecosystems use the preserved wallet/address architecture but their portfolio indexers are unsupported in this milestone. An explicitly supplied Bitcoin/Sui/Tron/Stellar address yields an honest unsupported coverage result. Known wallets are not proof of chain indexing. Activity discovery caps its scan at 40 networks; catalog chains outside discovered/registered coverage are not asserted empty.

Totals include only known, current USD values and exclude known spam. Zero price is a measured zero; missing or conflicting price is unknown. The native gas token may have zero balance. Needs attention identifies missing native gas, old observed activity or route-limited networks; it never sends or consolidates funds.
