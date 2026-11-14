# Geliştiriciler

## Data API

{{BRAND}} Data API'si zincirleri, kapsamı, token meta verisini ve bakiyeleri kendi barındırdığımız veri katmanından sunar. API ile birlikte sunulan bir **OpenAPI** belgesiyle tanımlanır ve her yanıt bir istek kimliği taşır.

- **Taban**: Data API host'unda `/v1/...` (uygulamadan ayrı).
- **Önce kapsam**: her bakiye yanıtı ağın katmanını ve gözlenen bloğu belirtir; kontrol edilmeyen bir ağ öyle bildirilir, asla sıfır olarak değil.

## Anahtarlar ve kapsamlar

API erişimi istemci başına verilen anahtarlarla yapılır. Anahtarlar bir kez gösterilir, yalnızca doğrulayıcı olarak saklanır ve kapsamlar taşır (örneğin kapsam, tokenlar, bakiyeler). Anahtarlar anında iptal edilebilir; kullanım cüzdan etiketi olmadan istemci başına kaydedilir.

## Hız sınırları

Her planın dakika başına bir sınırı ve bir eşzamanlılık sınırı vardır; paylaşılan bir sınırlayıcıyla uygulanır. `429` yanıtı sınıra ulaşıldığı anlamına gelir; pencereden sonra tekrar deneyin.

## Varlık kaydı API'si (uygulama)

Uygulama `list`, `search` ve `preview` eylemleriyle `POST /api/assets` kullanır. Yalnızca bir zincir kimliği ve bir sorgu veya tam token adresi kabul eder — asla cüzdan verisi değil — ve hız sınırlıdır. Logolar `/api/asset-image/<sha256>` adresinden `nosniff` ve korumalı alan CSP'siyle temizlenmiş baytlar olarak sunulur.

## Sabitler

| Sabit | Değer |
| --- | --- |
| {{BRAND}} ücreti | {{FEE_BPS}} bps |
| Gönderim | {{SENDING}} |
| Uygulama dilleri | {{LOCALES}} |
| Katalogdaki ana ağlar | {{MAINNETS}} |
