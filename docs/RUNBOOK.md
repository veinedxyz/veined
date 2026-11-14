# Yerel kullanım ve manuel kabul

Önce `OTHERBRIDGE_V1_HANDOFF.md` ve `evidence/otherbridge-v1/repair-r1/acceptance-c/commands.json` dosyalarını oku. Normal mod `pnpm dev` (127.0.0.1:3100), production preview `pnpm build; pnpm start` (127.0.0.1:3101). Bu komut production deploy değildir. Port doluysa başka projeyi öldürme; kendi süreç kimliğini doğrula.

Test modu `pnpm dev:test` yalnızca geliştirmede kullanılabilir. Gerçek cüzdan/aktif kullanıcı profiliyle test otomasyonu çalıştırma. Playwright kendi izole context/provider’ını oluşturur. Source balance/quote unavailable ekranı gerçek sıfır değildir. Bilinmeyen rezerv/fee’yi sıfırla doldurma.

Normal hata: diagnose → en küçük onarım → ilgili test → regression → kanıt. Eski kanıtı ezmemek için her koşuda yeni `OTHERBRIDGE_EVIDENCE_ROOT` seç; wrapper `node scripts/repair-run.mjs unique-name ...` HEAD/source SHA-256/command/log/exit code kaydeder. E2E JSON, screenshot ve output dizini aynı unique root’a yönlenir. Eski `pnpm verify:live-readonly` G5 BLOCKED exit2 raporudur. Yeni gerçek okuyucu probe’u `pnpm exec vitest run --config scripts/live-native.vitest.config.ts` yalnız ayrı kanıt diziniyle opt-in çalıştırılır; PASS’i quote/G5 readiness diye yorumlama.

## Kullanıcı döndüğünde — executor bu adımları uygulamadı

1. Diff/kanıtlar bağımsız incelenir. Güncel native ONE deployment/implementation/ABI, fee/min/max/pause, harcanabilir rezerv, source-event/destination payout ilişkisi ve finality politikası doğrulanır. Generic ABI veya token bakiyesi tek başına yeterli değildir.
2. Gerekiyorsa kullanıcı kendi public provider/project ID’lerini yapılandırır. Seed/private key paylaşılmaz. SDK ve doğrudan yol arasında doğrulanmış tek entegrasyon korunur.
3. R1’de bağlı salt okunur native quote/simulation/tracker yolunun source-build ve harcanabilir rezerv kanıtı tamamlanır; bundan sonra kapalı yazma sınırı ayrı güvenlik ve kullanıcı kabul incelemesine hazırlanır. **Mevcut flag’i true yapmak gönderimi açmaz; bu devir canlı transfer hazır değildir.**
4. Kullanıcı kendi gerçek cüzdanını kendisi bağlar. EOA/smart account desteği, kaynak/aynı BSC alıcı, bakiye ve gas kontrol edilir. CEX adresi alıcı olarak kullanılmaz.
5. Güncel minimumun üzerindeki küçük miktar için ayrı açık onay verilir; kullanıcı review ve wallet onayını kendisi yapar. Sabit/desteksiz kabul miktarı yoktur.
6. Kaynak event/index, iki zincir receipt/finality, doğru BSC token/alıcı/tutar birlikte doğrulanır. Pending/held/unknown varsa tekrar otomatik gönderim/refund/claim yok. Büyük bakiye taşınmaz.
7. Başarılı tek manuel test public release onayı değildir. Hosting/domain/DNS/hukuk/ticari koşullar ve bağımsız inceleme ayrı değerlendirilir.

`MAINNET_E2E: NOT_RUN — USER_APPROVAL_REQUIRED`. `PUBLIC_RELEASE: BLOCKED — RELEASE_APPROVAL_REQUIRED`.

R1 manual recovery: a hashless mainnet record is not a trusted rejection after reload. Preserve it and inspect wallet history yourself. If a source transaction hash exists, enter it in the Activity detail hash recovery field; this saves only a candidate and reruns read-only source/destination validation. It never signs, retries, deletes the intent or claims delivery without proof. If no hash/proof is available, uncertainty stays blocked; no automatic unlock. Existing known source hashes cannot be overwritten by this field.
