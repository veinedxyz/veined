import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const base = `${(await readFile(".otherbridge/v12-evidence-path.txt", "utf8")).trim()}/g5/research`;
await mkdir(base, { recursive: true });
const requests = [];
async function get(url, file, json = false) {
  const item = { url, file, at: new Date().toISOString() };
  requests.push(item);
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      redirect: "error",
      headers: {
        Accept: "application/json",
        "User-Agent": "Otherbridge-readonly-evidence",
      },
    });
    item.status = response.status;
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 4000000) throw Error("SIZE_LIMIT");
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    item.sha256 = createHash("sha256").update(body).digest("hex");
    await writeFile(`${base}/${file}`, body, { flag: "wx" });
    if (response.ok) return json ? JSON.parse(body) : body;
  } catch (e) {
    item.error = e.message;
  } finally {
    await writeFile(`${base}/requests.json`, JSON.stringify(requests, null, 2));
  }
}
const ref = await get(
  "https://api.github.com/repos/to-nexus/bridge-contracts/commits/dev",
  "ref.json",
  true,
);
await get(
  "https://api.github.com/repos/to-nexus/bridge-contracts/tags?per_page=30",
  "tags.json",
);
await get(
  "https://api.github.com/repos/to-nexus/bridge-contracts/commits?path=test/legacy/CrossBridgeLegacy.sol&per_page=20",
  "legacy-history.json",
);
if (ref?.sha) {
  const tree = await get(
    `https://api.github.com/repos/to-nexus/bridge-contracts/git/trees/${ref.sha}?recursive=1`,
    "tree.json",
    true,
  );
  const paths = [
    "test/legacy/CrossBridgeLegacy.sol",
    "src/BaseBridge.sol",
    "src/BridgeRegistry.sol",
    "foundry.toml",
    "foundry.lock",
    "README.md",
    ...(tree?.tree ?? [])
      .filter(
        (x) =>
          /broadcast|deployment|deploy.*json|metadata/i.test(x.path) &&
          x.type === "blob",
      )
      .slice(0, 12)
      .map((x) => x.path),
  ];
  for (const path of paths)
    await get(
      `https://raw.githubusercontent.com/to-nexus/bridge-contracts/${ref.sha}/${path}`,
      path.replaceAll("/", "_"),
    );
}
const previous = JSON.parse(
  await readFile(
    "evidence/otherbridge-v1/repair-r1/live/discovery.json",
    "utf8",
  ),
);
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
for (const [chain, s] of Object.entries(previous.snapshots)) {
  const digest = /697066735822(1220[0-9a-f]{64})/.exec(
    s.code.implementation.metadataTail,
  )?.[1];
  let cid = "";
  if (digest) {
    let n = BigInt(`0x${digest}`);
    while (n) {
      cid = alphabet[Number(n % 58n)] + cid;
      n /= 58n;
    }
  }
  if (cid)
    await get(`https://dweb.link/ipfs/${cid}`, `${chain}-ipfs-metadata.json`);
  await get(
    `https://repo.sourcify.dev/contracts/full_match/${s.chainId}/${s.implementation}/metadata.json`,
    `${chain}-sourcify-full.json`,
  );
  await get(
    `https://repo.sourcify.dev/contracts/partial_match/${s.chainId}/${s.implementation}/metadata.json`,
    `${chain}-sourcify-partial.json`,
  );
  const url =
    chain === "one"
      ? `https://explorer.onechain.nexus/612055/api/v2/smart-contracts/${s.implementation}`
      : `https://bscscan.com/address/${s.implementation}#code`;
  await get(url, `${chain}-explorer-source.txt`);
}
console.log(
  JSON.stringify({
    base,
    ref: ref?.sha,
    requests: requests.map((x) => ({
      file: x.file,
      status: x.status,
      error: x.error,
    })),
  }),
);
