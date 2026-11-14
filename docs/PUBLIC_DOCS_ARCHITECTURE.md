# Public docs architecture (V1.11)

## Decision: English + Turkish are the canonical documentation languages

The **app** keeps all 24 locales. The **documentation** is written and reviewed in English and Turkish only:
technical safety text machine-filled into 22 more languages would be low quality and hard to keep correct.
Visitors whose app language is another locale read the English docs with a visible note
(`docs.languageNote`, translated in all 24 locales). This decision is stated in the docs themselves
(*Start here → Documentation languages*). More languages can be added per page when a reviewed translation exists.

## Pipeline

- Sources: `content/docs/en/<slug>.md` and `content/docs/tr/<slug>.md` — 11 pages each: `start`, `portfolio`,
  `bridge`, `swap`, `networks`, `safety`, `data`, `fees`, `developers`, `troubleshooting`, `glossary`
  (`src/docs/pages.ts`).
- `pnpm docs:build` compiles them into `src/docs/content.generated.ts` (plain strings, no runtime file access);
  `pnpm docs:check` fails when the generated module is stale.
- Rendering: `src/docs/markdown.tsx`, a small server-side renderer for the subset used (headings with stable unique
  ids, paragraphs, emphasis, inline code, code blocks, lists, tables, quotes, links). It never emits raw HTML:
  tags/event handlers become text; links are limited to same-site paths, `#anchors` and `https:` (javascript:/data:/
  protocol-relative render as text); external links get `rel="noopener noreferrer external"`.
- Live constants: `{{FEE_PERCENT}}`, `{{FEE_BPS}}`, `{{G5_STATUS}}`, `{{SENDING}}`, `{{LOCALES}}`, `{{MAINNETS}}`,
  `{{TESTNETS}}`, `{{CHAINS}}`, `{{CHAIN_LOGOS}}`, `{{ROUTE_NETWORKS}}`, `{{CURATED}}`, `{{CANONICAL}}`,
  `{{ONEBRIDGE_PAIRS}}`, `{{ONEBRIDGE_VERIFIED}}`, `{{BSC_PIN_MAX_AGE}}` are substituted at render time from the
  product's own modules (`src/docs/constants.ts`); an unknown token throws (`UNKNOWN_DOC_CONSTANT`). Docs can't drift
  from the fee policy, G5 status, execution gate, registries or the G7 pin policy.
- Search: `docs-search.tsx` (the only client component on docs pages) filters a server-built index (one entry per
  section of the current language). Plain text comparison only — no regex, no HTML; results are same-site anchors.

## Sections covered

Start here (what Otherbridge is, product status, connecting a wallet, documentation languages) · Portfolio (auto
scan, watch address, coverage classes, token levels, prices) · Bridge (routes, assets/pairs, fees, tracking,
failures) · Swap (token discovery, curated/imported, slippage, routing, alternate recipient) · Networks
(mainnet/testnet, catalog, coverage, logos) · Safety (non-custodial, firewall, simulation, runtime drift, RPC
consensus, trust assumptions, approvals) · Data (self-hosted Data API, indexer, coverage tiers, privacy, sources and
attribution) · Fees (Otherbridge fee, provider/network fee) · Developers (API, OpenAPI, keys/scopes, rate limits) ·
Troubleshooting (wrong network, stale quote, RPC unavailable, partial portfolio, "Safety check needs another
attempt") · Glossary.

## Consistency tests

`tests/unit/v111-docs-site.test.ts`: renderer never emits HTML; link policy; every page exists in EN and TR and
the generated module matches the Markdown; constants come from the product (fee policy, G5 status, execution
gate, G7 pin policy); every token resolves; no stale or overclaiming statements (e.g. a stale "G5 BLOCKED", "100 %
safe", "trustless", "audited", "guaranteed"); social links hidden when unset; indexing opt-in; landing/docs import
graph free of wallet/portfolio/routing/firewall/G7 code. E2E (`tests/e2e/v111.spec.ts`): navigation (11 pages),
search, markup-as-text search input, 404 for unknown pages, 390 px layout, TR native docs vs. English with a note
for other locales, no financial API or wallet traffic.
