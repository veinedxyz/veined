# Köprü

Köprüleme bir varlığı bir ağdan diğerine taşır. {{BRAND}}, rota sağlayıcısından {{ROUTE_NETWORKS}} ana ağ için rotaları ve toplayıcıların durduğu yerde doğrulanmış özel rotaları gösterir.

## Rotalar

- **Rota sağlayıcısı rotaları**, sabit ve salt okuma bir entegrasyonla okunur. Listelenmiş bir bağlantı teklif garantisi vermez.
- **ONEbridge (ONEchain → BNB Smart Chain)** özel bir rotadır. Kontratları, rolleri, rezervi ve sonuçlandırması sabitlenmiş bloklarda teknik olarak doğrulandı (G5: {{G5_STATUS}}). Bu doğrulama belirli bir ana aittir: herhangi bir sapma rotayı yeniden incelemeye alır.

Ana ağ ve test ağları tek bir rotada asla birleştirilmez.

## Varlıklar

Köprü yalnızca yerel varlıklarla sınırlı değildir. Varlık seçici sırasıyla şunları listeler: tuttuğunuz ve rotası olan varlıklar, kanonik varlıklar, küratörlü varlıklar, aranabilir rota destekli varlıklar ve — yalnızca rota destekliyorsa — içe aktarılmış tam adresler.

ONEbridge için yalnızca **her iki zincirde zincir üzerinde kayıtlı** token çiftleri listelenir; her biri zincir başına iki bağımsız kaynakla doğrulanır. Bugün {{ONEBRIDGE_PAIRS}} çift kayıtlı; bunlardan {{ONEBRIDGE_VERIFIED}} tanesinin doğrulanmış {{BRAND}} rotası var (yerel ONE → CROSS). Doğrulanmamış kayıtlı bir çift **Doğrulanmış rota yok** gösterir; teklif alınamaz ve gönderilemez. Çiftler sembolle değil, tam token adresleriyle eşleştirilir.

## Rota kartı

Rota kartı temel bilgileri öne çıkarır: kaynak ve hedef ağ, tokenlar, **Alacağınız**, **Ücret** ve **Tahmini süre** (rota bildirmiyorsa "Bildirilmiyor"). **Rota ayrıntıları** protokolü, kontratları, zincir kimliklerini, teklif kimliğini ve tam adımları açar.

## Rota sağlığı

Rota sağlığı tek bir durum gösterir:

| Durum | Anlamı |
| --- | --- |
| Rota hazır | Tüm kontroller geçti ve gönderim etkin. |
| Yenilenmeli | Veri veya teklif çok eski — yenileyin. |
| Geçici olarak kullanılamıyor | Bir veri kaynağı veya rotanın kendisi kullanılamıyor. |
| Gönderim kapalı | Kontroller geçebilir, ancak yürütme kapısı kapalı (bugünkü herkese açık durum). |

Altında en fazla üç satır rota doğrulamasını, likidite/rezervi ve canlı veriyi özetler. **Güvenlik ayrıntıları** çalışma zamanı pinlerini, yetkiyi, rezervi, RPC uzlaşısını, bekleyen/yoldaki kontrolleri ve son kontrol zamanını açar.

## Ücretler

İnceleme, herhangi bir cüzdan isteğinden önce her ücreti gösterir: rota/ağ ücreti, gas, varsa sağlayıcı ücreti ve {{BRAND}} ücreti ({{FEE_PERCENT}}). Bkz. [Ücretler](/docs/fees).

## Alıcı

Varsayılan olarak alıcı aynı cüzdandır. **Başka bir adrese gönder** açık bir seçimdir; farklı bir ekosistemdeki hedef için (örneğin EVM → Solana) o ekosistemin adresini girmeniz gerekir.

## Takip ve hatalar

Etkinlik, transferleri kaynak zincirden hedefe kadar salt okumayla takip eder. Bir kontrol başarısız olursa veya veri kaynakları uyuşmazsa hiçbir şey gönderilmez ve nedeni gösterilir. Bkz. [Sorun giderme](/docs/troubleshooting).

## Sade önizleme

Ana kart gönderilen ve alınan miktarı, ücret özetini ve bir ana sonraki adımı gösterir. **Rota ayrıntıları**, **Ücret dökümü** ve **Güvenlik ayrıntıları** isteğe bağlı açılır. Kayma ayarları ve rota tanısı ayarlar alanındadır. Rota önizlemesi işlem başlatmaz; gönderim kapalıdır. Fiyat süresi dolduğunda incelemeden önce yenileyin.
