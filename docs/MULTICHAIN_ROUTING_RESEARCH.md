# Salt okunur rota verisi araştırması

Otherbridge mevcut sunucu adapter'ı üzerinden güncel chain/tool/connection/token/quote/status verisini okur. Bu public belge ürün davranışını açıklar. Gerçek bağımlılık kimlikleri, lisanslar ve sağlayıcı kaynak bağlantıları yalnız [teknik kayıt](INTERNAL/THIRD_PARTY_NOTICES.md) içindedir. Mimari ve provider seçimi bu metin onarımında değiştirilmedi.

SDK v4 client konfigürasyonu yalnız sunucudadır. ChainTypes EVM, SVM, UTXO, MVM, TVM, STL; büyük ağ ID'leri string tutulur. Connections cevabındaki chain/address metadata'sı gerektiğinde gerçek token verisiyle tamamlanır. İç ücret toplama adımı teknik incelemede nötr "Rota hizmet ücreti" olarak görünür; bilinmeyen tool kabul edilmez. Gerçek bridge/protokol adları teknik rota incelemesinde açıklanır.

Resmi salt okunur REST GET okumaları mevcut adapter'da 4 MB, 10 saniye, DNS pinning, redirect reddi ve runtime şema denetimiyle sınırlıdır. SDK quote action'larının doğrudan çağrıldığı iddia edilmez. Execution provider yoktur; preload/version probe kapalıdır. Önceki kanıtlarda public API anahtarsız çalıştı; anahtar veya Otherbridge tarafından integrator ücreti tahsilatı yoktur. Teklifler gerçek bridge/protokol hizmet ve gas maliyetleri içerebilir. Public kotaya bağlı geçici hata veya rota yokluğu başarı gibi gösterilmez.

76 ağın public metadata logoları güvenli yerel SVG olarak saklanır. Ağ sahibinin marka onayı iddia edilmez. Kaynak URL, SHA-256, MIME, byte boyutu ve türetilmiş ambient renk notu mevcut asset-sync kaydındadır. Önceki resmi ONE/BNB simgeleri korunur. Logo geometri/rengi değişmez; ambient palet resmi marka rengi garantisi değildir. Marka haklarının devri, ortaklık veya sponsorluk iddiası yoktur.

Önceki kaynak araştırması ve eski public metinlerin özgün byte kopyaları internal tarihsel arşivde korunur. Bunlar güncel ürün metni veya kullanıcı talimatının yeni yorumu değildir. Yeni salt okunur testlerin sonuçları, tarihleri ve çalışma ağacı checkpoint'i güncel handoff'ta ayrı belirtilir.
