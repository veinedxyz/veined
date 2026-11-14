# V1.20 test matrix

Evidence root: `evidence/veined-v1-20/20261025T110040038Z/`. The source-bound final results live in `final/`; this matrix defines each gate and identifies its real evidence, without predeclaring uncompleted checks as passes.

| Gate                        | Required verification / evidence                                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preservation                | Exact starting checkpoint `f5b41238f2a8ca31e12090e8481f527c2294288309c2013c85ff59623c588e4b`; original source copy; Git/stash/locks in `preflight/`                                                   |
| Protected source            | 107 byte-identical files; active baseline SHA-256 `cf7025aeeedac022b8ffa08540ed88345e561d23b50f05ae794f3f5dec1991b4`; no rebaseline                                                                   |
| Format / types              | Repository formatting, lint, actual Next type generation and TypeScript check                                                                                                                         |
| Unit / integration / DB     | Floors 1647 / 356 / 38; initial core result is 1670 / 356 / 38, including 23 new brand tests; 28 further test-isolation cases pass independently; frozen result must preserve all cases               |
| E2E                         | 336 discovered tests: 332 existing plus four V1.20 brand/hydration tests; two complete independent chunked sequences, zero retries/skips/flakes/missing/duplicates                                    |
| Test isolation              | Development fixtures use explicit loopback origin 3126; production smoke/i18n use test origin 3127; occupied ports are refused; production CSP/origin source and 107 protected files remain unchanged |
| G7                          | Standalone 11 and in-product 15, safety, pilot safety, artifacts and offline fork replay; protected source unchanged                                                                                  |
| Assets                      | SVG inert-subset validation, real path geometry, required dimensions, ICO frames, maskable safe zone, deterministic SHA-256 manifest; `brand/`                                                        |
| Gallery                     | 360/390/768/1440/1920px; three alternatives, local downloads, keyboard skip link, axe/CSP/overflow/broken image checks                                                                                |
| Product UI                  | Ten routes × five widths × two themes × EN/TR/AR = 300 normal-motion cases; four primary routes across that same 30-cell matrix = 120 reduced-motion cases                                            |
| Interactions                | Shared logo labels, theme changes without geometry shift, unmirrored RTL, keyboard access, Portfolio typing after hydration; scripted safe lab interactions                                           |
| Accessibility / security    | Zero axe and CSP violations, zero broken images/overflow, no browser errors; dedicated production security checks                                                                                     |
| Locales                     | All 24 locale schemas and production-rendered locale checks; EN/TR and RTL browser matrix; no new translation key                                                                                     |
| Performance                 | Exact accepted V1.19 unthrottled harness for before/after; three samples per route/width; Portfolio target within 50ms of 184/176ms; separate CDP slower-mobile evidence                              |
| Financial equality          | 317 domain files unchanged; paired wallet/DeFi/oracle runs; economic digests and oracle equality in `regression/financial/`                                                                           |
| Build / frozen reproduction | Root and provider frozen-lockfile install in a new source copy; complete mandatory gates, production build/smoke and independent E2E sequence 2; whole source stable                                  |
| Packaging                   | New source checkpoint, delta inventory, archive SHA-256, per-entry hashes, CRC, no duplicate paths, no known secrets or old review ZIPs                                                               |

Every synthetic wallet, provider and RPC fixture is test-only. Mock transaction-shaped calls do not represent real execution. Real wallet prompts, signatures, approvals, permits, broadcasts, transfers, fee collection, commits, pushes and deployments remain zero. The platform fee remains 0 bps and execution stays CLOSED.

The 22 noncanonical machine-assisted locale translations retain their existing human linguistic review requirement before public release. Owner logo approval, trademark/legal clearance and independent external audit are outside these engineering checks.
