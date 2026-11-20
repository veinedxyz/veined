import assert from "node:assert/strict";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
const read = (p) => readFileSync(p, "utf8");
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const baseline = JSON.parse(
  read("release/manual-wallet-protected-baseline.json"),
);
const proposal = JSON.parse(
  read("release/manual-wallet-allowance-proposal.json"),
);
assert.deepEqual(Object.keys(proposal).sort(), [
  "src/swap/lane/bridge-engine.ts",
  "src/swap/lane/engine.ts",
  "src/swap/lane/existing-allowance.ts",
]);
for (const [path, expected] of Object.entries(proposal))
  assert.equal(
    hash(path),
    expected,
    `Unreviewed allowance proposal change: ${path}`,
  );
// Only these exact proposal hashes may differ; pins, transport, safety gates and G7 stay byte-identical.
for (const p of Object.keys(baseline))
  if (
    p.startsWith("src/swap/lane/") ||
    p.startsWith("src/execution/") ||
    /g7/i.test(p)
  )
    assert.equal(
      hash(p),
      proposal[p] ?? baseline[p],
      `Accepted security dependency changed: ${p}`,
    );
assert.match(
  read("src/manual-wallet/release.ts"),
  /export const MANUAL_WALLET_RELEASED = false as boolean;/,
);
const runtime = read("src/manual-wallet/server/runtime.ts");
assert.match(runtime, /D:\/vnd\/post-hackathon-20261117-01\/candidate/);
assert.match(runtime, /exactAmount: "?1000000"?|exactAmount:\s*"1000000"/);
assert.match(runtime, /exactAmount: "?5000000"?|exactAmount:\s*"5000000"/);
assert.match(runtime, /maxSlippageBps:\s*50/);
assert.match(runtime, /sourceChainId:\s*"8453"/);
assert.match(runtime, /destinationChainId:\s*"42161"/);
assert.match(
  read("src/app/api/manual-wallet/route.ts"),
  /http:\/\/127\.0\.0\.1:3470/,
);
assert.match(read("src/app/api/manual-wallet/route.ts"), /httpOnly:\s*true/);
assert.match(
  read("src/app/api/manual-wallet/route.ts"),
  /sameSite:\s*"strict"/,
);
assert.match(read("src/app/api/manual-wallet/route.ts"), /x-manual-csrf/);
const paths = [];
function walk(p) {
  for (const name of readdirSync(p)) {
    const f = p + "/" + name;
    if (lstatSync(f).isDirectory()) walk(f);
    else paths.push(f);
  }
}
walk("src/manual-wallet");
for (const p of paths)
  assert(
    !/createWalletClient|privateKeyToAccount|mnemonicToAccount|sendRawTransaction|eth_sendTransaction|personal_sign|eth_signTypedData|fetch\s*\(/.test(
      read(p),
    ),
    `Unapproved manual egress: ${p}`,
  );
const adapter = read("src/features/wallet/adapter.ts");
const method = adapter.slice(
  adapter.indexOf("  async sendManualTransaction("),
  adapter.indexOf("  async sendCanonicalTransaction("),
);
assert.match(method, /takeManualAuthority\(authority, this\)/);
assert.match(method, /await this\.identity\(\)/);
assert.match(method, /grant\.check\(\)/);
assert.equal((method.match(/method: "eth_sendTransaction"/g) ?? []).length, 1);
assert(
  !/await/.test(
    method
      .slice(
        method.indexOf("grant.check();") + 14,
        method.indexOf("const answer"),
      )
      .replace(/\/\/[^\n]*/g, ""),
  ),
  "No await after last identity/time veto",
);
console.log(
  "MANUAL_WALLET_SAFETY_PASS: exact allowance proposal pinned; G7/pins/firewall unchanged; activation closed; wallet boundary checked",
);
