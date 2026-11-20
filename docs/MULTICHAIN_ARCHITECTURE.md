# Multichain mimarisi

Mevcut domain `src/routing/`: Network/Asset/Catalog/Tool/Connection/RoutingQuote/RouteStep/Fee/ExecutionRequirement/RouteStatus, `NetworkCatalogProvider` ve `RouteProvider`. Public provider ID `routing-core`; özel ONE provider `otherbridge-onebridge`. Ürün markası Otherbridge'dir. Gerçek bridge/exchange protokol isimleri teknik rota incelemesinde gösterilir. Sağlayıcının step türleri nötr `bridge`/`exchange` türlerine normalize edilir.

Public etiketler `src/content/public-labels.ts` üzerinden normalize edilir. Katalog tool ID'leri, quote binding, protokol kimliği, ücret miktarı/tokenı/included durumu değişmez. Sağlayıcı hizmet ücretleri "Rota hizmet ücreti" / "Route service fee" olarak gösterilir; bu ifade Otherbridge'in ücret tahsil ettiği anlamına gelmez. Review ve Activity, eski/raw etiketler için de aynı gösterim korumasını uygular. Teknik bağımlılık ve kaynak kayıtları `docs/INTERNAL/THIRD_PARTY_NOTICES.md` içindedir; ürün ekranına aktarılmaz.

`src/adapters/routing-core.ts` tek upstream adapter'ıdır. Resmi SDK v4 client sadece sunucudadır. `src/app/api/routing/route.ts` sınırlı same-origin POST read actions sunar. UI upstream URL, API anahtarı, transactionRequest veya SDK execution nesnesi almaz. Upstream payload runtime şemadan geçer; işlem calldata/typedData tamamen çıkarılır.

Katalog, güncel `/chains` + `/tools` ile oluşturulur. Paketlenmiş snapshot yalnız stale görünüm içindir. `src/routing/custom.ts` explicit ONE kaydı ve mevcut kabul edilmiş ONE→BSC formunu açılışta koruyan BSC bootstrap kimliğini içerir; mainstream destek listesi değildir. Güncel katalog bootstrap BSC yerine provider kaydını kullanır. ONE çakışmasında özel adapter kazanır. Yeni özel ağ, merge registry'ye eklenebilir; routing transport değiştirilmez. ONEbridge eski adapter, decoder, finansal core, wallet ve lifecycle dosyaları korunur.

İlk açılış kabul edilmiş ONE→BSC formudur. Ağ seçici, mainstream form ve katalog sayfası dynamic import ile açılır. Diğer VM browser read connector'ları ancak açık bağlantı isteğinde yüklenir. Network listesi 72 px satırlarla virtualize edilir, görünür en çok 10 seçenek olur. Token verisinin tamamı aranır; DOM select en çok ilk 100 arama eşleşmesini gösterir, adres seçimi ve tam adres metni korunur. EVM olmayan alıcı alanına EVM adresi otomatik yazılmaz.

Public katalog 5 dakika cache/coalescing, public token katalogları 5 dakika/en çok 20 chain; hesap bağlı teklif cache'i yoktur. Quote yalnız kullanıcı isteğinde okunur. Ağ/form/hesap/katalog değişimleri quote ve review bağını bozar. Gönderim gate sabit false/null'dır. Stale ağ görünmesi, connection bulunması, quote okunması ve execution izni ayrı durumlardır.

History: yeni `otherbridge:routing-previews:v1` namespace, orijinal ONE geçmişiyle karışmaz. QUOTE_PREVIEW kayıtları public adres/asset/steps ve quote binding taşır. Harici hash eklemek bir ipucudur; bu uygulamanın gönderim yaptığı anlamına gelmez. Güncel context bağlı provider durum gözlemi yalnız bellekte 30 saniye görünür. Reload/import tamamlanma kanıtı üretmez.

Yerel build/start production deploy değildir. Ölçülen HEAD ve final çalışma ağacı SHA-256 inventory devirde/pakette bulunur; bu milestone için commit yaratılmadı. Performans karşılaştırması aynı HEAD'in yeni izole arşiv build'i ile yapılır; önceki kaynak ağacına reset/clean uygulanmaz.
