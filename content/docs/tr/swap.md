# Takas

Takas, aynı ağ üzerinde bir tokenı başka bir tokenla değiştirir. Teklifler ve incelemeler bugün salt okumadır (gönderim {{SENDING}}).

## Token keşfi

Token seçici, bir yönlendiricinin bildiği her tokenın ham listesini asla göstermez. Varsayılan listesi sırasıyla:

1. bu ağda tuttuğunuz ve rotası olan tokenlar;
2. yerel varlık ve kanonik tokenlar;
3. küratörlü tokenlar;
4. kayıttaki piyasada listeli tokenlar;
5. son kullandığınız ve içe aktardığınız tokenlar.

Satırlarda logo, sembol, ad, ağ, bakiyeniz ve değeri ile bir kaynak etiketi görünür. Bu ağda rotası olmayan bir token **Doğrulanmış rota yok** gösterir ve seçilemez.

## Token seviyeleri

| Seviye | Anlamı | Anlamı olmayan |
| --- | --- | --- |
| Kanonik | Ağın yerel varlığı veya protokol-kanonik bir rotanın tokenı (örneğin kayıtlı bir ONEbridge çifti). | Protokolün garantisi değildir. |
| Küratörlü | Tam ağ + kontrat {{BRAND}} küratörlü kaydındadır: Trust Wallet'ın küratörlü listesi ve rota sağlayıcısı kontrat ve ondalık sayısında uyuşur. | "Güvenli" veya "denetlenmiş" değildir. |
| Piyasada listeli | Tam platform + kontrat bir piyasa kaynağında (CoinGecko) listelidir. | "Güvenli" veya "denetlenmiş" değildir. |
| DEX'te bulundu | Tam ağ + kontrat için DEX çifti kanıtı vardır (DEXScreener). | "Doğrulanmış" değildir; boost veya profil güvenlik için bir şey ifade etmez. |
| İçe aktarıldı · doğrulanmadı | Tam adresi kendiniz içe aktardınız. | Hiçbir küratörlü kanıt yoktur. |
| Engellendi | Spam, dolandırıcılık örüntüsü, bozuk meta veri veya politika. | Asla seçilemez. |

Kayıtta bugün {{CURATED}} küratörlü ve {{CANONICAL}} kanonik varlık var.

## Arama

- **Ad veya sembol**: önce küratörlü eşleşmeler, sonra rota listesindeki tam piyasa listeleri gelir. Bir sembol asla otomatik seçilmez ve küratörlü bir tokenın sembolünü farklı bir kontratla kullanan token işaretlenir.
- **Tam adres**: kayıt, rota listesi, zincir üstü meta veri, CoinGecko (tam kontrat) ve DEXScreener (tam adres) kontrol edilir.

## Token içe aktarma

Tam kontrat adresini yapıştırın. {{BRAND}} sırasıyla şunları kontrol eder: adres biçimi, zincirdeki kontrat kodu, ERC-20 meta verisi, küratörlü kayıt, tam piyasa listesi, DEX likiditesi ve fiyatı, logo (sunucu tarafında indirilip yeniden kodlanır; tarayıcınız üçüncü taraftan asla yüklemez) ve rota desteği. Uyarıları ve kanıtları gösterir; yalnızca **Tokenı içe aktar** onu ekler — yalnızca bu cihazdaki listeye, **İçe aktarıldı · doğrulanmadı** olarak.

İçe aktarılan bir token **yalnızca** rotanın o tam adresi desteklediği yerde takas edilebilir veya köprülenebilir.

## Kayma ve yönlendirme

Kayma (%0,5, %1 veya %3) ve rota tercihi (daha yüksek alınan miktar veya daha kısa süre) ayarlar satırındadır. Teklif her girdiye bağlıdır: tutarı, tokenı, alıcıyı, kaymayı veya cüzdanı değiştirmek teklifi geçersiz kılar.

## Alıcı

**Gönderen** bağlı cüzdanınızdır. **Alıcı**, **Başka bir adrese gönder**'i seçmediğiniz sürece aynı cüzdandır; bu seçim adres alanını ve incelemede bir uyarıyı gösterir.

## Takas ayrıntıları

Özet; kuru, alacağınızı, rota/ağ ücretini, gas'ı, fiyat etkisini ve teklif yaşını gösterir. **Rota ayrıntıları** adımları ve protokolleri, minimum alınacak miktarı ve yürütme kontrollerini açar.

## Sade önizleme

Ana kart gönderilen ve alınan miktarı, ücret özetini ve bir ana sonraki adımı gösterir. **Rota ayrıntıları**, **Ücret dökümü** ve **Güvenlik ayrıntıları** isteğe bağlı açılır. Kayma ayarları ve rota tanısı ayarlar alanındadır. Rota önizlemesi işlem başlatmaz; gönderim kapalıdır. Fiyat süresi dolduğunda incelemeden önce yenileyin.

## Sağlayıcı karşılaştırması

Swap, kontrol edilen aynı ağ rotalarını geldikçe karşılaştırır. Seçtiğiniz teklif korunur; sonradan gelen daha iyi rota öneri olarak gösterilir. Sayfa etkin olduğunda teklifler yenilenir. Ağ, token, mint, tutar, cüzdan veya kayma değiştiğinde eski inceleme temizlenir. Süresi dolan, yüksek fiyat etkili, desteklenmeyen veya ekonomik simülasyonu başarısız olan işlemler incelemeye açılmaz.

Solana kesin mint adresiyle içe aktarmayı destekler; hesap sahibi ve ondalık bilgisi zincirden salt okunur doğrulanır. İçe aktarılan token ve mint doğrulanmış sayılmaz. Sağlayıcı erişimi için sunucu erişim bilgisi gerekebilir; kullanılamayan sağlayıcı karşılaştırmaya katılmış sayılmaz. Bilinen ağ, öncelik, hesap oluşturma ve sağlayıcı ücretleri ayrı gösterilir. Bilinmeyen maliyetler bilinmiyor olarak kalır. {{BRAND}} ücreti sıfırdır.

İnceleme kesin rotayı ve doğrulama sonucunu gösterir. Gönderim kapalıdır; onay, imza veya işlem istenmez. Activity önizlemeleri salt okunur niyeti kaydeder, tamamlanmış işlem değildir.
