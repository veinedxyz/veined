# RPC provenance and terms inventory (V1.5) — NOT LEGAL ADVICE

Machine-readable source: `src/data/registry/rpc-provenance.json` (schema and policy in `src/data/registry/rpc-provenance.ts`). Built by `.otherbridge/v15-build-provenance.cjs` from a bounded research pass (2026-10-04) that used only operator-owned terms/privacy pages and official chain documentation; raw research and fetched pages are in the evidence root (`rpc-terms/`). This is engineering preparation for counsel, not legal approval.

## Summary

- 165 groups covering every admitted endpoint domain (220 snapshot endpoints, 161 registrable domains, plus official Ink hosts).
- 23 operator groups researched in depth; 142 domains recorded as `UNKNOWN` ("not researched in bounded pass"; operator not established → never independent, never witness-eligible).
- Review status: 4 `APPROVED_FOR_STAGING` (official first-party public endpoints documented for public/developer use with no prohibition found: Avalanche public API, BNB Chain dataseed, Celo Forno, Unichain), 18 `LEGAL_REVIEW_REQUIRED`, 143 `UNKNOWN`, 0 `PROHIBITED`, **0 `APPROVED_FOR_RELEASE`**.
- Endpoint view (local registry, 222 endpoints): 60 `LEGAL_REVIEW_REQUIRED`, 4 `APPROVED_FOR_STAGING`, 158 `UNKNOWN`; release registry endpoints: **0** (`pnpm data:rpc:provenance`, evidence `data/rpc-provenance.json`).

## Release policy hooks (implemented)

- `reviewStatus` ∈ `APPROVED_FOR_RELEASE | APPROVED_FOR_STAGING | LEGAL_REVIEW_REQUIRED | PROHIBITED | UNKNOWN`. The schema refuses `APPROVED_FOR_RELEASE` without a `legalReviewRef` and refuses `PROHIBITED` operators as witnesses.
- Deployment profile (`registryProfile`): `release` when `OTHERBRIDGE_DEPLOYMENT_ENV=production`, or in public production (`NODE_ENV=production` + `OTHERBRIDGE_PUBLIC_DEPLOYMENT=true`) unless the deployment is explicitly `staging` **and** every configured origin/host (`OTHERBRIDGE_APP_ORIGINS`, `OTHERBRIDGE_DATA_API_HOSTS`) is non-public (`localhost`, `*.localhost`, `*.test`, `*.internal`, loopback or private addresses) — a staging marker on internet-facing hosts is a configuration error (`OTHERBRIDGE_DEPLOYMENT_ENV_STAGING_PUBLIC_HOST`) and gets `release`; an unrecognised marker is treated as `release` and reported as a configuration error. The `release` profile loads only release-approved endpoints (none today → chains degrade, nothing silently uses unapproved RPC); `staging`/`development` load everything except `PROHIBITED`.
- Tier A release eligibility additionally requires an independent pair of release-approved operators (`RPC_TERMS_NOT_APPROVED` blocker otherwise).
- `pnpm data:rpc:provenance` reports per-endpoint status and exits non-zero if a release registry entry lacks approval.

## Researched operator groups

