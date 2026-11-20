# Dinamik ağ ve logo kataloğu

3 Ekim 2026 okumalarında 76 LI.FI ağı + explicit ONEchain = 77 kayıt. Bu sayı destek listesi değildir; her sunucu catalog okuması güncel chain/tool verisini normalize eder. EVM/SVM/UTXO/MVM/TVM/STL ve API testnet kayıtları görünür. Testnet bridge quote bu milestone'da kapalıdır. ONEchain 612055 her zaman özel provider'dır; mevcut ONE→BSC kabul formu ve G5 sınırı korunur. Diğer ONE çiftleri/reverse/composition NOT_EXECUTABLE'dır.

Bir ağın görünmesi bir bridge connection veya gerçek quote olduğu anlamına gelmez. Connection metadata teoriktir. Gerçek quote yoksa 'Yürütülebilir rota yok' gösterilir. Public veri kesilirse snapshot stale görünür; teklif/review kapatılır. Native varlık metadata'sı ve token adresleri upstream'den gelir; isimden token, ID'den VM veya wallet adresi uydurulmaz. Büyük chain ID'leri tam string olarak korunur.

Kaynaklar: `catalog-snapshot.json` (stale fallback), `generated-assets.json` (managed görsel map), `public/networks/catalog/` (76 hash adlandırılmış yerel SVG), `public/networks/neutral.svg` (yeni, incelenmemiş asset için metinle geometrik fallback). Güncel API listesi snapshot'tan bağımsızdır. Tüm logosu incelenen kayıtlar kendi gerçek simgesini kullanır; yeni bilinmeyen simge marka gibi taklit edilmez.

`pnpm networks:sync`: önce benzersiz `OTHERBRIDGE_EVIDENCE_ROOT` seçin. Güncel chain metadata'sını okur; yalnız public chain asset URL allowlist'i, HTTPS, deadline/byte/MIME limitleri ve SVG güvenlik parse'ı uygular. Dosyaları içerik hash'li yeni adla `wx` oluşturur; mevcut dosyanın hash'ini kontrol eder. Asset silmez, ONE/BNB simgesini değiştirmez, commit/deploy yapmaz. Manifest diff/source/SHA-256/provenance kayıtları incelenebilir. API'deki arbitrary logoURI tarayıcıya verilmez.

Her ağ: logo/primary/accent/glow/badgeDark/badgeLight/logoSurface/provenance tokenları. 3 haneli SVG hex paletler normalize edilir. Siyah/beyaz resmi logolar mat kontrast plaka alır; logo recolor edilmez. Glow SVG paletinden türetilmiştir, resmi brand color iddiası değildir. ONE/BNB tokenları önceki resmi kaynak notlarıyla korunur. Charcoal merkez, kaynak ve hedefte düşük yoğunluklu ambient ışık; ağ rengi metin yerine bilgi kanalı değildir.

Son kaynak/diff: `evidence/otherbridge-v1-1/multichain-20261002T203410Z-146be9/asset-sync-b/asset-sync.json`. Registry'deki gelecekteki ağları otomatik listeler; yeni asset güvenli sync/inceleme sonrası eklenir. Enum VM sınıfları hardcode desteklenen ağ listesi değildir.
