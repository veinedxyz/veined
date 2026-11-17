# Gerçek mimari ve entegrasyon kararı

Tek Next.js App Router / React / strict TypeScript uygulaması. Root layout’taki Product yaşam döngüsü navigation sırasında cüzdan durumunu korur; allowlist catch-all route bilinmeyen sayfaları 404 yapar. UI state client’ta, public RPC client yalnızca server tarafındadır. Ek veritabanı veya kullanıcı hesabı yok.

| Katman | Gerçek dosyalar | Sorumluluk |
|---|---|---|
| Domain | `src/core/model.ts`, `amounts.ts`, `flow.ts` | Route/asset kimliği, bigint miktar, kontrollü state, source/destination correlation |
| Bridge | `src/adapters/onebridge.ts` | Genel belgelenmiş ABI ile unsigned calldata ve decode eşleştirmesi; native ONE canlı deployment doğrulaması yapılmış sayılmaz |
| Public okuma | `src/adapters/read-only.ts`, `native-service.ts`, `native-decoder.ts`, `deployment.ts`, `src/app/api/bridge/route.ts` | Typed bounded RPC, full proxy/implementation runtime pinleri, native pair/fee/limit/simulation ve iki zincir receipt/event/payout korelasyonu |
| Wallet | `src/features/wallet/provider.ts` | EIP-6963 seçim, EIP-1193, pending request kilidi, account/chain değişimi |
| Submission | `src/features/bridge/submission.ts`, `lifecycle.ts` | Tek wallet write sınırı; registry boşken her zaman kapalı, uncertainty önce kalıcılaştırılır |
| History | `src/storage/history.ts`, `src/features/bridge/observation.ts` | Storage iddiası ile 30 saniyelik bellek kanıtı ayrı; namespace lock altında revalidation duplicate kontrolünden önce |
| Ürün | `src/components/product.tsx`, `dialog.ts`, `src/content/messages.ts` | Yedi ürün yüzeyi, TR/EN, tema, erişilebilir modal ve hata davranışları |
| Test | `tests/fixtures`, `tests/unit`, `tests/integration`, `tests/e2e` | Sentetik senaryolar; mainnet fonları/rezervleri kanıtlamaz |

## Seçilen tek yol

Kimlik gerektirmeyen injected external wallet + dar direct adapter yolu seçildi. viem ABI encode/decode sağlar; ayrı wagmi provider ağacı veya SDK finansal paneli kurulmadı. Standart EIP-1193 bağlantısı cüzdan/chain lifecycle için yeterli. SDK 1.4.2 MIT ve peer metadata incelendi; owned CROSS/Reown ID eksikliği ve kapsam dışı Send/Portfolio/Buy yüzeyleri nedeniyle kullanılmadı. WalletConnect `CONFIGURATION_REQUIRED`, kullanıcıya çalışmayan QR gösterilmez.

R1 okuyucu güncel chainId/block, EIP-1967 slot ve full decoded-byte Keccak-256 runtime hash’lerini pinned adaylarla eşler. Native pair yedi alandır; fee source verifier’dan, limits/pause gerçek view çağrılarından gelir. Quote exact native msg.value ile eth_call + eth_estimateGas kullanır; başarısız simulation/gas için fallback yoktur. Destination accounting ve token bakiyesinin küçük değerinden pendingAmount çıkarılması yalnız muhafazakâr üst sınırdır; kesin harcanabilir rezerv değildir. Üç public kaynak sürümünün pinned compiler/dependency derlemesi observed runtime ile eşleşmedi: G5 source-build/reserve doğrulaması BLOCKED. **Yazma registry source/destination değerleri null kalır.** Salt okunur deployment pinleri bu registry’yi açmaz.

Production `local-test` isteğini reddeder. Test fixture module server bundle’da bulunabilir ancak production dalında erişilemez; signer/test key yoktur, aktif demo route açılmaz. UI local scenario da yalnızca synthetic record üretir. Bu gerçek bridge değildir ve live hata halinde otomatik fixture fallback yoktur.

localStorage en fazla 100 kayıt/150 KB için kullanılır. Bozuk veri korunur; yeni yazım durur. Web Locks mode/route/config/chain/account namespace’inde çalışır; cüzdanın başka uygulamalardaki işlemlerini global olarak kilitlemez. Mainnet terminal storage iddiası düşürülür; fresh observer proof yalnız bellekte tutulur ve reload’da tekrar okunur. Public native receipt/log replay testleri gerçek handler/decoder/verifier yolunu kullanır; gas simulation transport double’ı açıkça ayrıdır. Finality node’un finalized tag’ine ve canonical block hash’e bağlıdır; bir light client veya bağımsız validator proof’u değildir.

R1 continuation: permission grant identity is checked inside connect with event-aware bounded accounts/chain snapshots. Actual request4001 creates a module-private exact-intent proof for30s; storage/import cannot restore it, next dispatch revokes it. Hashless history remains blocked after reload; a user may attach a source hash under history lock for read-only observer validation while preserving records. Stored HELD/reorg destination hashes also trigger bounded fresh receipt discovery; all payout/finality checks remain required.
