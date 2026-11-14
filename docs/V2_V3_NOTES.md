# V2/V3 — yalnızca genişleme sınırları

`src/core/extensions.ts` capability ve interface’leri içerir; çalışan provider yoktur. Gas temini ve swap bugün `unsupported`.

V2: hedef native gas varlığı, source ödeme ağı ve hedef teslimat ayrı belirlenir. Stok/likidite/provider/sponsorluk olmadan token oluşmaz. Source gas sıfırsa sıradan tx başlayamaz; doğrulanmış sponsorship, ön fonlama veya başka ağdan ödeme ayrı finansman/güvenlik gerektirir. Topup quote, fee, delivery/refund/timeout; treasury/custody/relayer/paymaster anahtar yönetimi; abuse/Sybil, rate limit, muhasebe ve zarar sınırları ayrı faz kapsamıdır. V1 bridge’in ileride bu capability’yi desteklediği varsayılmaz.

V3: SwapProvider bridge adapter’dan ayrıdır. Native/wrapped ayrımı, router allowlist, approval, slippage, price impact, minimum output ve quote expiry doğrulanmalıdır. Bridge+swap atomic değildir; köprü tamamlanıp swap başarısız olabilir. Her bacağın gas’ı ve recovery yolu gerekir. Gerçek likidite/router doğrulaması ve ayrı release onayı olmadan uygulanmaz. Help’te harici DEX kullanımı açıklanması entegre swap veya V3 teslimatı değildir.
