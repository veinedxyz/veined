# V1.18 test matrix

Measured outcomes, attempts and repair history are in the run evidence and final Turkish report; this document
defines acceptance and does not predeclare a pass.

| Gate | Required evidence |
| --- | --- |
| Baseline | HEAD, dirty/staged/untracked/stash, both lock hashes, V1.17 checkpoint, active protected pointer |
| Unit / integration / DB | At least 1609 / 356 / 38 original suite passes plus new brand checks |
| E2E | At least 320 unique original passes; deterministic six chunks, no duplicate counting or hidden retries |
| G7 | Existing safety suites, standalone 11 and in-product 15; no protected changes |
| Financial | Existing wallet/DeFi economic oracles, swap decode/simulation and offline fork/replay |
| Metadata | Production-rendered titles/canonical/OG/Twitter, manifest, robots, sitemap and icon HTTP checks |
| Localization | All 24 schemas, unchanged keys/placeholders, VEINED untranslated, EN/TR plus ar/fa/he/ur RTL |
| Browser | 360/390/768/1440, dark/light, EN/TR/RTL, all required public pages, error and closed review |
| Accessibility / security | Zero axe/CSP violations, no private/old-brand/social leakage |
| Performance | Same accepted app/landing/docs budgets; before/after gzip and lazy chunk delta; existing timing suites |
| Safety | verify:safety, g7:safety, g7:pilot:safety, 107/107 byte-identical, execution closed, fee 0 |
| Preservation | Historical evidence, locks, API contracts and economic source hashes unchanged |
| Reproduction | Source snapshot, frozen root/provider install, complete checks, stable final checkpoint |
| Archive | SHA-256, per-entry hashes, CRC, duplicate paths, secret scan, excluded sensitive files |

Test-only wallets and transaction fixtures are synthetic; mock calls are not real execution counters.
Failures remain preserved under their original attempt directory. Retry success is reported separately.
The 22 machine-assisted noncanonical locale translations still require human linguistic review before public release.
