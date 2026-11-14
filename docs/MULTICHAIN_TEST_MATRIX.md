# Public copy repair — güncel kabul

3 Ekim 2026. Bu task yalnız public metin/etiket kapsamıdır; yeni faz değildir. HEAD `8973a3d3cc9b796dce9e7f846fb0a06a5ed5cde5`, son kaynak checkpoint `b10070fab172ccf61808fc5cce96d1261b1c30fb92ed8dfc36125b7b2a9fa37c`. **201 unit / 46 integration / 46 E2E PASS**, skipped/unexpected/flaky=0. Sekiz acceptance komutu, build, production 18 kontrolü ve gerçek ETH→Base TR/EN read-only review PASS. Public normal docs ve full production browser textContent denylist eşleşmesi sıfır; teknik/legal INTERNAL, raw upstream fixture/evidence, package/import ve özgün kullanıcı talimatları bilinçli istisnadır.

Ham kanıt `evidence/otherbridge-v1-1/public-brand-20261003T071538Z-4bd6d4/acceptance-delivered`, `e2e-delivered`, `production-delivered`, `production-routing-delivered`, `docs-final`; JSON+log+PNG'ler ve dört eşleşen source snapshot `source-inventory.json` içinde bağlanır. Gerçek fee amount/token/included/order aynı kalır, sağlayıcı hizmet ücreti nötr gösterilir; teknik protokol kimlikleri incelemede korunur. G5 UNCHANGED_BLOCKED, write gate false/null; signatures/approvals/broadcasts/deploys=0. Eski başarısız tanı koşuları yeni PASS yerine kullanılmaz. Aşağıdaki multichain foundation sonuçları önceki checkpoint'e aittir.

---

# Multichain kabul matrisi — 3 Ekim 2026

Kanıt kökü: `evidence/otherbridge-v1-1/multichain-20261002T203410Z-146be9/`. HEAD `8973a3d3cc9b796dce9e7f846fb0a06a5ed5cde5`; çalışma ağacı checkpoint SHA-256 `2f583651da3549f061d39eb2a1cdcb86db1b69ae9c7c729c97cdfd323f61314d`. Commit yapılmadı. Son gerçek kanıtlar aşağıdadır; daha eski diagnostic dosyalar son PASS yerine kullanılmaz.

| Kontrol | Sonuç | Ham kanıt |
| --- | --- | --- |
| frozen install / format / lint / types / safety / build | sekiz komut exit 0 | acceptance-delivered/commands.json + logs |
| Unit | 180 PASS, 9 dosya | acceptance-delivered/logs/test.log |
| Integration | 45 PASS, 4 dosya | acceptance-delivered/logs/test-integration.log |
| E2E | 44 PASS, skipped/unexpected/flaky=0 | e2e-delivered/e2e-results.json + logs/delivered.log |
| Son responsive UI | tüm 360/390/768/1440 × dark/light, keyboard, 200% CSS zoom, reduced motion | e2e-delivered/screenshots + axe-routing JSON |
| Orijinal production | 6 rota + 6 ek tema/mobil = 12 PASS; browser/CSP/external-image error 0 | production-delivered/production-smoke.json + csp-diagnostic.json |
| Dynamic production | gate false/null, beş write action reddi, gerçek catalog + public quotes, native VM alıcı, axe/CSP/overflow | production-routing-delivered/production-multichain.json + quote-responses.json + raw log |
| Fresh install/build | PASS; public dahil yeni izole tree | repro-delivered/reproducibility.json + iki ham log |
| Live read-only | gerçek 7 bounded GET; Ethereum→Base ve Ethereum→Solana quote; M9 PASS_READ_ONLY | live-delivered/live-readonly.json + her cevabın SHA/raw JSON'u |
| SVG/cache | 76 CACHED, hash/provenance/diff | asset-sync-b/asset-sync.json |
| Metin kontrastı | minimum 4,846:1; axe incomplete + PNG review ile birlikte | contrast-multichain.json + browser axe JSON |
| İlk JS/interaction | PASS ölçülen baseline bütçesi | baseline-performance, bundle-delivered, performance-budget/performance-comparison-delivered JSON |

M1 mevcut 112 unit/23 integration/28 E2E regresyonunu final toplama dahil korur. Yeni native VM fixture senaryoları EVM↔Solana, EVM→Bitcoin/Sui/Tron/Stellar içindir; hepsi gerçek rota iddiası değildir. E2E quote/status fixture'larında SYNTHETIC_TEST_ONLY açıkça görünür. Gerçek API availability yalnız live ve production public quote kayıtlarından anlaşılır. Quote endpoint tek gerçek alternatif döndürür; karşılaştırma yardımcıları olmayan ikinci rota uydurmaz.

M2 dinamik katalog+ONE, M3 adapter/domain isolation, M4 native adres/wallet, M5 current quote binding, M6 logo/theme/accessibility, M7 kapalı execution ve M8 kanıtlı doğrulama PASS. M9 PASS_READ_ONLY, M10 G5 UNCHANGED_BLOCKED. M11 NOT_RUN — USER_APPROVAL_REQUIRED; M12 BLOCKED — RELEASE_APPROVAL_REQUIRED. Bu yerel READY_FOR_REVIEW, mainnet-ready değildir.

Diagnostic zinciri korunur: lint compiler hook hataları, trn/xlm fixture anahtarları, connection BaseToken hydration, gerçek feeCollection schema, probe request-id/name collision, Node JSON import, dil/theme/modal focus/test locator, manuel sender mount race. Son yarış minimal identity-change eşitlemesiyle onarıldı; bütün 44 test yeniden geçti. Wrapper'ın live-readonly/reproducibility isim çakışmaları wx ile eski dosyayı korudu; son benzersiz bounded-probe/fresh-copy kayıtları exit 0. Production lazy-image timeout testi bütün local asset'leri eager health check ile denetleyecek şekilde onarıldı; üründe lazy yükleme korundu. Solana pair değişimi inputları sıfırlar; smoke da public inputları yeniden doldurur.

Development abort testlerinde Next ECONNRESET tanıları raw logda görülebilir; bunlar kasten abort edilen isteklerdir. Production smoke'larda browser/CSP hataları ayrı ve sıfırdır. Safety scan bağımsız güvenlik audit'i değildir. Gerçek cüzdan/native extension kabulü, imza/approve/broadcast/deploy ve V2/V3 yapılmadı.

Test checkpoint ilişkisi `source-inventory.json` içindedir. Son E2E/acceptance/production/fresh-copy başlangıç SHA-256 haritaları final kaynak/asset/test/script/config checkpoint'iyle tamamen aynı. Eski V1/R1 kanıtları kendi tarihsel commits/checkpoints'ine aittir.
