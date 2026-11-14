# VEINED — Multichain Portfolio, Swap & Bridge

## VEINED Guardian (NEAR HACKATHON, AI Security & Defense)

Guardian is VEINED's intelligence and defense layer. It reads an action before it is signed and returns
**ALLOW / WARN / ESCALATE / BLOCK** with reasons and a safe path. It covers swaps, bridges, NEAR transactions,
NEP-366 meta transactions, NEP-413 messages and AI-agent proposals. Verdicts come from deterministic rules and
carry a reproducible digest.

Built on NEAR:
- NEAR Intents: dry quotes toward NEAR
- NEAR accounts and access keys, with on-chain checks
- Chain Signatures: a request is prepared only after Guardian allows the action
- NEAR AI Cloud: optional TEE narration

**Team:** solo project by **Coinisan** (team size 1). NEAR payout account `veined.near`; `veinedxyz.near` is a test account. AI coding assistants were used during development (allowed by the rules, Q-005); the developer reviewed, tested and is responsible for the code.

Start with [HACKATHON.md](HACKATHON.md). It has run steps, a do X → see Y demo, the API and tests. Then read
[architecture](docs/guardian/ARCHITECTURE.md) and the [submission draft](docs/guardian/SUBMISSION.md).

Current public candidate identity: **VEINED**. Historical engineering identity: Otherbridge.
Local development review only; production execution stays **CLOSED**, platform fee **0 bps**.

Discover wallet assets and supported DeFi positions, compare swap quotes, discover bridge routes,
and explore network coverage. Coverage and execution limits remain visible in the product.

