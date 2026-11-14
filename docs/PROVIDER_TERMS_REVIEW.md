# Provider terms review

TECHNICALLY_REVIEWED means source/transport behavior was inspected. It does not mean OWNER_ACCEPTED or EXTERNAL_COUNSEL_ACCEPTED. Every unresolved legal interpretation remains LEGAL_REVIEW_REQUIRED. Vendor credential restrictions may additionally be BLOCKED_VENDOR_ONBOARDING.

| Provider | Reference / terms starting point | API/SDK license evidence | Commercial, attribution, fees, data and onboarding questions | State |
|---|---|---|---|---|
| Uniswap | https://developers.uniswap.org ; https://app.uniswap.org/terms-of-service | uniswapx-sdk MIT; locked SBOM and source-specific licenses | API commercial agreement, attribution, quota, provider fees, quote-address/IP retention; dedicated key | LEGAL_REVIEW_REQUIRED |
| Pancake Smart | https://developer.pancakeswap.finance ; https://pancakeswap.finance/terms-of-service | smart-router/swap SDK declarations in SBOM; some NOT_DECLARED | Resolve undeclared licenses, commercial redistribution, attribution, RPC terms | LEGAL_REVIEW_REQUIRED |
| PCSX | https://developer.pancakeswap.finance/contracts/pcsx/overview | pcsx-sdk license declaration absent in accepted inventory | Anonymous access is not legal approval; integrator agreement/quota, fee/order data use | LEGAL_REVIEW_REQUIRED |
| Aerodrome | https://github.com/aerodrome-finance/contracts | Per-source SPDX/license and pinned revision | Contract/source license, attribution, Base RPC terms, fee disclosure | LEGAL_REVIEW_REQUIRED |
| Slipstream | https://github.com/aerodrome-finance/slipstream | Per-source SPDX/license and pinned revision | Check commercial/source obligations; do not infer from Aerodrome classic | LEGAL_REVIEW_REQUIRED |
| Jupiter | https://developers.jup.ag | SDK/API separate; platform agreement requires owner review | Team/key agreement, Swap scope, firewall, provider fee rules, vendor logs/retention | LEGAL_REVIEW_REQUIRED |
| Titan | https://github.com/Titan-Pathfinder/titan-sdk-ts | SDK MIT; API service terms separate | Endpoint/token onboarding, quota, streaming data, retention and fee rules | LEGAL_REVIEW_REQUIRED |

Quota facts are documented in PROVIDER_PRODUCTION_ONBOARDING.md; provider fees are displayed separately from the immutable Otherbridge 0 bps platform fee. These URLs are review references, not signed contractual acceptance. No vendor was contacted and no legal agreement was accepted by this run.
