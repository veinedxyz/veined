import { readFile, writeFile } from "node:fs/promises";
const root = "evidence/otherbridge-v1";
const inventory = JSON.parse(
  await readFile(`${root}/source-inventory.json`, "utf8"),
);
const reviewed = new Set([
  "A07",
  "A08",
  "A19",
  "B01",
  "B02",
  "B04a",
  "B05",
  "B06",
  "B07",
  "B08",
  "B13",
]);
for (const item of inventory) {
  item.review = reviewed.has(item.id)
    ? "okundu — V1 ilgili bölümler"
    : item.status === 200
      ? "kısmen erişildi — yalnız erişim/envanter; tüm içerik incelemesi değil"
      : item.status === "unreachable" || item.status >= 400
        ? "erişilemedi"
        : "bu çalışmada henüz incelenmedi";
}
await writeFile(
  `${root}/source-inventory.json`,
  JSON.stringify(inventory, null, 2),
);
let details = {};
try {
  const commit = await (
    await fetch(
      "https://api.github.com/repos/to-nexus/bridge-contracts/commits/dev",
      { signal: AbortSignal.timeout(10000), redirect: "error" },
    )
  ).json();
  const url = `https://raw.githubusercontent.com/to-nexus/bridge-contracts/${commit.sha}/src/interface/IBaseBridge.sol`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  const content = await response.text();
  if (response.ok)
    await writeFile(`${root}/source-IBaseBridge.sol.txt`, content);
  details = {
    repository: "to-nexus/bridge-contracts",
    branch: "dev",
    commit: commit.sha,
    url,
    status: response.status,
    review:
      "Generic ABI interface read; mainnet bytecode compatibility NOT established",
    at: new Date().toISOString(),
  };
  await writeFile(`${root}/abi-source.json`, JSON.stringify(details, null, 2));
} catch {
  details = {
    review:
      "Pinned interface access unavailable; generic README remains documented-only",
  };
}
const header = `# Kaynaklar ve canlı gözlemler\n\n1 Ekim 2026. Master Ek A/B tüm 40 URL envantere alındı. HTTP200 tam içerik incelemesi veya canlı readiness değildir. Dinamik token/bridge yüzeyi ve whitepaper’lar deployment ABI yerine kullanılmadı.\n\n## Kritik sonuçlar\n\n- A07 README: BSC kanonik Cross/CROSS adresi ve rezervler arası özel ONE/CROSS mekanizması. On-chain okuma name=Cross, symbol=CROSS, decimals=18 ve code varlığını doğruladı.\n- A08 generic bridge README/API: native sentinel address(1), empty extraData, exact msg.value. Bu davranış native ONE canlı deployment’a taşınmış sayılmadı. ${details.commit ? `İncelenen generic interface commit ${details.commit}.` : ""}\n- B01/B02 SDK 1.4.2 npm metadata MIT, React19/wagmi2–3/query5 peers; doküman owned CROSS/Reown project ID gerektiriyor. SDK kurulmadı, borrowed ID yok.\n- Resmî legacy B04a endpoint kaynağı üzerinden public pair/chain-info GET 200: native ONE 612055 → CROSS BSC56 aday route bulundu. ONE RPC chain-info’dan, BSC RPC [BNB Chain resmî kaynağından](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/) seçildi; API’deki keyed BSC RPC URL kopyalanıp kullanılmadı. Evidence chain-info keyed paths sansürlü.\n- 2026-10-01T11:18:00Z (14:18 İstanbul) live probe: chain IDs 612055/56, token code4338bytes, proxy code163bytes. Source proxy 0xb81d6e000000000000000000000000000000c0de, source implementation 0x2827865ad5330faf855af8b743c701ae9c818034. Destination proxy 0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5, implementation 0xac7b8ffed19d670930b8caa0693189b33454e8d8. Bunlar gözlemdir; audit/code-match değildir.\n- [ONEchain explorer source contract](https://explorer.onechain.nexus/612055/address/0xb81d6e000000000000000000000000000000c0de) adresi Cross Bridge olarak gösterdi. BscScan contract code web erişimi403; bypass yapılmadı. Source/destination public örnek eşleşmesi, finality, spendable reserve ve live quote/limit/pause kanıtı tamamlanmadı. Toplam bakiye kullanılabilir rezerv sayılmadı.\n- A13 audit kapsamı deployment/commit ile doğrulanmadı; audit rozeti verilmedi. A14–A18 ticari/tarihsel bağlam envanteri; token/grant/onramp yeni kapsamına dönüştürülmedi.\n- Next16.3.8 bundle AGENTS generator dosyaları korundu; bundled layouts/pages, route-handlers, CSP ve devIndicators rehberleri incelendi. EIP1193/6963/3085/3326 standartları seçilen injected bağlantının temelidir. viem encode/decode ve Playwright API’leri kurulu sürümde type/build/browser ile doğrulandı.\n\n## Kaynak envanteri\n\n| ID | URL | Durum | HTTP / erişim |\n|---|---|---|---|\n`;
await writeFile(
  "docs/SOURCES.md",
  header +
    inventory
      .map(
        (i) => `| ${i.id} | [kaynak](${i.url}) | ${i.review} | ${i.status} |`,
      )
      .join("\n") +
    "\n\nAsıl gözlem zamanları source-inventory.json’da; public API, repo ve zincir kanıtları ayrı tutulur. G5: BLOCKED. MAINNET_E2E: NOT_RUN.\n",
);
console.log("Source summary", inventory.length, details.commit ?? "no commit");
