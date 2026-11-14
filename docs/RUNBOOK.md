# V1.14 global DeFi universe — güncel

Ayrıntı: `docs/DEFI_UNIVERSE.md`, `docs/V114_TEST_MATRIX.md`. Tümü salt okunurdur; cüzdan, imza, approve/permit, broadcast, deploy ve fee yoktur.

- Katalog senkronu: `pnpm defi:universe:sync` (yalnız izinli hostlar, sınırlı boyut/gzip; parity, alias, anomali kontrolü). Reddedilen senkron son iyi kataloğu değiştirmez; incelenen kodu kabul etmek için `--accept-review=CODE`. Kuru çalıştırma `--dry-run`; fixture `--fixture <dir> --out <dir>`; kanıt `--evidence <dir>`.
- Raporlar: `pnpm defi:universe:report` (adapter kuyruğu, kapsam, ağlar, kaynak/lisans envanteri).
- Veritabanı: `pnpm data:db:migrate` (0005, yalnız ileri), `pnpm defi:sync` (incelenmiş deployment registry), `pnpm defi:universe:load` (kabul edilen katalog, idempotent).
- Registry lane backfill (ör. Morpho): `OTHERBRIDGE_DEFI_LOG_RPC_1=<izinli https log kaynağı> node --env-file=.env.data.local --experimental-transform-types --import ./scripts/ts-hooks.mjs services/defi.ts lane morpho-blue-1 markets` (tekrar çalıştırılabilir, reorg güvenli; `historical_complete` olmadan kayıt tam sayılmaz).
- Gerçek nonzero kanıtlar: `pnpm defi:proofs --only=<id> --out=<benzersiz kanıt dizini>` (iki bağımsız endpoint, kişi kimliği yok).
- Yeni adapter yalnız resmi kaynaktaki literal adres veya kayıtlı zincir üstü türetme ile eklenir (`src/defi/sources/`, `scripts/defi-registry.mjs`); katalog değişikliği finansal mantığı açamaz.

---

# V1.5 pre-release hardening — güncel

Önce `OTHERBRIDGE_V1_HANDOFF.md`, `docs/V15_TEST_MATRIX.md` ve `docs/SECURITY_RELEASE_GATE.md` okuyun. V1.4 komutları aşağıda geçerlidir; V1.5 ekleri:

