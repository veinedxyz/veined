# R1 native salt okunur kanıt ve kalan G5 açığı

2 Ekim 2026. Bu kayıt gönderim, fon hareketi, audit veya deployment onayı değildir. Gerçek okuyucu `native-service.ts` → typed bounded `read-only.ts` → public RPC yolunda; quote/health/track gerçek API handler'a bağlıdır. Yazma registry’si null ve production submission=false kalır.

## Runtime ve ABI izi

Public bridge repository ref’i `3a8347cd005d00e50af9194204a55da69f96ddfc`; resmî skill ref’i `8ef4f05a88c053e42b8e17d37feff4207884f618`. Commit/ref ham kayıtları ve Solidity/ABI içerikleri `evidence/otherbridge-v1/repair-r1/sources/` altındadır. Blob SHA commit olarak kullanılmadı.

| Zincir | Proxy / implementation | Keccak-256, decoded runtime bytes |
|---|---|---|
| ONE 612055 proxy | 0xb81d6e000000000000000000000000000000c0de | 0x0dac1e1deb9381d1139c43a9d49d022a4786242e90744abd0f77bf85375b548b |
| ONE implementation | 0x2827865ad5330faf855af8b743c701ae9c818034 | 0x8bb2e9361035520a62a806cf78ff6f325d32c578a63f35ad49263524361e04bc |
| BSC 56 proxy | 0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5 | 0x25b30cfa97d56a7b846443ce92558cf31d86e95966c5afa22dacb0213c52ff9b |
| BSC implementation | 0xac7b8ffed19d670930b8caa0693189b33454e8d8 | 0x47b60de2375276f3ead49ea41f35c58d068d6bd57625d3553db4257476f91f22 |

Her gerçek snapshot implementation slotunu, proxy ve implementation full code'unu belirli block numarasıyla yeniden okur. Hash hex ASCII metnine uygulanmaz; hex önce byte dizisine çözülür. `live/discovery.json` full raw runtime içerir; `native-live-c/native-live-readonly.json` 2026-10-02T04:48:12–04:48:22Z arasında güncel chain/block/hash/slot/code/pair/fee/finality okumalarını kaydeder. ONE latest block 45441964, BSC latest block 125231111. Pinlerin eşleşmesi verified Solidity source-build veya audit kanıtı değildir.

Eski frontend altı alanlı TokenPair ve eski event layout’u bugünkü gözlemle uyuşmadı. Yedi alanlı pair (`localToken, remoteToken, isOrigin, paused, pendingAmount, deposited, minted`) ve BridgeInitiated/BridgeFinalized/BridgePending decoder'ı gerçek raw public ABI cevapları ve logs ile test edildi. `live/discovery.json` eski yanlış pair yorumunu da içerir; **o yorum authoritative değildir**. Düzeltilmiş raw cevaplar `live/corrected-discovery.json` ve `live/corrected-fresh.json` içindedir.

## Ücret, limit, rezerv ve quote

Native source pair origin=false; outgoing amount minted hesabıyla sınırlanır. `crossSupplyLimit` ters yön native finalize kontrolüdür; outgoing max diye kullanılmaz. Verifier getTokenConfig/calculateFee ve denominator, source/destination pair pause, destination finalize pause ve token balance gerçekten okunur. Public source `BaseBridge._initiateBridge` native için exact `msg.value = amount + networkFee + exFee` ister; tarihsel public calldata/event/value bu ilişkiyi de gösterir.

Güncel gözlem minimum 5 ONE, network fee 0.18 ONE, service rate 0 ve paused=false. `min(destination.deposited, tokenBalance) - pendingAmount` sıfır altına düşmeyen muhafazakâr accounting üst sınırıdır; kaynak minted sınırıyla ayrıca daraltılır. **Kesin harcanabilir rezerv veya verified max değildir.** Source-build/kontrat sürümü eşleşmeden ilgili muhasebe semantiği doğrulanmış sayılmaz. Quote gerçek eth_call + eth_estimateGas + gasPrice kullanır; başarılı estimate üzerinde açık %20 margin vardır, fixed gas/simulation fallback yoktur.

Seçilen tarihsel public EOA'nın 12 ONE quote’u güncel yetersiz balance nedeniyle `INSUFFICIENT_GAS_OR_BALANCE` döndü. Başka aday için en fazla iki 1000-block source log sayfası okundu; uygun başka native EOA bulunmadı. Fon taşınmadı veya istenmedi. Deterministik quote testinde gerçek pair/fee ABI kayıtları kullanılır, funded balance/gas simulation transport double'ı açıkça belirtilmiştir; bu test canlı pozitif quote kanıtı değildir.

## Public source → destination ödeme örneği