The planned domain is `veined.xyz`; this is not a live-origin or ownership verification.
X: [@Veinedxyz](https://x.com/Veinedxyz). The wordmark and text icons are provisional; final assets, legal clearance,
production origin/Privy setup, independent audit and release approval remain owner actions.

Local preview: `node scripts/v118-preview.mjs build`, then `node scripts/v118-preview.mjs start`.
Open http://127.0.0.1:3101 and stop with Ctrl+C. See [V1.18 implementation](docs/V118_REBRAND_IMPLEMENTATION.md),
[brand identity](docs/VEINED_BRAND_CANONICAL.md), [compatibility](docs/VEINED_TECHNICAL_COMPATIBILITY.md)
and [test matrix](docs/V118_TEST_MATRIX.md). API routes, SDK identifiers, storage keys and protected source remain stable.

## Historical engineering archive (V1.0–V1.17)

The following original README is preserved verbatim for release continuity. Its milestone statuses,
product name and capability descriptions are historical; use the V1.18 documents for the current candidate.

<!-- BEGIN V117 CURRENT -->
# Otherbridge V1.17 external gate closure — EXECUTION_CLOSED

Current owner packet: release/OWNER_GATE_PACK.md and release/EXTERNAL_GATES.json. See docs/V117_EXTERNAL_GATE_CLOSURE.md for provider, domain/Privy/hosting/RPC/Whirlpool and independent audit/pentest/legal handoffs. All16 V1.16 blocker IDs are preserved; no external approval or production release is self-certified. Final acceptance/checkpoint/test/ZIP results are generated in evidence/otherbridge-v1-17/20261015T175758204Z-8120f0/final/FINAL_REPORT_TR.md after verification. Commands: pnpm release:credentials:check and pnpm release:external-gates (expected incomplete exit2).

The immutable V1.16 audit base and packages remain referenced by hash. Protected107 unchanged; no rebaseline. Execution CLOSED, global kill ON, fee0bps. Real wallet/signature/approval/permit/broadcast/deploy/fee and DNS mutations remain0. Earlier milestone records below remain preserved.
<!-- END V117 CURRENT -->

---

<!-- BEGIN V116 CURRENT -->
# Otherbridge V1.16 release candidate — EXECUTION_CLOSED

Current candidate: OTHERBRIDGE_RC_V1_16_20261015T133159055Z-16dfa3. Authoritative status is generated after complete verification in evidence/otherbridge-v1-16/20261015T133159055Z-16dfa3/final/FINAL_REPORT_TR.md and release/FINAL_GATE_STATUS.json. See docs/V116_RELEASE_CANDIDATE.md, audit/AUDITOR_REPRODUCTION.md and OWNER_RELEASE_ACTIONS.md. Neither this source document nor prior milestone status constitutes production permission. Final source/build and archive manifests bind the exact candidate. Historical records below remain preserved.

107 protected files and accepted pointer are unchanged; no owner rebaseline. Execution CLOSED, global kill ON, fee 0 bps. Real wallet prompts/signatures/approvals/permits/broadcasts/deploys/fees remain zero. Independent audit, legal approval, domain/dashboard control and production credentials remain external.
<!-- END V116 CURRENT -->

---

# Otherbridge V1.11 — ürün tamamlama (güncel)

V1.14.1 DeFi tarama performansı ve kapsam sağlamlaştırma (salt okunur): [rapor ve doküman dizini](docs/V1141_DEFI_PERFORMANCE_HARDENING.md) · [performans](docs/DEFI_PERFORMANCE.md) · [istek bütçesi](docs/DEFI_REQUEST_BUDGET.md) · [önbellek politikası](docs/DEFI_CACHE_POLICY.md) · [test matrisi](docs/V1141_TEST_MATRIX.md).

Ürün akışı: **varlıkları bul → kapsamı anla → bridge → swap**. Yeni rotalar: `/` herkese açık landing, `/docs`
herkese açık dokümantasyon (EN + TR kanonik), uygulama `/bridge` ile başlar (`/swap`, `/portfolio`, `/activity`,
`/networks`, `/help` korunur). Ağ ortamları (mainnet/testnet) ayrıldı, kanonik zincir kimlik kaydı ve birleşik varlık
kaydı (tam ağ + kontrat; sembol asla kimlik değildir) eklendi, portföy bağlı cüzdanı otomatik ve salt okunur tarar
(küratörlü bakiye taraması doğrulanmış Multicall3 ile), G7 BSC okumaları bağımsız iki operatörün ortak finalized
pin'ini kullanır. Gönderim kapalıdır; gerçek imza/onay/yayın/deploy/ücret tahsilatı yoktur.

Rapor: docs/V111_PRODUCT_COMPLETION.md · test matrisi: docs/V111_TEST_MATRIX.md · G7: docs/G7_RPC_CONSENSUS_RELIABILITY.md ·
kayıtlar: docs/CHAIN_IDENTITY_COVERAGE.md, docs/ASSET_REGISTRY.md, docs/ASSET_PROVENANCE.md · portföy:
docs/PORTFOLIO_DISCOVERY_COVERAGE.md · landing/docs: docs/LANDING_ARCHITECTURE.md, docs/PUBLIC_DOCS_ARCHITECTURE.md.

Kayıt senkronizasyonu (yalnız okuma, salt sunucu tarafı): `pnpm assets:sync:all` (veya tek tek `assets:sync:chains`,
`:trustwallet`, `:routing`, `:coingecko`, `:dexscreener`, `:onebridge`), ardından `pnpm assets:build`,
`pnpm assets:verify`, `pnpm assets:coverage`. Dokümantasyon: `pnpm docs:build` / `pnpm docs:check`. G7 kuru kabul:
`pnpm g7:dry-acceptance --sessions 10 --pause-ms 45000 --family <evidence-alt-dizini>` (cüzdan gönderimi bastırılır).
İsteğe bağlı ortam değişkenleri (tanımsızsa gizli/noindex): `OTHERBRIDGE_PUBLIC_ORIGIN`, `OTHERBRIDGE_PUBLIC_INDEXING`,
`OTHERBRIDGE_SOCIAL_X|GITHUB|TELEGRAM|DISCORD`, `OTHERBRIDGE_DOCS_URL`, `OTHERBRIDGE_STATUS_URL`; senkronizasyon için
`COINGECKO_API_KEY`/`COINGECKO_API_PLAN` (zorunlu değil). Production ready değildir.

---

# Otherbridge V1.4 — self-hosted data plane (güncel)

Portfolio artık Otherbridge'in kendi veri düzlemini kullanır: vetted RPC registry + health, ERC20 indexer (reorg güvenli checkpoint), PostgreSQL store, sürümlü salt-okunur `/v1` Data API (yerel, yayınlanmadı, billing kapalı). Ücretli portfolio anahtarı ve 40 ağ sınırı kaldırıldı; kontrol edilmeyen ağ asla boş sayılmaz. Mimari: docs/DATA_PLANE_ARCHITECTURE.md; kapsam: docs/PORTFOLIO_COVERAGE.md; çalıştırma: docs/RUNBOOK.md; denetim: docs/OPUS_FINAL_AUDIT.md; test matrisi: docs/V14_TEST_MATRIX.md. Veri düzlemi olmadan UI çalışmaya devam eder (DEGRADED/UNAVAILABLE açıkça gösterilir).

---

# Güncel multichain incelemesi

Otherbridge multichain foundation salt okunur inceleme kapsamındadır. Gönderim/sign/approve/broadcast/deploy kapalı, ONEbridge G5 BLOCKED. Mevcut V1/R1 uygulaması korunur. Güncel checkpoint ve tüm gerçek sonuçlar OTHERBRIDGE_V1_HANDOFF.md dosyasında; dinamik ağ/route mimarisi docs/MULTICHAIN_ARCHITECTURE.md ve test matrisi docs/MULTICHAIN_TEST_MATRIX.md içindedir.

Kurulum: Node 24 + pnpm 11.25.0, `pnpm install --frozen-lockfile`, `pnpm dev` (127.0.0.1:3100). Production preview `pnpm build`, `pnpm start` (3101); bu deploy değildir. Gerçek .env veya API anahtarı gerekmez. Katalog canlı public chain/tool/connection verisinden gelir; ONE özel adapter olarak korunur. Ağ seçicide arama/son ağlar/gerçek yerel logolar ve VM formatına uygun adreslerle kullanıcı başlatmalı quote okuması bulunur. Bağlantı/quote execution izni değildir.

Doğrulama: `pnpm verify`, `pnpm test:e2e`; özel üretim smoke/asset sync/live-readonly için docs/RUNBOOK.md içindeki benzersiz evidence dizini talimatını uygulayın. Eski kanıt dosyaları tarihsel checkpoints'e aittir; yeni koşu olarak sunulmaz.

---

# Otherbridge V1

ONEchain native ONE → BSC kanonik CROSS için bağımsız, harici cüzdan odaklı yerel uygulama. **Canlı gönderim kapalı; entegrasyon doğrulaması BLOCKED.** Yerel senaryolar sentetiktir, canlı settlement kanıtı değildir.

## Cüzdan bağlantısı (V1.9 — Privy, yalnız harici cüzdan, connect-only)

"Cüzdan bağla" Privy'nin harici cüzdan modalını açar (MetaMask, Rabby, Phantom EVM, Coinbase Wallet, WalletConnect ve
diğer EIP-6963 eklentileri). Bağlanırken imza istenmez; e-posta/sosyal giriş ve gömülü cüzdan kapalıdır. Privy yalnız
bağlantı katmanıdır: rota, tutar, alıcı, firewall, ücret ve yürütme politikası Otherbridge'tedir. Etkinleştirmek için
`.env.local` içine `NEXT_PUBLIC_PRIVY_APP_ID=<25 karakter>` ekleyin ([PRIVY_SETUP](docs/PRIVY_SETUP.md)); App ID yoksa
ürün salt okunur çalışır ve "Wallet connection is temporarily unavailable." gösterir — enjekte sağlayıcıya geri dönüş
yoktur. Mimari: [WALLET_CONNECTION_ARCHITECTURE](docs/WALLET_CONNECTION_ARCHITECTURE.md), veri akışı:
[PRIVY_DATA_FLOW](docs/PRIVY_DATA_FLOW.md), güvenlik sınırı: [PRIVY_SECURITY_BOUNDARY](docs/PRIVY_SECURITY_BOUNDARY.md).

