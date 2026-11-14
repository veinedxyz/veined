# Veri

Portföy ve kapsam verisi ücretli bir portföy API'sinden değil, {{BRAND}}'in kendi veri katmanından gelir.

## Kendi barındırdığımız veri katmanı

- **Denetlenmiş RPC kaydı**: her uç nokta yalnızca URL politikası, açık DNS, zincir kimliği ve salt okuma yoklamalarından sonra kabul edilir; bir operatör grubu, köken ve inceleme durumu taşır. Aynı operatörün iki uç noktası asla bağımsız sayılmaz.
- **Kendi indeksimiz**: seçili ağlarda {{BRAND}} token adaylarını keşfetmek için ERC-20 transferlerini indeksler; pencereler güvenilmeden önce bağımsız bir kaynakla teyit edilir.
- **Veri deposu**: ileriye dönük, checksum ile sabitlenmiş göçlere ve en az yetkili rollere sahip PostgreSQL. Kullanılamadığında uygulama commit edilmiş kayda düşer ve bunu söyler ("düşük işlevli").
- **Varlık kaydı**: zincir kimlikleri, varlık kimlikleri ve kontratları, meta veri ve piyasa kaynakları, temizlenmiş görseller, risk işaretleri ve rota yetenekleri; `assets:sync` işleriyle senkronize edilir.

## İndeksleyici

İndeksleyici, logları her zincirin kesinleşme derinliğinin altında sınırlı pencerelerde okur, yeniden düzenlemeleri uzlaştırır ve kaynaklar uyuşmadığında tahmin yürütmek yerine durur.

## Kapsam katmanları

| Katman | Doğruluk kaynağı |
| --- | --- |
| Tam indeks | Adaylar için kendi indeksimiz, bakiyeler için canlı `balanceOf` |
| Bilinen tokenlar | Rota sağlayıcısı ve veri deposundan token evreni, canlı `balanceOf` |
| Küratörlü bakiye taraması | Küratörlü kayıt kontratları, doğrulanmış Multicall3 ile canlı `balanceOf` |
| Yalnız yerel | Yalnızca yerel bakiye |
| Yalnız katalog | Listelenir, kontrol edilmez |

## Gizlilik

- Cüzdan adresiniz taranan ağların denetlenmiş RPC uç noktalarına gider (bakiye böyle okunur); açık bir token sorgusunda ise başka hiçbir yere gitmez: piyasa ve DEX sorguları adresinizi değil, token kontratını kullanır.
- Cüzdan adresleri bir şey saklanmadan önce takma adlandırılır (anahtarlı hash) ve loglarda düz metin olarak veya metrik etiketlerinde asla görünmez.
- Portföy verisi cüzdan bağlantı sağlayıcısına asla gönderilmez.
- Uygulamada üçüncü taraf analitik yoktur.

## Kaynaklar ve atıf

Kayıttaki her bilgi kaynağını saklar; bir listelenme veya logo kanıttır, asla bir güvenlik iddiası değildir.

- **Rota sağlayıcısı token listeleri**: her ağ için rotanın desteklediği tokenlar (rota yeteneği).
- **Trust Wallet assets** (açık depo): küratörlü token listeleri ile token/ağ logoları; tam kontrat yolundan kopyalanır ve temizlenir.
- **CoinGecko** (herkese açık API, anahtar gerekmez): tam platform + kontrat piyasa listelenmeleri ve bazı ağ logoları.
- **DEXScreener**: tam ağ + token için DEX çifti kanıtı; yalnız açık sorgularda.
- **ethereum-lists**: tam zincir kimliğine göre ağ adları, yerel semboller, gezginler ve testnet işaretleri.
- **Zincir üstü okumalar**: kontrat kodu, ERC-20 meta verisi ve bakiyeler, denetlenmiş RPC kaydı üzerinden.

Logolar ve markalar sahiplerine aittir. Her kaynağın kullanım koşulları ve atıf gereksinimleri depoda izlenir ve hukuki incelemeye tabidir.
