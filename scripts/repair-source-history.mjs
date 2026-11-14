import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const base = "evidence/otherbridge-v1/repair-r1/sources";
await mkdir(base, { recursive: true });
const requests = [];
async function get(url, file) {
  const entry = { url, file, at: new Date().toISOString() };
  requests.push(entry);
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      redirect: "error",
    });
    entry.status = response.status;
    if (!response.ok) return;
    const text = await response.text();
    if (text.length > 4000000) throw Error("SIZE_LIMIT");
    entry.sha256 = createHash("sha256").update(text).digest("hex");
    await writeFile(`${base}/${file}`, text, { flag: "wx" });
  } catch (error) {
    entry.error = error.message;
  }
}
const commit = "3a8347cd005d00e50af9194204a55da69f96ddfc";
for (const path of [
  "src/interface/IBridgeRegistry.sol",
  "src/BridgeRegistry.sol",
  "src/BridgeToken.sol",
])
  await get(
    `https://raw.githubusercontent.com/to-nexus/bridge-contracts/${commit}/${path}`,
    `history-${path.replaceAll("/", "_")}`,
  );
await get(
  "https://api.github.com/repos/to-nexus/bridge-contracts/commits?path=src/CrossBridge.sol&per_page=20",
  "cross-commit-history.json",
);
await get(
  `https://api.github.com/repos/to-nexus/bridge-contracts/git/trees/${commit}?recursive=1`,
  "contracts-tree.json",
);
const snapshot = JSON.parse(
  await readFile(
    "evidence/otherbridge-v1/repair-r1/live/discovery.json",
    "utf8",
  ),
);
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(hex) {
  let n = BigInt(`0x${hex}`),
    out = "";
  while (n) {
    out = alphabet[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
}
for (const [chain, s] of Object.entries(snapshot.snapshots)) {
  const digest = /697066735822(1220[0-9a-f]{64})/.exec(
    s.code.implementation.metadataTail,
  )?.[1];
  if (digest)
    await get(
      `https://ipfs.io/ipfs/${base58(digest)}`,
      `${chain}-ipfs-metadata.json`,
    );
  await get(
    `https://repo.sourcify.dev/contracts/full_match/${s.chainId}/${s.implementation}/metadata.json`,
    `${chain}-sourcify-full-metadata.json`,
  );
  await get(
    `https://repo.sourcify.dev/contracts/partial_match/${s.chainId}/${s.implementation}/metadata.json`,
    `${chain}-sourcify-partial-metadata.json`,
  );
}
await writeFile(
  `${base}/history-requests.json`,
  JSON.stringify(requests, null, 2),
  { flag: "wx" },
);
console.log(
  JSON.stringify(
    requests.map(({ file, status, error }) => ({ file, status, error })),
  ),
);