## Çalıştırma

Node 24.18.0 ve pnpm 11.25.0 ile doğrulandı. Bağımlılıklar tam sürüm ve tek lockfile ile kilitlendi.

```powershell
pnpm install --frozen-lockfile
pnpm dev
# http://127.0.0.1:3100 — mainnet-readonly
```

```powershell
pnpm dev:test
# Ayrı sentetik local-test modu. Gerçek cüzdan bağlamayın.
pnpm build
pnpm start
# http://127.0.0.1:3101 — production build, yalnızca yerel preview
```

Production build her zaman mainnet-readonly kullanır. `OTHERBRIDGE_MODE=local-test` veya enable flag’i production’da fixture/gönderim açmaz. R1 salt okunur quote/simulation, limits/health ve iki zincir gözlemcisini gerçek API yoluna bağlar; gönderim kilidi kapalıdır. Source-build eşleşmesi ve harcanabilir rezerv doğrulanmış sayılmaz. Env toggle tek başına yeterli değildir.

## Doğrulama

```powershell
pnpm verify
pnpm test:e2e
node scripts/verify.mjs
node scripts/reproduce.mjs
node scripts/production-smoke.mjs
pnpm verify:live-readonly
```

E2E kendi 3100 loopback test sunucusunu başlatıp durdurur. Port başka uygulamada kullanılıyorsa o uygulamayı durdurmayın. Playwright Chromium gerekirse `pnpm exec playwright install chromium` ile kurulabilir. Testler ayrı tarayıcı context’i ve synthetic provider kullanır; kullanıcı profiline erişmez. In-memory EVM testi özel anahtar, signer, RPC veya deployment kullanmaz.

