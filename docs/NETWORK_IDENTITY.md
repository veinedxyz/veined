# Multichain ağ kimliği — güncel ek

3 Ekim 2026. Önceki resmi ONE/BNB kimliği aşağıdaki tarihsel bölümle korunur. Yeni dinamik katalog 76 provider-metadata logosu + ONE özel kaydını kullanır. Asset adları içerik hash'li ve same-origin'dir; `src/routing/generated-assets.json` her ağın logo/primary/accent/glow/badgeDark/badgeLight/logoSurface/provenance tokenlarını taşır. Ağların listesi görsel manifestten oluşturulmaz; gerçek chain/tools API'sinden gelir. Yeni ve asset'i incelenmemiş ağ metin + güvenli geometrik simge alır.

Güncel kaynak/pipeline: [MULTICHAIN_NETWORK_CATALOG.md](MULTICHAIN_NETWORK_CATALOG.md), [MULTICHAIN_ROUTING_RESEARCH.md](MULTICHAIN_ROUTING_RESEARCH.md). 76 cached logo hash'i `asset-sync-b/asset-sync.json` dosyasında; ambient renkler SVG paletinden türetilir ve resmi brand color sayılmaz. Resmi logolar boyanmadı. Siyah/beyaz simgeler uygun mat plaka alır. Dinamik Bridge/Networks/Activity/review aynı `ChainLogo`/`ChainBadge` tokenlarını kullanır; eski ONE detayları eski ortak bileşenlerini korur.

Koyu opak merkez ve düşük yoğunluklu radial/ambient ışık korunur. Yeni seçici virtual list, arama, son ağlar, klavye ve gerçek logo içerir; emoji yoktur. `contrast-multichain.json` 76 ağ × iki tema için küçük metinde en düşük **4,846:1** hesapladı; 21 ışık yoğunluğu örneği ve badge karışımı denetlendi. Browser axe ham incomplete sonuçları da saklanır, sıfır violations tek başına kontrast kanıtı sayılmaz. Son doğru modal ekran görüntüleri `ui-final/screenshots/` ve production kanıtlarındadır. Önceki erken width-selector yakalamaları modal mount'unu beklemediğinden final görsel kanıt olarak kullanılmaz.

---

# V1 ağ görsel kimliği

2 Ekim 2026. Bu değişiklik mevcut ONEchain → BNB Smart Chain rotasının sunumudur. Finansal route registry, eligibility, kontratlar, RPC, quote/observer, wallet veya gönderim kapısı değişmez. G5 BLOCKED; gerçek imza, broadcast, deploy ve V2/V3 yok.

## Kaynaklar ve yerel asset'ler

