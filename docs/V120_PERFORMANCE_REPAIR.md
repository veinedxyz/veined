# V1.20 Portfolio performance repair

Run: `evidence/veined-v1-20/20261025T110040038Z/`. These are local laboratory measurements, not field Core Web Vitals or physical-device benchmarks.

## Cause and implementation

V1.19 mounted Portfolio through a client-only dynamic boundary. Its meaningful first view waited for the component chunk, then a decorative image became the LCP candidate. Desktop fetched the 1280px, 82,232-byte derivative; mobile fetched the 640px, 28,222-byte derivative.

`src/components/product.tsx` now permits the Portfolio dynamic component's initial view to render on the server while retaining its separate client chunk. Financial data still uses the unchanged client flow. `PortfolioAtmosphere` paints a 640×360, 15,994-byte WebP derivative of the same accepted artwork, with explicit dimensions, eager loading, ordinary fetch priority and asynchronous decoding. Existing dark/light opacity (0.22/0.08) and composition remain. Original images are untouched. `scripts/v120-portfolio-asset.mjs` reproduces the derivative and provenance.

The improvement comes principally from meaningful server HTML and a smaller decorative resource. The image is not hidden from measurement and the LCP observer is unchanged. A real hydration input race discovered during diagnosis was repaired by disabling input, mode buttons and Scan until React is ready. No financial calculation, provider rule, address validation or timeout changed.

## Final paired unthrottled results

Both sides use the unchanged `scripts/v119-browser.mjs`, the same frozen fixture and Chromium version, production previews, three sequential fresh contexts per route/viewport and the same pre-scroll settled cutoff. These final pairs ran after sequence 1 completed, without another VEINED test workload in parallel. HTTP browser cache is disabled by routing; OS/server cache is not purged. Other applications can still affect host scheduling.

| Portfolio viewport | Historical V1.18 | Historical V1.19 | Final V1.19 baseline | Final V1.20 | V1.20 samples  |
| ------------------ | ---------------: | ---------------: | -------------------: | ----------: | -------------- |
| 1440px             |            184ms |            344ms |                176ms |    **84ms** | 76 / 84 / 96ms |
| 390px              |            176ms |            340ms |                176ms |    **84ms** | 84 / 88 / 64ms |

The requested V1.18+50ms ceilings are 234/226ms. Final measured reductions are 52.3% desktop and 52.3% mobile. Portfolio after CLS is 0/0 at the two widths. Other routes' nonzero CLS and timing samples remain visible in the complete reports; this is not a claim that every interaction has zero shift.

Final baseline samples: desktop 336 / 168 / 176ms; mobile 340 / 176 / 172ms. Raw samples, resource records, medians and comparisons are in `perf-final/performance/`. Harness hashes and browser versions are retained in both phase reports. The earlier diagnostic pair (276→112ms desktop and 236→72ms mobile) remains in the run's original `performance/` directory; final acceptance uses the new pair above.

## Simulated slower mobile

The final `mobile-confirmed/` pair uses the same `scripts/v120-browser.mjs` hash and fixture: 390px at DPR 1, CDP 150ms latency, 1.6Mbps download, 750Kbps upload and 4× CPU slowdown. Three fresh-context samples per route; no physical-device or field-INP claim.

Portfolio median LCP: **2984→940ms** (68.5% reduction). Before samples: 3000 / 2984 / 2952ms; after: 940 / 944 / 932ms. Portfolio CLS: **0.012241796875000002→0**. The /app control median is **1084→976ms**.

Earlier diagnostic mobile measurements remain under `mobile/` and `mobile-final/`; they are not substituted into this final pair. The observer also records resource bytes, initial/lazy JavaScript, frame intervals, soft navigation and trusted click-to-two-frame latency. The last is laboratory click latency, **not field INP**. No measurement cutoff or test timeout was increased to obtain these results.

## Visual and functional verification

The accepted `qa-accepted/after/ui-report.json` has **420/420** unique passes: 300 normal-motion and 120 reduced-motion cases, five widths, both themes and EN/TR/AR; axe/CSP/broken images/browser errors are zero. Sixteen filled-state interaction checks also pass. `qa-final/` preserves the earlier 360px header overflow; compact control spacing repaired it while retaining the 148px minimum lockup. Before/after header captures are in `brand/headers/`.

The dedicated hydration test holds script loading, verifies visible meaningful HTML and disabled form controls, then verifies typing after hydration. Eleven production-preview diagnostic tests pass, including the previously failing progressive Portfolio cases. Original financial rendering assertions remain intact. Complete E2E stability and frozen reproduction are separate mandatory gates; performance does not waive them.