`verify:live-readonly` G5 tümü geçmediği için **exit 2** verir ve kanıt üretir. Bu sonuç local suite başarısızlığına çevrilmez, canlı başarı olarak da sunulmaz. `scripts/verify.mjs` her komutu ayrı exit code/log ile kaydeder.

## Uygulanan yüzeyler

Bridge, cüzdan seçimi, native miktar/fee/MAX, review, iki zincir takip, Activity/detail, güvenli import/export, Networks, Help, Risk/About ve Settings. TR/EN ve açık/koyu tema. CEX/DEX kullanımı kullanıcıya ait ayrı işlem olarak açıklanır. Keyfi alıcı, reverse bridge, sosyal login, analytics, gas topup ve swap motoru yok.

Mainnet completion yalnız ilişkili source calldata/event, canonical receipt/finalized tag ve BSC bridge event + tekil kanonik CROSS Transfer log’u üzerinden gözlenir. Public history API’si yalnız hedef hash için sınırlı ipucu sağlar. Storage/import başarı iddiası taze kanıt olmadan trusted değildir. R1 kanıtları `evidence/otherbridge-v1/repair-r1/` altındadır; kökteki eski 81+4+8 test kanıtları tarihsel koşu olarak korunmuştur. Local test module yalnız geliştirme sunucusunun kontrollü fixture dalında çalışır; production erişimi testle engellenir.

Başlangıç noktaları: [handoff](OTHERBRIDGE_V1_HANDOFF.md), [mimari](docs/ARCHITECTURE.md), [kaynaklar](docs/SOURCES.md), [güvenlik](docs/SECURITY.md), [runbook](docs/RUNBOOK.md), [test matrisi](docs/TEST_MATRIX.md). V1 release/mainnet-ready veya audited değildir.
# V1.3 review milestone

Active TVL catalog, wallet-held Portfolio, balance-priority Bridge/Swap selectors, same-chain Swap, route alternatives, zero-enabled platform fee policy and isolated security foundation are implemented. Financial execution remains disabled. Broad live token portfolio needs a server credential; native fallback and synthetic coverage tests are supplied. See [V1.3 test matrix](docs/V13_TEST_MATRIX.md), [Portfolio coverage](docs/PORTFOLIO_COVERAGE.md), [security release gate](docs/SECURITY_RELEASE_GATE.md) and the current handoff. ONEchain G5 and production release remain blocked. Accepted historical documentation follows.


## V1.15.1 Swap completion / repair

V1.15.1 repair candidate: **RETURN_FOR_REPAIR / EXECUTION_CLOSED**. Status is a review gate; independent security/legal approval and production release are external.

Canonical /swap now uses provider-neutral progressive comparison, current scoped EVM/Solana transaction economic review, exact Solana mint import, bounded refresh/cancellation and durable anonymous health. Source pins, supported families, tests and honest external/engineering gates: [V1.15.1 repair dossier](docs/V1151_SWAP_COMPLETION_REPAIR.md). Real execution remains closed. Both frozen dependency graphs and the reviewed provider SDK patch are required.
