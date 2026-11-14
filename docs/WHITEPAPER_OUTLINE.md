# Otherbridge whitepaper — outline only

**Status: DEFERRED_UNTIL_SCOPE_STABLE.** No polished whitepaper is written in V1.11. This outline lists, per
section, the factual sources that exist today, the decisions still open, the metrics that must be measured and the
prerequisites before anything is published. Nothing here is a product claim.

## 1. Abstract
- Sources: `README.md`, `docs/V111_PRODUCT_COMPLETION.md`, landing copy (`landing` i18n namespace).
- Open: final positioning (portfolio-first vs. routing-first); naming of the self-hosted data offering.
- Metrics: none until sections 4–9 are measured.
- Prerequisites: all sections below resolved; legal review (§20).

## 2. Problem
- Sources: owner problem list (V1.11 goal), network reach (`docs/NETWORK_ENVIRONMENTS.md`), coverage truth
  (`docs/PORTFOLIO_DISCOVERY_COVERAGE.md`).
- Open: which user segments; evidence for "difficult networks" beyond ONEchain.
- Metrics: share of TVL-catalog networks without aggregator routes; portfolio blind spots of existing tools.
- Prerequisites: user research or published third-party data with sources.

## 3. Product vision
- Sources: "Find assets → understand coverage → bridge → swap" flow; landing sections.
- Open: roadmap scope (§19); gas feeder (§16) in or out.
- Metrics: activation funnel (requires a privacy-preserving analytics decision — none today).
- Prerequisites: stable scope; analytics policy.

## 4. Portfolio discovery
- Sources: `docs/PORTFOLIO_DISCOVERY_COVERAGE.md`, `src/data/portfolio/provider.ts`, V1.4/V1.5 data-plane docs.
- Open: more `FULL_INDEXED` networks; non-EVM token standards; price source policy.
- Metrics: per-network coverage class distribution; scan latency p50/p95; RPC calls per scan.
- Prerequisites: production data-plane deployment with witness consensus; RPC terms review.

## 5. Network / asset registry
- Sources: `docs/CHAIN_IDENTITY_COVERAGE.md`, `docs/ASSET_REGISTRY.md`, `docs/ASSET_PROVENANCE.md`.
- Open: sync cadence; registry governance (who curates); MANTRA 5887 conflict resolution.
- Metrics: logo coverage, curated counts, false-positive impersonation rate.
- Prerequisites: legal review of logo/listing reuse (LEGAL_REVIEW_REQUIRED items).

## 6. Bridge
- Sources: `docs/G5_FINAL_EVIDENCE.md`, `src/assets/onebridge-pairs.generated.json`, route-details UI.
- Open: ONEbridge USDTx route verification; additional custom routes.
- Metrics: verified pairs; quote freshness; settlement tracking accuracy.
- Prerequisites: G7 owner pilot result; external review of ONEbridge trust model.

## 7. Swap
- Sources: `docs/ASSET_REGISTRY.md` (ranking, import), routing provider integration.
- Open: provider diversity; slippage defaults.
- Metrics: quote success rate; price impact distribution.
- Prerequisites: execution release approval (sending disabled today).

## 8. Data plane
- Sources: V1.4/V1.5 docs (`docs/INDEXER_LOG_CONSENSUS.md`, data API OpenAPI), migrations 0001–0003.
- Open: hosting model; retention; public API pricing (if any).
- Metrics: indexer lag, consensus disputes, API latency.
- Prerequisites: production deployment, backups, monitoring.

## 9. Routing
- Sources: `src/routing/*`, catalog snapshot, `docs/NETWORK_ENVIRONMENTS.md`.
- Open: multi-provider routing; route ranking policy.
- Metrics: route availability per network pair.
- Prerequisites: provider terms review.

## 10. Security
- Sources: `docs/SECURITY.md`, `docs/TRANSACTION_FIREWALL_SPEC.md`, `docs/G7_RPC_CONSENSUS_RELIABILITY.md`,
  `docs/TOKEN_IMPORT_SECURITY.md`, CSP docs.
- Open: independent audit scope.
- Metrics: none can be claimed before an audit.
- Prerequisites: **independent security audit (not performed)**; pentest; firewall review.

## 11. Trust assumptions
- Sources: Safety details UI (authority, reserve, runtime pins), G5 evidence.
- Open: how to present validator/admin key risk quantitatively.
- Metrics: validator set size/threshold over time; reserve coverage.
- Prerequisites: verified reserve semantics; operator disclosures.

## 12. Non-custodial boundaries
- Sources: wallet layer (Privy connect-only), execution gate, `docs/SECURITY.md`.
- Open: wording reviewed by counsel.
- Metrics: n/a.
- Prerequisites: legal review.

## 13. Fees / economics
- Sources: `src/routing/fee-policy.ts` (0 bps today), docs Fees page.
- Open: any future fee model.
- Metrics: n/a until a fee exists.
- Prerequisites: business and legal decision; fee collection remains 0.

## 14. Developer API
- Sources: data API OpenAPI, docs Developers page.
- Open: public availability, keys and plans.
- Metrics: request volume, error rates.
- Prerequisites: production deployment and terms.

## 15. Network expansion
- Sources: TVL catalog, chain identity registry.
- Open: selection criteria for new indexed networks and custom routes.
- Metrics: coverage gain per added network.
- Prerequisites: vetted RPC operators per network.

## 16. Future gas feeder
- Sources: none implemented.
- Open: whether to build it at all; custody implications.
- Metrics: n/a.
- Prerequisites: design, security and legal review before any mention as a feature.

## 17. Operations / governance
- Sources: `docs/RUNBOOK.md`, handoff documents.
- Open: release governance, incident response, key management.
- Metrics: uptime, incident counts.
- Prerequisites: operational runbooks exercised.

## 18. Risks
- Sources: remaining-blocker lists in handoff/EXECUTION_STATE, LEGAL_REVIEW_REQUIRED items.
- Open: risk register ownership.
- Metrics: n/a.
- Prerequisites: complete register reviewed by owner and counsel.

## 19. Roadmap
- Sources: milestone history (V1.0–V1.11).
- Open: dates and scope; nothing should be promised.
- Metrics: n/a.
- Prerequisites: stable scope.

## 20. Legal
- Sources: `docs/ASSET_PROVENANCE.md` terms inventory.
- Open: jurisdiction, terms of use, privacy policy, trademark use.
- Metrics: n/a.
- Prerequisites: counsel review of every LEGAL_REVIEW_REQUIRED item.

## 21. Evidence / source map
- Sources: `evidence/otherbridge-v1-*/` run directories, review bundle manifests (per-entry SHA-256).
- Open: public evidence publication policy (redaction).
- Metrics: n/a.
- Prerequisites: redaction review; stable evidence format.


## V1.13 source map (whitepaper remains deferred)

Portfolio V2 sources: DEFI_POSITION_MODEL, DEFI_ADAPTER_ARCHITECTURE, DEFI_PROTOCOL_COVERAGE, DEFI_VALUATION, DEFI_RISK_METRICS, DEFI_DISCOVERY, DEFI_PRIVACY. Eight adapter categories use explainable accounting; non-EVM, broad protocol families, full V3 fees, complete discovery history and Morpho production oracle metrics remain explicitly limited. Read-only, no billing or execution launch.
