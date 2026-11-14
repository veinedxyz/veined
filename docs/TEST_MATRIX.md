# Kabul matrisi → gerçek kanıt

Güncel R1 sonuçları `evidence/otherbridge-v1/repair-r1/acceptance-c/commands.json`, `acceptance-c/logs/`, `e2e-final-c/e2e-results.json`, `repro-final-c/` ve `production-final-c/` içindedir: 103 unit, 19 integration, 14 E2E; skipped/unexpected/flaky=0. Eski kök kanıtlar tarihsel koşudur. PASS etiketleri assertion kapsamındadır; gönderim veya G5 kapısını açmaz.

| Master ID | Assertion / dosya | Kanıt kapsamı |
|---|---|---|
| A01, M06 | domain native calldata/exact msg.value + integration/evm | Native sentinel, approval yok, padding reject |
| A02–A05 | domain changed token/sourceChain/destinationChain/route/config | Sabit token/route/chain, decimals identity18, yanlış asset fail |
| A06, Q04 | domain sentinel/deployment/router drift | Explorer sentinel ve API router otomatik kabul edilmez |
| M01–M03 | domain amount tests | 18digits bigint, zero/negative/exponent/length/locale reject |
| M04–M05 | domain MAX, dependent fee, cap + quote expiry | Bakiye/gas/route limit korunur; fee taslağı bağlı |
| W01, W05, X03 | product EIP6963 E2E | Çoklu sağlayıcı seçimi, kimliksiz injected, malicious icon inert |
| W02 | wallet unit + product rejection/no-wallet E2E | Reddetme/locked/no wallet doğru mesaj |
| W03, S05 | product account/chain E2E + domain identity change | Quote/review invalidation, son validation |
| W04 | wallet timeout/pending unit | Timeout isteği iptal saymaz; ikinci request yok |
| W06 | domain smart/delegated preflight | Nonempty code bloklanır; gerçek smart-wallet cihaz testi NOT_RUN |
| Q01, X01 | transport timeout/429/malformed/redirect/DNS + product network failure | Bounded errors; fixture fallback yok |
| Q02–Q03 | domain expiry/calldata/fees/recipient | Stale veya manipulated taslak reject |
| Q05–Q06, G01 | domain reserve/freshness/pause/simulation/balance preflight | Unknown liquidity/simulation/gas fail closed |
| S01, X05–X06 | wallet closed-gate + integration production-mode + production smoke | Toggle true bile write/fixture açmaz; nonce CSP & frozen deps |
| S02, X02 | domain RPC deny + transport size + streaming body | Public send/sign, arbitrary call/log range/batch alınmaz |
| S03 | lifecycle unresolved + storage parallel lock | Aynı hesap belirsiz intent ikinci gönderimi engeller; sekme yazıları korunur |
| S04 | lifecycle uncertainty/persistence/hash/rejection | Request öncesi unknown kalıcı; hash kaybında otomatik retry yok |
| T01–T05 | domain settlement correlation | Source alone/API status/batch unrelated payout completion değildir |
| T06–T09 | domain held/release/reorg/replacement/timeout | Kanıt revalidation, nonce/intent ayrımı, false refund yok |
| P01 | local transfer E2E reload + storage lock | Takip devamı, otomatik submission yok |
| P02–P03 | domain strict import, storage completion downgrade, corrupted history E2E | False success untrusted; bozuk veri ezilmez |
| P04 | lifecycle account isolation + E2E account switch | History adresini gösterir; başka hesapla intent karışmaz |
| G02 | local review E2E, post panel | BNB0 uyarısı source acceptance’ı kendiliğinden engellemez; claim unknown live blocker |
| U01 | product responsive E2E | 360/390/768/1440, scrollWidth assertion ve gerçek screenshots |
| U02 | product keyboard/focus/zoom E2E | Tab trap/escape return, **200% CSS zoom** layout testi; OS/browser chrome zoom testi değildir |
| U03 | product TR-dark/EN-light + production a11y | Kalıcı seçim, axe violations0; görsel manuel screenshot incelemesi |
| U04 | product error/no-wallet/history failure + production live health | Unknown/unavailable ayrımı; sahte0 yok |
| X04 | domain diagnostic redact | Address/amount/hash varsayılan yok; secrets/schema unknownfield reject |

R1: `repair-r1.test.ts` kimlik/sayısal bozulma/held/replacement/amount binding/wallet hang-synchronous throw regresyonlarını; `history-revalidation.test.ts` storage ve bellek kanıtı ayrımını test eder. `native-replay.test.ts` actual API/observer ile public receipt/log replay, revert without event, canonical reorg, finalized tag, tekil ve batch payout sahipliği, lock altında revalidation, yanlış destination hint’inden recovery, bounded history paging ve quote/health ABI yolunu kapsar. Quote gas/funded EOA simulation girdisi açık transport double’dır; public kayıt güncel canlı veri diye sunulmaz.

`history-proof.spec.ts` reload sonrası taze proof ve iki gerçek tab Web Locks namespace’ini; `product.spec.ts` takılan chain read, geç permission cevabı, delayed quote→MAX ve valid mainnet-readonly quote + API submission=true karşısında disabled review action/no-write assertion’ını kapsar. Unit submission boundary, üretim config ve production smoke aynı kapalı yazma sınırını ayrıca test eder.

`native-live-c/` opt-in gerçek RPC okuyucu kanıtıdır: tarihsel public payout yeniden gözlendi; seçilen public hesabın quote’u yetersiz balance nedeniyle reddedildi. Son 2×1000 source block içinde başka uygun native EOA bulunmadı. Probe PASS, quote başarısı veya G5 PASS anlamına gelmez. Local in-memory EVM testi signer/mining/deploy kullanmaz. G5 full source-build/spendable reserve BLOCKED; G7 NOT_RUN, G8 BLOCKED.

## R1 checkpoint-review continuation

Final continue-checkpoint-d acceptance: 112 unit, 23 integration, 22 E2E (all final source hashes matched). wallet.test.ts covers normal grant/competing account/snapshot/chain/disconnect; history-revalidation.test.ts covers exact runtime4001, expiry/import/module-reload/retry timeout/hash-persistence failure; storage.test.ts covers candidate hash preservation/no overwrite. native-replay.test.ts covers stored HELD/reorg → later verified payout and explicit3-page exhaustion. product.spec.ts covers grant and conflicting events plus quote busy after account/chain/disconnect; history-proof.spec.ts covers hashless reload and explicit manual hash recovery before decoder proof. Raw failing and final runs are preserved; verification-summary-continuation.json links actual counts/heads/hashes.
