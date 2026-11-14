# Otherbridge V1

ONEchain native ONE → BSC kanonik CROSS için bağımsız, harici cüzdan odaklı yerel uygulama. **Canlı gönderim kapalı; entegrasyon doğrulaması BLOCKED.** Yerel senaryolar sentetiktir, canlı settlement kanıtı değildir.

## Çalıştırma

Node 24.18.0 ve pnpm 11.25.0 ile doğrulandı. Bağımlılıklar tam sürüm ve tek lockfile ile kilitlendi.

```powershell
pnpm install --frozen-lockfile
pnpm dev
# http://127.0.0.1:3100 — mainnet-readonly
```

```powershell
pnpm dev:test
# Ayrı sentetik local-test modu. Gerçek cüzdan bağlamayın.
pnpm build
pnpm start
# http://127.0.0.1:3101 — production build, yalnızca yerel preview
```

Production build her zaman mainnet-readonly kullanır. `OTHERBRIDGE_MODE=local-test` veya enable flag’i production’da fixture/gönderim açmaz. R1 salt okunur quote/simulation, limits/health ve iki zincir gözlemcisini gerçek API yoluna bağlar; gönderim kilidi kapalıdır. Source-build eşleşmesi ve harcanabilir rezerv doğrulanmış sayılmaz. Env toggle tek başına yeterli değildir.

## Doğrulama

```powershell
pnpm verify
pnpm test:e2e
node scripts/verify.mjs
node scripts/reproduce.mjs
node scripts/production-smoke.mjs
pnpm verify:live-readonly
```

E2E kendi 3100 loopback test sunucusunu başlatıp durdurur. Port başka uygulamada kullanılıyorsa o uygulamayı durdurmayın. Playwright Chromium gerekirse `pnpm exec playwright install chromium` ile kurulabilir. Testler ayrı tarayıcı context’i ve synthetic provider kullanır; kullanıcı profiline erişmez. In-memory EVM testi özel anahtar, signer, RPC veya deployment kullanmaz.

`verify:live-readonly` G5 tümü geçmediği için **exit 2** verir ve kanıt üretir. Bu sonuç local suite başarısızlığına çevrilmez, canlı başarı olarak da sunulmaz. `scripts/verify.mjs` her komutu ayrı exit code/log ile kaydeder.

## Uygulanan yüzeyler

Bridge, cüzdan seçimi, native miktar/fee/MAX, review, iki zincir takip, Activity/detail, güvenli import/export, Networks, Help, Risk/About ve Settings. TR/EN ve açık/koyu tema. CEX/DEX kullanımı kullanıcıya ait ayrı işlem olarak açıklanır. Keyfi alıcı, reverse bridge, sosyal login, analytics, gas topup ve swap motoru yok.

Mainnet completion yalnız ilişkili source calldata/event, canonical receipt/finalized tag ve BSC bridge event + tekil kanonik CROSS Transfer log’u üzerinden gözlenir. Public history API’si yalnız hedef hash için sınırlı ipucu sağlar. Storage/import başarı iddiası taze kanıt olmadan trusted değildir. R1 kanıtları `evidence/otherbridge-v1/repair-r1/` altındadır; kökteki eski 81+4+8 test kanıtları tarihsel koşu olarak korunmuştur. Local test module yalnız geliştirme sunucusunun kontrollü fixture dalında çalışır; production erişimi testle engellenir.

Başlangıç noktaları: [handoff](OTHERBRIDGE_V1_HANDOFF.md), [mimari](docs/ARCHITECTURE.md), [kaynaklar](docs/SOURCES.md), [güvenlik](docs/SECURITY.md), [runbook](docs/RUNBOOK.md), [test matrisi](docs/TEST_MATRIX.md). V1 release/mainnet-ready veya audited değildir.
