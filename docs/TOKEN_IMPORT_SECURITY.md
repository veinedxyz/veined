# Token address import security (V1.11)

Flow (Swap/Bridge token picker → `POST /api/assets {action:"preview"}` → `previewImport` in
`src/assets/registry.ts`). Nothing is imported until the user presses **Import token**; nothing imported ever
routes without route support.

## Steps (each shown to the user with its result)

| # | Step | Check | Failure |
| --- | --- | --- | --- |
| 1 | Address | strict `0x` + 40 hex; checksummed for display | `INVALID_ADDRESS` → not importable |
| 2 | Contract code | `eth_getCode` through the vetted data-plane RPC pool (6 s, 200 kB cap) | `NO_CONTRACT_CODE` / `RPC_UNAVAILABLE` → not importable |
| 3 | ERC-20 metadata | `decimals/symbol/name` via verified Multicall3 or direct read; decimals ≤ 36; text cleaned (`displayText`, length caps 32/120) | `NOT_AN_ERC20_TOKEN` → not importable |
| 4 | Curated registry | exact chain + contract | shown as evidence |
| 5 | Market listing | exact CoinGecko platform + contract (snapshot) | evidence only |
| 6 | DEX liquidity | DEXScreener exact chain + token (cached, budgeted) | evidence only; `< $10k` → `LOW_LIQUIDITY` |
| 7 | Logo | Trust Wallet exact checksummed path → DEXScreener image → monogram; server-side sanitized, served as `/api/asset-image/<sha256>` | monogram |
| 8 | Route support | exact address in the route list | `NO_VERIFIED_ROUTE` → importable but never selectable/routable |
| 9 | Import | explicit button; stored on this device only | — |

Default level after import: **`IMPORTED_UNVERIFIED`** (market/DEX evidence never upgrades it). If the exact contract
is already curated/canonical, the registry level is shown instead.

## Warnings and blocks

- `BIDI_OR_INVISIBLE` (bidi controls, zero-width, BOM in name/symbol) or `MIXED_SCRIPT` (e.g. Latin + Cyrillic
  look-alikes in the symbol) → **BLOCKED**, the Import button is disabled.
- `SYMBOL_IMPERSONATION` (same symbol as a canonical/curated token with another contract), `URL_IN_TEXT`
  ("claim", "airdrop", domains), `LONG_TEXT`, `METADATA_MISMATCH` (registry or DEX symbol/decimals differ),
  `NO_MARKET_EVIDENCE`, `LOW_LIQUIDITY` → visible warnings; never auto-selected.

## Abuse limits

- `/api/assets`: strict zod schema (chain id digits only, query ≤ 80 chars, exact address), bounded body,
  same-origin guard, 90 requests/min per client; **preview: 12/min** separately (it costs RPC + DEX calls).
- No wallet address is accepted by the endpoint (strict schema rejects extra fields).
- Local-test mode: preview refuses (`LOCAL_TEST_MODE_NO_LOOKUP`) and lists carry no route data (hermetic tests).
- Images: HTTPS + approved host + public DNS pinned per hop + ≤ 3 redirects + 600 kB cap + magic-byte sniffing +
  HTML/SVG reject + full PNG decode/re-encode (bounded inflate, dimension cap, metadata stripped) + WebP rebuild;
  content-addressed in-memory cache (400 entries / 24 MB) — a poisoned upstream cannot replace bytes under an
  existing id.

## Client storage

`otherbridge:imported-tokens:<chain>` (localStorage): exact lowercase address + display metadata + optional
same-origin logo path. Re-validated on every read (address regex, length caps, logo path allow-list
`/api/asset-image/<64 hex>` or `/assets/...`); malformed entries are dropped. Imported contracts may be passed to the
portfolio scan as bounded extra candidates (≤ 25 per chain, ≤ 5 chains) — they are read with `balanceOf` only.

## Tests

`tests/unit/v111-image-security.test.ts` (SSRF, redirects, DNS rebinding, decompression bomb, malformed PNG/CRC,
SVG script, HTML as image, metadata stripping, dimension cap, cache poisoning), `tests/unit/v111-registry.test.ts`
(symbol collision, wrong-chain contract, bidi/homoglyph, huge name/symbol, ranking, auto-selection),
`tests/integration/v111-api.test.ts` (strict schema, IMPORTED_UNVERIFIED default, NO_CONTRACT_CODE, preview rate
limit, local-test hermetic, DEX-discovered search, image route headers), `tests/e2e/v111.spec.ts` (import flow,
blocked impersonation import, unroutable imported row not selectable).
