# Tehdit modeli ve inceleme hazırlığı

Bu çalışma bağımsız audit değildir. G6 yerel incelemeye hazır; G5 canlı route blocker’ı ve G7/G8 onay kapıları korunur.

| Tehdit | Kontrol | Kanıt |
|---|---|---|
| Yanlış token/chain/alıcı, quote/payload değişimi | Sabit tek yön registry, aynı EOA adresi, bigint, quote expiry, ABI decode/exact payload | domain A/M/Q testleri |
| Router/proxy/ABI drift | Aktif registry null; generic ABI yalnızca documented, canlı gönderim kapalı | S01, production smoke, live-readonly |
| Yanlış API success/payout/batch/index | Source event identity ve dual receipt/payout korelasyonu; held/reorg yeniden değerlendirme | flow T01–T09 |
| Smart/delegated account | İki ağ code gözlemi, nonempty code bloklanır; getCode’ın tam sınıflandırma olmadığı kabul edilir | W06; canlı hesap uyumluluğu ayrı gate |
| Sahte provider, icon/XSS | UUID/provider seçim/dedup; rdns’e yetki yok; icon hiç render edilmez, raw HTML yok | W01/X03 E2E |
| Duplicate/uncertain broadcast | Web Locks; unresolved intent kontrolü; hash kaybında unknown, otomatik retry yok | lifecycle S03/S04, storage concurrency |
| Account/chain race | Generation ile eski quote/balance iptali; son anda provider accounts/chain kontrolü | W03 E2E/S05 domain |
| SSRF/private IP/rebinding/redirect | Statik URL’ler, public DNS kontrolü ve pinned lookup, redirect takip edilmez | X01 transport/server testleri |
| RPC write/büyük yanıt | Typed salt okunur method+param allowlist, 1 MB yanıt, 16 KB body, 8s DNS/HTTP, 120 istek/dk; 3×20 history ve 1000-block log sınırı | S02/X02 |
| History poisoning/privacy | Strict schema/size, import+mainnet completion untrusted; bilinmeyen secret field reddi; diagnostic varsayılan sansürlü | P02/P03/X04 |
| Web injection | Nonce script CSP, no eval production, self connect, frame/object/base sınırları, no-referrer, nosniff | production browser smoke/CSP |
| Matematik/MAX/gas | Base units bigint, ambiguous commas rejected, bounded conservative MAX, gas budget ayrı; msg.value padding yok | M01–M06/G01 |

R1 contract-specific observer source calldata/event kimliğini, canonical receipt/finalized tag’i ve ilişkili destination event + tekil CROSS Transfer ödeme kanıtını doğrular. Revert/held ancak kimlik ve kanonik durumdan sonra yorumlanır; aynı miktarlı batch log’u paylaşılmaz. Public status API ve storage/import success yeterli değildir. Quote/health source-build ve harcanabilir rezervi verified saymaz. Wallet write API bu çalışma boyunca çağrılmadı; mainnet submission boundary env/API flags ve claimed verified deployment’dan bağımsız olarak registry null koşuluyla kapanır. İzinsiz imza/approve/permit, V2 topup/V3 swap yok.

## Dependency ve lisans

Tam sürümler `package.json`, çözüm `pnpm-lock.yaml`. SDK kurulu değil; metadata MIT. `bridge-contracts` README MIT; üçüncü taraf Solidity kodu vendoring yapılmadı. Test Solidity fixture’ı bu projede sentetik amaçla yazıldı. Marka işareti özgün inline SVG; sistem fontları kullanılır.

`dependency-licenses.json` kurulu paket lisanslarını kaydeder (legacy `licenses` alanı dahil). `unrs-resolver` postinstall incelendi ve çalıştırılmadı; optional prebuilt binary ile lint başarılı. pnpm’in kurulumda eklediği exact sürüm release-age exclusion listesi yalnızca kilitli seçilmiş paketleri kapsar; auth/OS güvenlik kontrolü gevşetilmedi. Gelecek bağımlılık değişiklikleri yeniden incelenmelidir.

İlk audit: solc→tmp 0.2.6 için GHSA-7c78-jf6q-g5cm high. Hedefli `solc>tmp: 0.2.7` override ve tekrar test ile düzeltildi; force audit fix/ignore yapılmadı. Son audit 0 bulgu. ESLint 9.39.5 dev-only ve upstream deprecated; Next lint plugin peer aralığı ESLint 10’u henüz kabul etmediği için uyumlu sürüm korundu. Bu bilgi saklanmadı; upgrade sonrası peer/type/lint yeniden kontrol edilmeli.

Style CSP inline CSS’e izin verir, script CSP nonce kullanır. Browser localStorage şifreli veya attacker-proof değildir; private key/session/signature saklanmaz. Analytics kapalı. Public RPC servisleri query bilgilerini görebilir. Emergency write lock tracking/okuma ekranlarını kapatmaz. Public release için bağımsız kod/protokol incelemesi gerekir.
