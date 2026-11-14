# Kaynaklar ve canlı gözlemler

1 Ekim 2026 tarihsel envanter; aşağıdaki ilk gözlemler eski teslimdir. Master Ek A/B tüm 40 URL envantere alındı. HTTP200 tam içerik incelemesi veya canlı readiness değildir. R1 güncel kanıt ve eksik build ilişkisi [R1_READONLY_EVIDENCE](R1_READONLY_EVIDENCE.md) içindedir; dinamik token/bridge yüzeyi ve whitepaper’lar deployment ABI yerine kullanılmadı.

## Kritik sonuçlar

- A07 README: BSC kanonik Cross/CROSS adresi ve rezervler arası özel ONE/CROSS mekanizması. On-chain okuma name=Cross, symbol=CROSS, decimals=18 ve code varlığını doğruladı.
- A08 generic bridge README/API: native sentinel address(1), empty extraData, exact msg.value. Bu davranış native ONE canlı deployment’a taşınmış sayılmadı. İncelenen generic interface commit 3a8347cd005d00e50af9194204a55da69f96ddfc.
- B01/B02 SDK 1.4.2 npm metadata MIT, React19/wagmi2–3/query5 peers; doküman owned CROSS/Reown project ID gerektiriyor. SDK kurulmadı, borrowed ID yok.
- Resmî legacy B04a endpoint kaynağı üzerinden public pair/chain-info GET 200: native ONE 612055 → CROSS BSC56 aday route bulundu. ONE RPC chain-info’dan, BSC RPC [BNB Chain resmî kaynağından](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/) seçildi; API’deki keyed BSC RPC URL kopyalanıp kullanılmadı. Evidence chain-info keyed paths sansürlü.
- 2026-10-01T11:18:00Z (14:18 İstanbul) live probe: chain IDs 612055/56, token code4338bytes, proxy code163bytes. Source proxy 0xb81d6e000000000000000000000000000000c0de, source implementation 0x2827865ad5330faf855af8b743c701ae9c818034. Destination proxy 0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5, implementation 0xac7b8ffed19d670930b8caa0693189b33454e8d8. Bunlar gözlemdir; audit/code-match değildir.
- [ONEchain explorer source contract](https://explorer.onechain.nexus/612055/address/0xb81d6e000000000000000000000000000000c0de) adresi Cross Bridge olarak gösterdi. BscScan contract code web erişimi403; bypass yapılmadı. Source/destination public örnek eşleşmesi, finality, spendable reserve ve live quote/limit/pause kanıtı tamamlanmadı. Toplam bakiye kullanılabilir rezerv sayılmadı.
- A13 audit kapsamı deployment/commit ile doğrulanmadı; audit rozeti verilmedi. A14–A18 ticari/tarihsel bağlam envanteri; token/grant/onramp yeni kapsamına dönüştürülmedi.
- Next16.3.8 bundle AGENTS generator dosyaları korundu; bundled layouts/pages, route-handlers, CSP ve devIndicators rehberleri incelendi. EIP1193/6963/3085/3326 standartları seçilen injected bağlantının temelidir. viem encode/decode ve Playwright API’leri kurulu sürümde type/build/browser ile doğrulandı.

## Kaynak envanteri

| ID | URL | Durum | HTTP / erişim |
|---|---|---|---|
| A01 | [kaynak](https://www.onechain.nexus/gametoken/tokens) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| A02 | [kaynak](https://www.onechain.nexus/gametoken/bridge) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| A03 | [kaynak](https://www.onechain.nexus/gametoken/faq) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| A04 | [kaynak](https://explorer.onechain.nexus/612055) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| A05 | [kaynak](https://www.onechain.nexus/skills/) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| A06 | [kaynak](https://github.com/to-nexus) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| A07 | [kaynak](https://github.com/to-nexus/cross-token) | okundu — V1 ilgili bölümler | 200 |
| A08 | [kaynak](https://github.com/to-nexus/bridge-contracts) | okundu — V1 ilgili bölümler | 200 |
| A09 | [kaynak](https://github.com/orgs/to-nexus/repositories?type=all) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| A10 | [kaynak](https://github.com/to-nexus/cross-ramp-token-preset-contracts) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| A11 | [kaynak](https://explorer.onechain.nexus/612055/tokens) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| A12 | [kaynak](https://explorer.onechain.nexus/612055/token/0xfeed00000000000000000000000000000000c0de) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| A13 | [kaynak](https://skynet.certik.com/projects/one) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| A14 | [kaynak](https://blog.opengamefoundation.org/) | erişilemedi | 403 |
| A15 | [kaynak](https://www.ogfcorp.com/) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| A16 | [kaynak](https://contents.crosstoken.io/white-paper/ONE_Whitepaper_V2.0_072026.pdf) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| A17 | [kaynak](https://contents.crosstoken.io/white-paper/260713_WhitePaper_ONE_Token_OGF_BVI_Ltd_VG_EN_ID_3557280.xhtml) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| A18 | [kaynak](https://contents.crosstoken.io/white-paper/CROSS_White_Paper_v1.0.pdf) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| A19 | [kaynak](https://docs.onechain.nexus/docs/dev_chain) | okundu — V1 ilgili bölümler | 200 |
| A20 | [kaynak](https://docs.onechain.nexus/docs/bridge) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| A21 | [kaynak](https://docs.onechain.nexus/docs/bridge-in-crossx) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| A22 | [kaynak](https://docs.onechain.nexus/docs/dev_getting-started) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| B01 | [kaynak](https://docs.onechain.nexus/docs/app-launcher-getting-started) | okundu — V1 ilgili bölümler | 200 |
| B02 | [kaynak](https://docs.onechain.nexus/docs/app-launcher-features) | okundu — V1 ilgili bölümler | 200 |
| B03 | [kaynak](https://docs.onechain.nexus/docs/one-explorer) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| B04 | [kaynak](https://github.com/to-nexus/skill-cross-crossd) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| B04a | [kaynak](https://github.com/to-nexus/skill-cross-crossd/blob/main/skills/cross-crossd/scripts/_api.mjs) | okundu — V1 ilgili bölümler | 200 |
| B05 | [kaynak](https://eips.ethereum.org/EIPS/eip-6963) | okundu — V1 ilgili bölümler | 200 |
| B06 | [kaynak](https://eips.ethereum.org/EIPS/eip-1193) | okundu — V1 ilgili bölümler | 200 |
| B07 | [kaynak](https://eips.ethereum.org/EIPS/eip-3085) | okundu — V1 ilgili bölümler | 200 |
| B08 | [kaynak](https://eips.ethereum.org/EIPS/eip-3326) | okundu — V1 ilgili bölümler | 200 |
| B09 | [kaynak](https://wagmi.sh/react/guides/connect-wallet) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| B10 | [kaynak](https://viem.sh/docs/contract/simulateContract) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| B11 | [kaynak](https://viem.sh/docs/actions/public/waitForTransactionReceipt) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| B12 | [kaynak](https://playwright.dev/docs/test-assertions) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| B13 | [kaynak](https://nextjs.org/docs/app/getting-started/installation) | okundu — V1 ilgili bölümler | 200 |
| B14 | [kaynak](https://docs.onechain.nexus/llms.txt) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| B15 | [kaynak](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| B16 | [kaynak](https://developers.openai.com/api/docs/models/gpt-6.1-sol) | kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil | 200 |
| B17 | [kaynak](https://developers.openai.com/codex/security/) | erişilemedi | unreachable |

Asıl gözlem zamanları source-inventory.json’da; public API, repo ve zincir kanıtları ayrı tutulur. G5: BLOCKED. MAINNET_E2E: NOT_RUN.