- Indexer tanık politikası: `pnpm data:indexer:run --witness required` (release semantiği; bağımsız tanık yoksa commit yok, `WITNESS_UNAVAILABLE`) veya varsayılan `best-effort` (yalnız geliştirme; tanıksız pencereler `NO_INDEPENDENT_WITNESS` olarak işaretlenir ve release-eligible sayılmaz). Geçersiz değer başlangıçta reddedilir.
- Uzlaşmazlık: zincir `HALTED` (`LOG_CONSENSUS_UNRESOLVED:from-to`) olur; veriyi silmeyin/düzenlemeyin. İnceleme sonrası `pnpm data:indexer:resume --chain <id> --reason "<gerekçe>" --yes`. Ayrıntı: `docs/RUNBOOK_INDEXER_INCIDENT.md`, `docs/RUNBOOK_RPC_INCIDENT.md`.
- Eski (V1.5 öncesi) pencereleri yeniden doğrulama: `pnpm data:indexer:rewitness --chain <id>`; geriye backfill: `pnpm data:indexer:backfill --chain <id> --max-windows N`.
- `pnpm data:verify-index` artık integrity/eligibility (FULL_INDEXED_RELEASE_ELIGIBLE / FULL_INDEXED_DEVELOPMENT ve blocker listesi) raporlar; `pnpm data:rpc:provenance` RPC operatör/terms envanterini ve profil kabulünü (`development`/`staging`/`release`) gösterir.
- İzleme: `pnpm data:ops-exporter` (monitor rolü, iç port, token zorunlu); Prometheus/Alertmanager/Grafana yerel profili `infra/monitoring/` (`docs/RUNBOOK_MONITORING.md`). `/v1/metrics` public API'den kaldırıldı.
- Yedek: `pnpm data:backup:create|verify|list|prune|restore-test|corruption-test|drill-cleanup` (yedekler repo dışında; restore yalnız yeni izole instance'a; prune varsayılan dry-run). Ayrıntı: `docs/RUNBOOK_BACKUP_RESTORE.md`.
- Staging-eşdeğeri yerel yığın: `node scripts/staging.mjs init|up|down|status` (`docs/RUNBOOK_STAGING.md`); smoke `node scripts/v15-staging-smoke.mjs`. Bu production deploy değildir; DNS değişmez.
- CSP kabulü: `pnpm build` sonrası `node scripts/v15-csp.mjs`; güvenlik/adversarial: `node scripts/v15-security.mjs`.

Gerçek imza/approve/permit/broadcast/deploy/fee yoktur; G7 ve production release onaysız kapalıdır; ONEchain G5 BLOCKED_EXTERNAL_EVIDENCE.

---

# V1.4 self-hosted veri düzlemi — güncel

Ücretli portfolio/indexer API yoktur. Yerel izole PostgreSQL (Docker, yalnız 127.0.0.1:55471): `pnpm data:db:init` (git-ignored `.env.data.local` içine rastgele parolalar üretir; değerleri yazdırmaz), `pnpm data:db:up`, `pnpm data:db:migrate` (up-only, checksum, tekrar güvenli; roller SCRAM doğrulayıcıyla), `pnpm data:chains:sync`, `pnpm data:rpc:sync --write-snapshot` (aday → URL politikası → public DNS → chainId → read-only probe), `pnpm data:rpc:health --measure-logs`, `pnpm data:tokens:sync`, `pnpm data:indexer:once [--chain id]` / `pnpm data:indexer:run --cycles N` (lease + graceful shutdown), `pnpm data:coverage`, `pnpm data:verify-index` (tutarsızlıkta exit≠0), `pnpm data:verify`, `pnpm data:retention`.

Yerel geliştirici API (yayınlanmadı, billing kapalı): `pnpm data:api:dev` → http://127.0.0.1:3200/v1/docs. Anahtar: `pnpm data:client:create --name ... --plan internal --scopes chains:read,...`, `pnpm data:key:create --client cli_... --yes` (gizli değer yalnız bir kez terminale; yönlendirilmiş stdout için `--stdout-json` gerekir ve hedef repo dışında olmalı), `pnpm data:key:revoke --key ...`, `pnpm data:usage:show --client ...`. Test: `pnpm test:db` (geçici veritabanı oluşturur ve siler). Production smoke: `node --env-file=.env.data.local scripts/production-v14.mjs` (önce `pnpm build`; benzersiz OTHERBRIDGE_EVIDENCE_ROOT). Her koşuya benzersiz evidence dizini verin; `verify-safety` artık varsayılan olarak eski kanıtın üzerine yazmaz. Başka projenin container/port/sürecine dokunmayın; durdurma: `pnpm data:db:stop`.

Gerçek imza/approve/permit/broadcast/deploy/fee yoktur; G7 ve production release onaysız kapalıdır.

---

# Multichain salt okunur yerel kontrol — güncel

Önce güncel handoff ve MULTICHAIN_TEST_MATRIX.md dosyasını okuyun. Node 24.18.0, pnpm 11.25.0; `pnpm install --frozen-lockfile`, `pnpm dev` (3100). `pnpm build` / `pnpm start` (3101) yalnız loopback preview'dur. Gerçek .env/anahtar gerekmez; örnek değerler gönderimi kapalı tutar. Başka uygulamanın port sürecini durdurmayın.

Ağ seçicide canlı public katalog okunur. Ethereum/Base veya başka farklı mainnet çiftini, gerçek katalogdaki iki asset'i, pozitif miktarı ve native VM formatında public adresleri seçin. 'Rotayı oku' yalnız API quote gözlemidir; bağlı cüzdan, balance/allowance yeterliliği veya execution izni değildir. Formda context değiştirip eski review'un kapandığını doğrulayın. ONE özel rotaları G5 kapalı; no-route/stale/rate-limit açık hata gösterir. Activity yalnız preview kaydeder; harici hash gözlemi context bağlı güncel provider cevabı ister ve reload'da tamamlanma saklamaz.

Her koşuya benzersiz OTHERBRIDGE_EVIDENCE_ROOT verin. `node scripts/repair-run.mjs check-name ...` source/hash/Git/raw log kaydeder. **Wrapper check-name ile alt komutun yazdığı JSON basename'i aynı olmamalı** (ör. probe için bounded-probe; live-readonly veya reproducibility adı kullanmayın). `pnpm exec vitest run --config scripts/live-routing.vitest.config.ts` en çok yedi public GET yapar; test runner'ın geçmesi M9 PASS demek değildir: live-readonly.json içindeki gate ve gerçek quote kaydını okuyun. API availability anlık değişebilir; otomatik quote retry yoktur.

`pnpm networks:sync` aynı benzersiz evidence şartıyla yeni hash'li asset/source/diff üretir. Mevcut logo veya özel kayıt silmez, commit/deploy yapmaz. SVG metadata arbitrary URL olarak yüklenmez. Normal kabul: verify, test:e2e, production-smoke.mjs, production-multichain.mjs; her production runner kendi loopback child'ını kapatır. reproduce.mjs artık public asset'leri de yeni izole dependency tree'ye kopyalar.

M11 NOT_RUN — USER_APPROVAL_REQUIRED; M12 BLOCKED — RELEASE_APPROVAL_REQUIRED. Bu milestone bitişinde gerçek execution, G7, release, V2/V3 veya yeni faz başlatmayın. Aşağıdaki önceki R1 runbook tarihsel native kabul sınırlarıdır.

---

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
# Public copy regression

For a copy-only repair, preserve the provider/dependency versions, all route keys, financial values, wallet VM behavior and the false/null execution gate. Product labels use `src/content/public-labels.ts`; technical dependency names and licenses remain in `docs/INTERNAL/THIRD_PARTY_NOTICES.md`, package/import records and raw evidence.

With a fresh unique `OTHERBRIDGE_EVIDENCE_ROOT`, run `node scripts/public-brand-check.mjs` for all normal public Markdown docs. This intentionally excludes only technical/legal internal records, raw evidence, dependency/import files and original user instructions. Brand detection is case insensitive and recognizes brand tokens; ordinary Turkish words such as "teklifi" are not a vendor identity.

Run unit/integration/E2E/build and both existing production smoke runners in separate unique evidence directories. Production runners check full `document.body.textContent` and save raw text receipts. The multichain runner requires an actual salt-read-only Ethereum→Base review, captures both languages and preserves actual quote response bodies. A missing real quote blocks that acceptance; a synthetic fixture cannot replace it. No signing wallet is required. Inspect the new screenshot, verify source hashes, update the handoff and create a new review bundle without altering earlier evidence.

## V1.2 verification

Read G5_FINAL_EVIDENCE.md before interpreting a probe result. A passing observer test is not G5 readiness. Preserve the exact build/reserve/archive/current-simulation blocker and keep production writes closed.

Use a fresh OTHERBRIDGE_EVIDENCE_ROOT for every repair/retest. Run frozen install, pnpm verify, pnpm test:e2e, the existing production-smoke and production-multichain runners, and production-i18n.mjs against the final production build. The i18n schema check is part of build. E2E fixtures label synthetic quotes and cannot establish live liquidity; the production routing runner retains actual ETH→Base response evidence. Check all 24 SSR locale pages, seven representative languages in both themes at 360/390/768/1440, and AR/FA/HE/UR selector/review/detail behavior at 360/1440. Save raw axe/browser/text receipts and screenshots, inspect them, bind final source hashes and verify a new safe ZIP CRC/SHA-256.

The SSR locale cookie takes precedence over the legacy local preference. For deterministic tests seed both consistently. Unsupported preferences resolve through Accept-Language and English; missing dictionary keys never fall back. In the header or Settings use the searchable native-name selector; selected locale persists on reload. Decimal input accepts the supported local separator or safe ASCII point; grouping and ambiguous values are rejected. See I18N_ARCHITECTURE.md and I18N_TEST_MATRIX.md for complete contracts and known editorial limits.