| Ağ | Resmi/public kaynak | Yerel dosya | İşlem |
| --- | --- | --- | --- |
| ONEchain | [ONE Docs](https://docs.onechain.nexus/docs/dev_getting-started) başlığındaki [ONE SVG](https://files.readme.io/365e08e670169474bafa838c6ec4aad94d41b576021120bb892d3bb8495c6508-one.svg) | `public/networks/onechain.svg` | Resmi wordmark'ın solundaki simge ayrıldı. Dört wordmark path'i çıkarıldı; simge geometri, renk ve gradient/filter tanımları korunarak kare viewport'a alındı. Yeniden çizim veya başka ONE markası kullanılmadı. |
| BNB Smart Chain | [BNB Chain marka kılavuzu](https://www.bnbchain.org/en/brand-guidelines), [Yellow Symbol SVG](https://www.bnbchain.org/images/brand-guidelines/svg/BNB%20Chain_Symbol_Yellow.svg) | `public/networks/bsc.svg` | Resmi simge byte-for-byte aynı. Sarı renk, oran ve geometri korunur. Logonun kendisine shadow/glow/gradient uygulanmaz; ışık çevresindeki UI zeminindedir. |

İki SVG indirmesi HTTP 200. ONE Docs `dev_getting-started` ve BNB marka sayfası HTTP 200 ile logo referanslarını doğruladı. Eski ONE `/docs/chain` yolu güncel kontrolde 404 döndü; bu sonuç ayrıca kaydedildi ve çalışan sayfa referansı kullanıldı. Runtime'da CDN/üçüncü taraf asset isteği yok; Next public dizininden same-origin yüklenir. SVG'lerde script/event handler, foreignObject, harici image/href veya çalıştırılabilir içerik yok.

Kaynak SVG'ler, HTTP/tarih/content-type ve SHA-256 kayıtları: `evidence/otherbridge-v1/network-identity-20261002T080413Z-2bce74/assets/`. Kaynaklar marka tanımlama içindir; onay/sponsorluk/ortaklık veya logo haklarının devri iddia edilmez. BNB'nin kılavuzu logonun form/rengini değiştirmemeyi belirtir; yayımlama öncesi marka kullanım koşulları ürün sahibince değerlendirilmelidir. Bu görevde yayımlama yapılmadı.

| Dosya | SHA-256 |
| --- | --- |
| Resmi ONE wordmark | `89035d93ed1019fa0eeb58e1c96b3dcd6ec8d3053d001998e577bdec8577e603` |
| Yerel ONE simgesi | `8afac25ab1d65656ca8835282786b9227b436e2b23d47161bd04627966a6d454` |
| Resmi / yerel BNB simgesi | `b8ff1ce0b5af2e2d9bcf5ec89fedd5224079f4f7267e306e23e8d691024f5eff` |

## Token yapısı ve görünüm

`src/content/networks.ts` yalnız görsel config içerir. `NetworkId`, logo/name/shortName, primary/accent/glow RGB, dark/light badge text ve logo surface tanımlıdır. `networkStyle` aynı CSS custom property'lerini Bridge kartlarına, Networks kartlarına ve rozetlere taşır. `NetworkLogo`, `NetworkBadge` ve `RouteIdentity` tek bileşen ailesidir. Yeni ağın asset'ini güvenli yerel SVG olarak ekle, kaynak notunu/hash'ini kaydet, görsel config'e bir kayıt ekle; bu işlem ağın finansal yeteneğini açmaz.

| Ağ | Primary | Accent | Glow | Badge dark / light |
| --- | --- | --- | --- | --- |
| ONEchain | `#EC1272` (resmi SVG) | `#F3752D` (resmi SVG) | `236 18 114` | `#F5B3C9` / `#962944` |
| BNB Smart Chain | `#F0B90B` (resmi kılavuz) | `#E1C77A` (UI tonu) | `240 185 11` | `#E8C66B` / `#70530D` |

Ana dark zemin `#0C0D10`, kart `#151619`, inset `#101114`. Nötr metin ve mat sage eylem rengi; ONE solda, BNB sağda çok düşük yoğunluklu sabit radial light. Kart ışığı dark %9 / light %4.5; kenar sahne ışığı dark %7.5 / light %4.5. Ortada form zemini opaktır. Logo rengi metin kontrastı için değiştirilmez; light theme'de BNB simgesi resmi charcoal plaka üzerinde kalır. Kaynak/hedef isimleri ve chain ID metinde de görünür; renk tek bilgi kanalı değildir. Logo img dekoratiftir, bitişiğindeki metin ekran okuyucuya ağ adını verir. En küçük simge 18px; BNB kılavuzundaki 15px alt sınırın üzerinde.

Bridge giriş kartları, rota özeti ve inceleme dialog'u; Networks ağ kartları; Activity satırları ve detay timeline uçları aynı kimliği taşır. ONE/CROSS varlık adları ve ONEchain/BSC ağ adları ayrıdır. Ağ adını temsil eden O/diamond/ilk-harf placeholder kaldırıldı. Responsive kırılımlar ve reduced-motion desteği korunur; ışık animasyonu yok.

## Doğrulama yaklaşımı

Gerçek component E2E'leri iki tema × 360/768/1440px × Bridge/Networks/Activity/detail ekranlarını kontrol eder. Testler açıkça mocked read-only health + hashless kayıt kullanır; gerçek ağ testi veya teslimat kanıtı sayılmaz. Yerel SVG URL/load/minimum boyut, doğru source/destination isim/chain ID, taşma, kapalı gönderim ve wallet erişimi yokluğu denetlenir. İnceleme dialog'undaki iki logo mevcut sentetik akış testine eklendi.

Axe ham violations ve incomplete sonuçları saklanır. Gradient zeminler otomatik color-contrast ölçümünde incomplete olabilir; bu metinler tarayıcıda çözülen gerçek foreground/inset/glow değerleriyle 0–maksimum ışık yoğunluğu arasında 21 noktada WCAG kontrast hesabına tabi tutulur (tüm metin için en az 4.5:1). Logoların özgün geometri/renkleri ve desktop/mobile kompozisyon ayrıca PNG üzerinden gözle incelenir. Son gerçek komut sonuçları güncel handoff ve evidence summary'dedir.
# V1.3 discovery and holdings

The active TVL catalog is independent of executable routes. Unknown identities use the existing local neutral SVG and ambient tokens; external image URLs cannot load. Existing curated icons and colors remain intact. Virtual selectors render at most ten rows, preserve keyboard/search/recent behavior and add favorites stored only as chain IDs. User holdings sort first, followed by route infrastructure and remaining TVL catalog entries. Holdings never silently change a selected chain or asset. No emoji logos are introduced.
