# Güvenlik

{{BRAND}} kapalı kalarak başarısız olacak ve neyi kontrol ettiğini söyleyecek şekilde tasarlanmıştır. Güvenli, güvensiz-güven (trustless) veya denetlenmiş olduğunu iddia etmez.

## Saklama yok

Anahtarlarınız cüzdanınızda kalır. {{BRAND}} asla fon tutmaz, asla kurtarma ifadesi istemez ve varlıkları kendi başına taşıyamaz. Cüzdan bağlamak imza istemez.

## İşlem güvenlik duvarı

Herhangi bir cüzdan isteğinden önce tam işlem, bağımsız olarak yeniden okunan duruma karşı kontrol edilir: zincir, kontrat, fonksiyon, tutar, ücretler, alıcı, değer ve gas sınırları. Tek bir uyuşmazlık akışı durdurur. Güvenlik duvarı ayrıca hepsinin reddedilmesi gereken değiştirilmiş işlemlerle test edilir.

## Simülasyon

Rotanın izin verdiği yerde tam işlem, incelemeden önce iki bağımsız uç noktada simüle edilir (`eth_call` ve gas tahmini); başarısız olması gereken negatif kontroller dahil.

## Çalışma zamanı sapması

Köprü kontratları sabitlenmiştir: implementasyon kod hash'leri, yönetici ve doğrulayıcı rolleri, duraklatmalar, eşikler ve kayıtlı çiftler. Sabitlenen bloklardan sonraki herhangi bir değişiklik, sessizce devam etmek yerine rotayı yeniden incelemeye alır.

## RPC uzlaşısı

Kritik durum **iki bağımsız kaynaktan** (farklı operatör grupları) okunur ve uyuşmalıdır. BNB Smart Chain için {{BRAND}} kanonik bir **ortak kesinleşmiş pin** kullanır: her iki kaynağın da aynı blok hash'iyle sunabildiği, {{BSC_PIN_MAX_AGE}} saniyeden eski olmayan en yüksek kesinleşmiş blok. Bir kaynak gecikirse yerini denetlenmiş başka bir bağımsız kaynak alabilir; hiçbir bağımsız çift uyuşmazsa kontrol "Güvenlik kontrolü yeniden denenmeli" ile durur ve cüzdan isteği yapılmaz. Kesinleşmiş bir yükseklikte hash uyuşmazlığı her zaman durdurur.

## Güven varsayımları

- **ONEbridge**: sonuçlandırma ve güncellemeler harici sahipli hesaplar tarafından kontrol edilir — sabitlenen bloklarda tek bir yönetici ve 3'te 2 doğrulayıcı grubu. Bu, Güvenlik ayrıntılarında gösterilen merkezi bir güven varsayımıdır.
- **Rota sağlayıcısı**: teklifler ve adımlar üçüncü taraf bir yönlendiriciden gelir; {{BRAND}} her adımın güncel katalogdaki bir aracı kullandığını kontrol eder, ancak yönlendiricinin kontratları kendisine aittir.
- **Veri kaynakları**: açık RPC uç noktaları, piyasa ve DEX kaynakları yanlış veya geç olabilir; {{BRAND}} kritik olanları çapraz kontrol eder, diğerlerini etiketler.

## Onaylar

Herkese açık uygulama bugün token onayı veya izni istemez (gönderim {{SENDING}}). Bir rota onay gerektirdiğinde inceleme harcayıcıyı ve tam tutarı listeler — varsayılan olarak asla sınırsız onay değil.

## Token ve logo güvenliği

Tokenlar tam kontratla tanımlanır; sembol benzerleri, görünmez karakterler ve bağlantı benzeri adlar işaretlenir. Logolar tarayıcınız tarafından asla üçüncü taraflardan yüklenmez: sunucu tarafında alınır, çözümlenir, meta veri olmadan yeniden kodlanır ve {{BRAND}}'in kendi alan adından sunulur. SVG ve görsel kılığındaki HTML reddedilir.
