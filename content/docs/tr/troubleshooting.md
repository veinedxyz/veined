# Sorun giderme

## Yanlış ağ

Köprü ve Takas cüzdanınızın mevcut ağını okur. Rotanın kaynak ağıyla uyuşmazsa form bunu söyler; ağ değiştirmek cüzdanınızda ayrı bir işlemdir ve değişiklikten sonra her teklif geçersiz olur.

## Eski teklif

Teklifler hızla sona erer (inceleme kalan süreyi gösterir). Süresi dolmuş bir teklif incelenemez — **Rotayı oku**'yu yeniden seçin. Tutarı, tokenı, alıcıyı, kaymayı, ağı veya cüzdanı değiştirmek de teklifi geçersiz kılar.

## Güvenlik kontrolü yeniden denenmeli

Bir veri kaynağı henüz yetişmedi, zamanında yanıt vermedi veya istekleri geçici olarak sınırlıyor. Cüzdan isteği yapılmadı. Biraz bekleyin ve **Yeniden kontrol et**'i seçin. **Gelişmiş ayrıntılar** başarısız kontrolü, zinciri, veri kaynaklarını operatör gruplarıyla ve son doğrulanmış bloğun yaşını gösterir. Gerçek bir rota sorunu (örneğin değişmiş bir kontrat) bunun yerine **Rota incelemesi gerekli** gösterir ve yeniden denemekle geçmez.

## RPC kullanılamıyor

Bir ağın denetlenmiş veri kaynakları kullanılamadığında Portföy onu **Kontrol başarısız** veya **Kontrol edilmedi** olarak işaretler, Köprü/Takas **Geçici olarak kullanılamıyor** gösterir. Bu arada hiçbir şey tahmin edilmez.

## Kısmi portföy

Ağlar hâlâ **bekliyor** durumundayken kısmi sonuç normaldir. Her ağın kapsam sınıfı neyin kontrol edildiğini söyler. Bazı ağlar başarısız olmaya devam ederse daha sonra **Yenile**'yi kullanın; hiçbir şey sırf kontrol edilmediği için sıfır gösterilmez.

## Bir token eksik

Küratörlü tokenlar otomatik bulunur. Diğer tokenlar için tam kontrat adresini token seçiciye yapıştırın ve **Bu tokenı sorgula**'yı kullanın; token gerçekse ve ona güveniyorsanız **Tokenı içe aktar** onu bu cihaza ekler.
