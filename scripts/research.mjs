import { readFile, mkdir, writeFile } from "node:fs/promises";
const goal = await readFile("GOAL_OTHERBRIDGE_V1_MASTER.md", "utf8");
const sources = [
  ...goal.matchAll(/\| (A\d\d|B\d\d[a-z]?) \| (https:\/\/[^ |]+)/g),
].map((m) => ({ id: m[1], url: m[2] }));
await mkdir("evidence/otherbridge-v1", { recursive: true });
const results = [];
for (const source of sources) {
  try {
    const res = await fetch(source.url, {
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    const content = await res.text();
    results.push({
      ...source,
      status: res.status,
      observedAt: new Date().toISOString(),
      bytes: content.length,
      review: "inventory only; not full content review",
    });
  } catch {
    results.push({
      ...source,
      status: "unreachable",
      observedAt: new Date().toISOString(),
      review: "not read; bounded access failed",
    });
  }
}
await writeFile(
  "evidence/otherbridge-v1/source-inventory.json",
  JSON.stringify(results, null, 2),
);
const critical = [
  [
    "cross-token",
    "https://raw.githubusercontent.com/to-nexus/cross-token/main/README.md",
  ],
  [
    "bridge-contracts",
    "https://raw.githubusercontent.com/to-nexus/bridge-contracts/dev/README.md",
  ],
  [
    "bridge-skill",
    "https://raw.githubusercontent.com/to-nexus/skill-cross-crossd/main/skills/cross-crossd/scripts/_api.mjs",
  ],
  ["chain", "https://docs.onechain.nexus/docs/dev_chain"],
  ["sdk", "https://docs.onechain.nexus/docs/app-launcher-getting-started"],
  ["features", "https://docs.onechain.nexus/docs/app-launcher-features"],
];
for (const [id, url] of critical) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      redirect: "error",
    });
    if (res.ok)
      await writeFile(
        `evidence/otherbridge-v1/source-${id}.txt`,
        await res.text(),
      );
    console.log(id, res.status);
  } catch {
    console.log(id, "unreachable");
  }
}
console.log("Source inventory recorded", results.length);
