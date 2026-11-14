import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const base = "evidence/otherbridge-v1/repair-r1/sources";
await mkdir(base, { recursive: true });
const requests = [];
async function get(url, file, json = false) {
  const result = { url, file, at: new Date().toISOString() };
  requests.push(result);
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      redirect: "error",
      headers: { Accept: "application/json" },
    });
    result.status = response.status;
    if (!response.ok) return;
    const body = await response.text();
    if (body.length > 4000000) throw Error("SOURCE_SIZE_LIMIT");
    result.sha256 = createHash("sha256").update(body).digest("hex");
    result.gitBlobSha1 = createHash("sha1")
      .update(`blob ${Buffer.byteLength(body)}\0`)
      .update(body)
      .digest("hex");
    await writeFile(`${base}/${file}`, body, { flag: "wx" });
    return json ? JSON.parse(body) : body;
  } catch (error) {
    result.error = error.message;
  }
}
const contracts = await get(
  "https://api.github.com/repos/to-nexus/bridge-contracts/commits/dev",
  "contracts-ref.json",
  true,
);
const skill = await get(
  "https://api.github.com/repos/to-nexus/skill-cross-crossd/commits/main",
  "skill-ref.json",
  true,
);
for (const [commit, repository, paths] of [
  [
    contracts?.sha,
    "bridge-contracts",
    [
      "test/legacy/CrossBridgeLegacy.sol",
      "src/CrossBridge.sol",
      "src/BaseBridge.sol",
      "src/BridgeVerifier.sol",
      "src/interface/IBaseBridge.sol",
      "src/interface/IBridgeVerifier.sol",
      "src/lib/Const.sol",
      "foundry.toml",
      ".gitmodules",
      "foundry.lock",
      "README.md",
    ],
  ],
  [
    skill?.sha,
    "skill-cross-crossd",
    [
      "skills/cross-crossd/scripts/_abi.mjs",
      "skills/cross-crossd/scripts/_bridge-router-abi.json",
    ],
  ],
]) {
  if (!commit) continue;
  for (const path of paths)
    await get(
      `https://raw.githubusercontent.com/to-nexus/${repository}/${commit}/${path}`,
      `${repository}-${path.replaceAll("/", "_")}`,
    );
}
await writeFile(
  `${base}/requests.json`,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      contractsCommit: contracts?.sha,
      skillCommit: skill?.sha,
      requests,
    },
    null,
    2,
  ),
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    contractsCommit: contracts?.sha,
    skillCommit: skill?.sha,
    results: requests.map(({ file, status, error }) => ({
      file,
      status,
      error,
    })),
  }),
);
