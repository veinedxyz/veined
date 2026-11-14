# Portföy

Portföy, bir adresin bakiyelerini desteklenen ağlarda bulur. **Salt okumadır**: imza yok, işlem yok, onay yok.

## Otomatik tarama

Bir cüzdan bağlıyken **Cüzdanım** onu otomatik olarak tarar:

- önce cüzdanınızın bulunduğu ağ, sonra zaten varlık tuttuğunuz ağlar, ardından kalan sağlıklı ana ağlar taranır;
- sonuçlar kademeli gelir; tarama, planlanan her ağ bir yanıt veya net bir durum alana kadar devam eder;
- hesabı değiştirmek veya bağlantıyı kesmek çalışan taramayı iptal eder ve önceki hesabın sonuçlarını temizler;
- sayfa açıkken tarama iki dakikada bir yenilenir; **Yenile** hemen çalıştırır.

İstekler sınırlı eşzamanlılık ve ağ başına zaman aşımıyla çalışır; yavaş bir ağ diğerlerini yavaşlatmak yerine **bekliyor** olur. Aynı cüzdanı aynı anda tarayan iki sekme tek bir taramayı paylaşır.

## Başka bir adresi görüntüleme

**Başka bir adresi görüntüle**, yapıştırdığınız herhangi bir adresi tarar (EVM; desteklendiği yerde Solana, Bitcoin, Sui, Tron ve Stellar). Yalnızca izlemedir: o adres hakkında hesap olarak hiçbir şey saklanmaz.

## Kapsam

Her ağ tam olarak bir kapsam sınıfı alır:

| Sınıf | Anlamı |
| --- | --- |
| Tam indeks | {{BRAND}} bu ağı kendisi indeksler; token transferleri adayları ortaya çıkarır, bakiyeler `balanceOf` ile canlı okunur. |
| Küratörlü bakiye taraması | Yerel bakiye artı doğrulanmış bir Multicall3 kontratıyla küratörlü token kaydının tam `balanceOf` taraması. |
| Bilinen tokenlar | Yerel bakiye artı {{BRAND}}'in bu ağ için bildiği token evreni. |
| Yalnız yerel | Yalnızca yerel bakiye okunabildi. |
| Kontrol edilmedi (katalog) | Sağlıklı denetlenmiş veri kaynağı yok — ağ listelenir ama kontrol edilmez. |
| Kontrol başarısız | Veri kaynağı hata döndürdü; daha sonra tekrar deneyin. |
| Bekliyor | Henüz yanıt gelmedi. |

Bakiyeler her zaman canlı okunur; {{BRAND}} bir bakiyeyi transferleri toplayarak asla hesaplamaz. Test ağları değer için taranmaz. Bitcoin, Sui, Tron ve Stellar adresleri, onlar için denetlenmiş bir okuma yöntemi yoksa kontrol edilmedi olarak listelenir — asla EVM düzeyinde kapsamla gösterilmez.

## Token seviyeleri

Tokenlar uygulamanın her yerinde aynı seviyeleri taşır: **Kanonik** (yerel varlıklar ve protokol rota tokenları), **Küratörlü**, **Piyasada listeli**, **DEX'te bulundu**, **İçe aktarıldı · doğrulanmadı** ve **Engellendi**. Seviye kanıtı anlatır, güvenliği değil. Bkz. [Takas](/docs/swap#token-seviyeleri).

## Fiyatlar

- Başlık **Bilinen toplam değer**dir: fiyatı bilinen varlıkların toplamı. Fiyatı olmayan varlıklar görünür kalır ve **fiyatsız** olarak sayılır.
- Fiyatlar bilgi amaçlıdır. Kaynakları ve gözlem zamanlarıyla gelirler ve rota veya işlem hesabına **asla** girmezler.
- Test ağı varlıkları toplama asla dahil edilmez.

## Spam ve toz

Şüpheli tokenlar (örneğin küratörlü bir tokendan kopyalanmış sembol, adında bağlantı veya görünmez karakterler) işaretlenir ve toplamdan çıkarılır. Küçük bakiyeler filtrelenebilir. Hiçbir şey sessizce silinmez: her şeyi görmek için **Spam** veya **Küçük bakiyeler**'i açın.

## Portföyden Köprü ve Takas

Köprü ve Takas düğmeleri yalnızca bir ana ağda rotası olan varlıklar için görünür; şüpheli veya doğrulanmamış tokenlar için asla görünmez.

## Cüzdan ve DeFi

Varlık tablosunda **Tüm varlıklar**, **Cüzdan** veya **DeFi** seçilebilir. Bilinen varlık değeri cüzdan ve DeFi bakiyelerine ayrılır. Borçlanma ayrı gösterilir; varlık toplamına eklenmez. Bu değer **net servet değildir**. Fiyatı bilinmeyen borçlar ve kontrol edilmemiş protokoller görünümü eksik bırakabilir.

Salt okunur tarama Ethereum, Base, Arbitrum, Optimism ve Polygon üzerinde 43 tam adresli pozisyon/borç tokenını kontrol eder: seçili Aave V3 rezervleri (borç verme ve değişken borç), Ethereum Lido stETH/wstETH (staking), sDAI (kasa payları). Bu, sınırlı bakiye kontrolüdür; tüm protokol hesaplarının keşfi değildir. Miktarlar pozisyon/borç token biriminde gösterilir. Dayanak varlık dönüşümü, getiri veya sağlık faktörü hesaplanmaz. Fiyat ve logo tam ağ/adres kimliği ile eşleşir; fiyat yoksa pozisyon kaybolmaz.

**Protokol kapsamı**, her ağ/protokol/kategori için okunan sözleşme sayısını gösterir. Başarılı sıfır bakiye kontrol edilmiş sayılır; başarısız veya eksik okuma sıfır değildir. Bekleyen kontroller cüzdan taramasıyla devam eder. LP/NFT pozisyonları, restaking, alınabilir ödüller, diğer protokoller ve rezervler **kontrol edilmedi** olarak kalır. Token taramasının tamamlanması DeFi kapsamının tamamlandığı anlamına gelmez.

Kaynaklar: [sabitlenmiş Aave adres kaydı](https://github.com/aave-dao/aave-address-book/tree/e5bed1f0b32279b3f3259708b0a3b0fa29c058fc) ve [Lido adresleri](https://docs.lido.fi/deployed-contracts/). RPC izin listesi genişletilmedi; mevcut sabit blok balanceOf okumaları ve doğrulanmış Multicall kullanılır.


## DeFi intelligence

[Pozisyonlar](/docs/portfolio/defi) · [Kapsam](/docs/portfolio/coverage) · [Risk metrikleri](/docs/portfolio/risk)

