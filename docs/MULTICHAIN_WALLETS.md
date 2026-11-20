# Çok VM cüzdan ve adres sınırı

İmza/approve/broadcast yolu yoktur. Browser keşif/permission ve public adres okumaları teklif gözlemi içindir; seed/private key/session depolanmaz. Manuel public source/destination adresleriyle cüzdan bağlamadan quote okunabilir. Bu, bakiye/gas/allowance veya gerçek wallet readiness doğrulaması değildir. Arayüz bu belirsizlikleri açıkça gösterir.

| VM | Adres kontrolü | İsteğe bağlı salt okunur browser connector |
| --- | --- | --- |
| EVM | checksum EVM, nonzero | mevcut EIP-6963 / legacy injected hesap/ağ okuması; mevcut R1 permission koruması |
| SVM | base58, tam 32 byte, nonzero | Solana injected publicKey/connect, yoksa Wallet Standard solana:mainnet |
| UTXO | Bitcoin mainnet Base58Check veya bech32/bech32m | UniSat requestAccounts/getAccounts/getNetwork=livenet |
| MVM | Sui 0x + 64 hex, nonzero | Wallet Standard standard:connect, sui:mainnet account |
| TVM | Tron Base58Check, 0x41 prefix, nonzero | TronLink tron_requestAccounts/defaultAddress; chain readiness iddia edilmez |
| STL | Stellar StrKey G, CRC16-Xmodem | Freighter read/access ve public mainnet network passphrase |

UTXO genel aile adıdır; Zcash gibi başka UTXO ağlarının wallet/address desteği doğrulanmadığı için kapalıdır. Katalogda görünmeleri Bitcoin adresini kabul ettirmez. Testnetler salt okunur quote için de kapalıdır. VM sınıfı aynı olan her chain'de extension desteği garanti edilmez. Uyumsuz veya eksik extension açık hata verir; provider fallback ile EVM wallet seçilmez.

Kaynak/hedef adresleri bağımsızdır. Non-EVM değişiminde EVM otomatik alıcı/sender yoktur. EVM global wallet identity revizyonu duplicate accountsChanged, chainChanged, disconnect ve reconnect'te bile review'u geçersiz kılar. EVM chain uyumsuzluğu notice ile belirtilir; salt okunur quote bu nedenle gönderim yetkisi kazanmaz.

Native permission 12 saniyeyle UI'da sınırlıdır; alttaki açık isteğin kilidi sonuçlanana kadar korunur. Geç sonuç state'e bağlanmaz. Bağlandıktan sonra 3 saniyelik public identity kontrolleri adres değişiminde quote/review'u bozar. Bitcoin/Freighter mainnet şartı permission sonrası ve identity poll'da yeniden denetlenir. Wallet Standard account chain membership doğrulanır. Exact signature ve chain-switch sayıları bilinmiyorsa null/'Kesin sayı doğrulanmadı' kalır; sıfır uydurulmaz.

Fixture adresleri public örneklerdir: 0x3333…, Bitcoin genesis adresi, RFC8032 public key'den türetilen Solana/Stellar adresleri. Hiçbir private key üretilmedi/okunmadı. Unit/integration/E2E provider'ları açıkça sentetiktir; gerçek kullanıcı cüzdanı kullanılmaz.
