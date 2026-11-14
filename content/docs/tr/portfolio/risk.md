# Protokol risk metrikleri

Aave protokol-native sağlık faktörü kullanır. Compound III borcun teminatlandırılmış ve likide edilebilir durumlarını kullanır. Morpho, yalnız oracle semantiği doğrulandıysa LTV/LLTV/marj gösterir; mevcut production oracle registry incelenmediği için metrik mevcut değil olarak döner. Ortak hayali bir sağlık faktörü üretilmez.

Veri 60 saniyeden eskiyse güncel risk olarak gösterilmez. “Pozisyon dikkat gerektirebilir” bilgi amaçlıdır, likidasyon tahmini değildir. Fiyatsız borç, kontrol edilmemiş protokol veya başarısız okuma güvenli pozisyon anlamına gelmez. APY doğrulanamıyorsa gösterilmez.