- Source hash: `0xa6d46ef91f760e68d999d1128ef2eee67e42dc7e05faea2d5ecec242c3a82a05`; block 45411356, 2026-10-01T20:18:04Z; BridgeInitiated index 98483.
- Destination hash: `0xb37fdb02cdf4ec49531368857f696d911f95619f938397099a86b06e4d55db1f`; block 125163152, 2026-10-01T20:18:24Z; canonical CROSS Transfer log index 199, BridgeFinalized log index 200.
- Beneficiary aynı public EOA `0x680ea0e0cb5c52b54f47f118067bd49e6e9be898`; net amount `12094599106825003813`. Source native input/value/fee/event, chain/token/recipient/index ve destination bridge→beneficiary ödeme log’u birlikte eşleşir.

`live/public-settlement.json` raw receipts/transactions/canonical blocks/finalized headers/decoded logs/request kayıtlarını içerir. Public history API yalnız destination hash ipucudur; state/status’u kanıt sayılmaz. Service owner başına en fazla 3×20 history item inceler; bulunamayan eski kayıt pending/unverified kalır. Import/storage destination hash'i de ipucudur ve doğru public receipt kanıtına recovery'yi engellemez. API’deki unrelated swap kayıtları dikkate alınmaz. BSC getLogs kapalı/arşiv erişimi kısıtlı olduğu gözlendi; koruma aşılmadı, anahtarsız direct receipt okumasıyla örnek doğrulandı.

## Finality güven modeli

Rastgele 3/5 confirmation yerine her iki node’un `eth_getBlockByNumber("finalized", false)` cevabı ve receipt block’un canonical hash'i kullanılır. BSC finalized tag’i [resmî API belgesinde](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/bsc-api-list/) tanımlıdır. [go-cross node kaynakları](https://github.com/to-nexus/go-cross) pinned `go-cross-ref.json` ile saklandı; `api_backend.go` finalized tag’ini CurrentFinalBlock’a bağlar, `blockchain.go` Istanbul canonical insertion yolunda safe/finalized header günceller. Bu, RPC/node cevaplarına güvenen read-only politikadır; bağımsız light-client/validator proof’u değildir.

## Dar kalan dış bilgi

Solc `0.8.28+commit.7893614a` resmî binary SHA-256 ile doğrulandı; OpenZeppelin core `acd4ff74de833399287ed6b31b4debf6b2b35527`, upgradeable `3d5fa5c24c411112bab47bec25cfa9ad0af0e6e8` pinlendi. `34019062c601a6b78812a983dce0b4dc003a9c2f`, `36e27b9ffe52f7888f56d0ad70a0bdbc2b569471` ve current Legacy `3a8347cd005d00e50af9194204a55da69f96ddfc` optimizer=1, viaIR true/false ile denendi. Standard JSON sources/settings/dependencies ve tam compiler sonuçları `compile-input-*.json`, `runtime-source-comparison-b.json`, `runtime-source-comparison-current.json` içindedir. Full runtime veya executable prefix eşleşmesi bulunmadı; bazı non-IR sürümler stack-too-deep verdi. Current non-legacy CrossBridge ayrıca linked ForwardLib içerir; onun hash’i deployment kanıtı olarak kullanılmaz. Legacy/UUPS immutable adres ikamesi diagnostic varsayımıdır ve pozitif source match iddiası yapılmaz.

Son bounded retry `sources/metadata-retry-c.json`: her chain’in runtime CBOR IPFS CID’sine istek 429; Sourcify full/partial metadata adresleri 404 (6 istek, istek başına 8 saniye timeout, 1 MiB cevap sınırı). Eski request/başarısız compile çıktıları korunmuştur. Selector/view başarısı source match yerine konulmaz.

Gerekli en küçük operatör bilgisi: bu iki implementation için gerçekten deployment’ta kullanılan tam solc Standard JSON input/metadata (compiler, optimizer/viaIR/EVM/metadata ayarları, source paths/contents, dependency ve linked-library/immutable bilgisi) veya bunlarla birebir runtime eşitliği üreten verified-source kaydı; aynı sürümün native outgoing/destination pending-deposited rezerv semantiği. Özel anahtar, kullanıcı fonu veya imza yetkisi gerekmez. Bu bilgi olmadan **G5 BLOCKED**, yazma kapısı kapalı; G7/G8 çalıştırılmadı.

## 2 October checkpoint-review continuation

New actual probe at07:11:25Z–07:11:36Z (continue-checkpoint-d/live-readonly/) matched pinned current implementations and observed historical index98483 payout again. Main public EOA quote rejected INSUFFICIENT_GAS_OR_BALANCE; two bounded1000-block pages found one additional native EOA below the probe amount. No successful live quote claimed. Accounting bound913509237704937756235899803 remains unverified. Earlier compiler mismatch/IPFS429/Sourcify404 evidence retained without rerunning same failed combinations. Source-build and spendable-reserve G5 BLOCKED. Current tracker searches max3x20 history even after stored HELD/reorg evidence; exhausted search is explicitly bounded, not proof of non-delivery. [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193) was reread for accountsChanged grant ordering and4001 semantics; permission/rejection code changes are verified with isolated provider doubles, not physical wallets.