| Operator group | Operator | Hosts | Independence key | Commercial use | Review status | Witness-eligible |
|---|---|---|---|---|---|---|
| alchemy | Alchemy Insights, Inc. | *.g.alchemy.com | — | RESTRICTED | LEGAL_REVIEW_REQUIRED | yes |
| allnodes-publicnode | Allnodes Inc. (PublicNode) | *.publicnode.com | — | NOT_STATED | LEGAL_REVIEW_REQUIRED | yes |
| ankr | Ankr Inc. | rpc.ankr.com | — | NOT_STATED | LEGAL_REVIEW_REQUIRED | yes |
| avalanche-public-api | Avalanche public API server (avax.network); site terms issue | api.avax.network | — | NOT_STATED | APPROVED_FOR_STAGING | yes |
| base-public-rpc | Base public RPC (terms by Coinbase Technologies, Inc.) | mainnet.base.org | — | RESTRICTED | LEGAL_REVIEW_REQUIRED | yes |
| bnb-chain-bsc-dataseed | BNB Chain public BSC endpoint (bnbchain.org; website terms b | bsc-dataseed.bnbchain.org | — | NOT_STATED | APPROVED_FOR_STAGING | yes |
| clabs-forno | cLabs (Forno) | forno.celo.org | — | NOT_STATED | APPROVED_FOR_STAGING | yes |
| conduit | ConduitXYZ, Inc. | *.t.conduit.xyz | — | NOT_STATED | LEGAL_REVIEW_REQUIRED | yes |
| drpc | DRPC (dRPC) | *.drpc.org | — | RESTRICTED | LEGAL_REVIEW_REQUIRED | no |
| flare-public-rpc | Flare / Songbird public RPC (flare.network; operating entity | flare-api.flare.network, songbird-api.flare.network | — | UNKNOWN | UNKNOWN | no |
| flashbots-protect | Flashbots Ltd. (Flashbots Protect RPC) | rpc.flashbots.net | — | NOT_STATED | LEGAL_REVIEW_REQUIRED | no |
| gelato | Gelato (Gelato RaaS hosted rollup RPC) | *.gelato.cloud | — | RESTRICTED | LEGAL_REVIEW_REQUIRED | yes |
| ink-rpc-gel-gelato | Gelato (per official Ink docs) on Ink-owned hostname inkonch | rpc-gel.inkonchain.com | gelato | RESTRICTED | LEGAL_REVIEW_REQUIRED | yes |
| ink-rpc-qnd-quicknode | QuickNode (per official Ink docs) on Ink-owned hostname inko | rpc-qnd.inkonchain.com | quicknode | RESTRICTED | LEGAL_REVIEW_REQUIRED | yes |
| ink-rpc-ten-tenderly | Tenderly (per official Ink docs) on Ink-owned hostname inkon | rpc-ten.inkonchain.com | tenderly | RESTRICTED | LEGAL_REVIEW_REQUIRED | yes |
| linea-public-rpc | Linea public RPC (site terms by The Linea Consortium) | rpc.linea.build | — | RESTRICTED | LEGAL_REVIEW_REQUIRED | yes |
| offchain-labs-arbitrum | Offchain Labs, Inc. (Arbitrum public RPC) | arb1.arbitrum.io, nova.arbitrum.io | — | UNKNOWN | LEGAL_REVIEW_REQUIRED | yes |
| onfinality | OnFinality Limited (New Zealand company 7714016) | *.api.onfinality.io | — | RESTRICTED | LEGAL_REVIEW_REQUIRED | yes |
| op-mainnet-public-rpc | Optimism (OP Mainnet public RPC; site terms by Optimism Foun | mainnet.optimism.io | — | RESTRICTED | LEGAL_REVIEW_REQUIRED | yes |
| quicknode | Quiknode, Inc. (dba Quicknode) | *.quiknode.pro | — | NOT_STATED | LEGAL_REVIEW_REQUIRED | yes |
| tenderly | Tenderly, Inc. | *.gateway.tenderly.co | — | RESTRICTED | LEGAL_REVIEW_REQUIRED | yes |
| thirdweb | Non-Fungible Labs, Inc. (dba thirdweb) | *.rpc.thirdweb.com | — | RESTRICTED | LEGAL_REVIEW_REQUIRED | no |
| unichain-public-rpc | Unichain public RPC (terms by Universal Navigation Inc. dba  | mainnet.unichain.org | — | NOT_STATED | APPROVED_FOR_STAGING | yes |

## Tier A official endpoints (independence)

| Chain | Official public endpoints (docs) | Independent witness operators available |
|---|---|---|
| Arbitrum 42161 | `arb1.arbitrum.io/rpc` (docs.arbitrum.io node providers); `arb1-sequencer` is send-only | **one** (Offchain Labs). PublicNode refuses unfiltered `eth_getLogs`; other keyless endpoints are aggregators/relays |
| Avalanche 43114 | `api.avax.network/ext/bc/C/rpc` (build.avax.network) | **one** (Ava Labs public API) |
| Ink 57073 | `rpc-gel` (Gelato), `rpc-qnd` (QuickNode), `rpc-ten` (Tenderly), `ink.drpc.org` (docs.inkonchain.com/tools/rpc) | **three** (Gelato, QuickNode, Tenderly); shared dependency: all on Ink-controlled DNS |
| World Chain 480 | measured: `worldchain-mainnet.g.alchemy.com/public`, `worldchain-mainnet.gateway.tenderly.co` | **two** (Alchemy, Tenderly) |

## Known uncertainty

- Arbitrum `tos`/`developer-tos` pages returned HTTP 403 (Cloudflare) during the bounded pass — counsel must read them in a browser.
- Many terms restrict bots, scraping or commercial use without saying whether keyless RPC traffic is covered.
- Some hostnames suggest a backing provider (e.g. `rpc-quicknode.*`, `rpc.blockdaemon.*`) without official confirmation; they stay `UNKNOWN` and are not treated as independent.
- BNB Chain dataseed endpoints disable `eth_getLogs` per official docs.

`pnpm data:rpc:provenance` exits non-zero when any endpoint would be admitted to the release registry (or, under the `release` profile, to the active registry) without an `APPROVED_FOR_RELEASE` group that has a legal review reference and a known operator; the check is recomputed from the raw inventory rather than from the policy function. `rpc:seed-snapshot` (unprobed import of the committed registry snapshot, used for staging) refuses to run under the `release` profile.
