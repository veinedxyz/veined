import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const base = process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "evidence/otherbridge-v1";
const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await walk(p);
    else files.push(p);
  }
}
await walk("src");
const findings = [];
for (const file of files) {
  const text = await readFile(file, "utf8");
  assert(
    !/privateKeyToAccount|mnemonicToAccount|eth_sendRawTransaction|personal_sign|eth_signTypedData/.test(
      text,
    ),
    `Forbidden signer surface: ${file}`,
  );
  if (text.includes("eth_sendTransaction"))
    assert(
      file === "src/features/bridge/submission.ts",
      "Wallet writes must be centralized",
    );
  assert(
    !/dangerouslySetInnerHTML/.test(text),
    "Raw external HTML is prohibited",
  );
  findings.push({ file, checked: true });
}
assert(
  (await readFile(".env.example", "utf8")).includes(
    "OTHERBRIDGE_ENABLE_MAINNET_SUBMISSION=false",
  ),
);
assert(
  /process\.env\.NODE_ENV\s*===\s*["']production["']/.test(
    await readFile("src/server/config.ts", "utf8"),
  ),
);
const result = {
  at: new Date().toISOString(),
  result: "PASS",
  sourceFiles: findings.length,
  mainnetSubmission: false,
  privateKeys: false,
  productionDeploy: false,
  scope: "Static application boundary checks, not independent security audit",
};
await mkdir(base, { recursive: true });
await writeFile(`${base}/safety.json`, JSON.stringify(result, null, 2));
console.log(result);
