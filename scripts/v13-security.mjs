import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const base = process.env.OTHERBRIDGE_EVIDENCE_ROOT;
if (!base) throw Error("UNIQUE_EVIDENCE_ROOT_REQUIRED");
await mkdir(base, { recursive: true });
const packages = [];
for (const dir of await readdir("node_modules/.pnpm", {
  withFileTypes: true,
})) {
  if (!dir.isDirectory() || dir.name === "node_modules") continue;
  const root = `node_modules/.pnpm/${dir.name}/node_modules`;
  try {
    for (const item of await readdir(root)) {
      const names = item.startsWith("@")
        ? (await readdir(`${root}/${item}`)).map((n) => `${item}/${n}`)
        : [item];
      for (const name of names) {
        try {
          const p = JSON.parse(
            await readFile(`${root}/${name}/package.json`, "utf8"),
          );
          if (
            packages.some((v) => v.name === p.name && v.version === p.version)
          )
            continue;
          packages.push({
            name: p.name,
            version: p.version,
            license:
              typeof p.license === "string"
                ? p.license
                : (p.license?.type ?? p.licenses?.[0]?.type ?? "UNKNOWN"),
            lifecycle: Object.fromEntries(
              Object.entries(p.scripts ?? {}).filter(([k]) =>
                /^(preinstall|install|postinstall|prepare)$/.test(k),
              ),
            ),
          });
        } catch {}
      }
    }
  } catch {}
}
packages.sort(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);
const files = [];
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const file = `${dir}/${e.name}`;
    if (e.isDirectory()) await walk(file);
    else files.push(file);
  }
}
await walk("src");
await walk("scripts");
await walk(".github");
const findings = [];
const hashes = {};
for (const file of files) {
  const text = await readFile(file, "utf8");
  hashes[file] = createHash("sha256").update(text).digest("hex");
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{30,}/.test(
      text,
    )
  )
    findings.push({ file, kind: "secret-pattern", value: "REDACTED" });
  if (
    file.startsWith("src/") &&
    /dangerouslySetInnerHTML|eval\s*\(|new Function\s*\(/.test(text)
  )
    findings.push({ file, kind: "unsafe-evaluation" });
}
assert.equal(findings.length, 0, "Secret/static findings require review");
const lock = await readFile("pnpm-lock.yaml"),
  sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: {
        type: "application",
        name: "otherbridge",
        version: "V1.3-readonly",
      },
    },
    components: packages.map((p) => ({
      type: "library",
      name: p.name,
      version: p.version,
      purl: `pkg:npm/${p.name.replace("@", "%40")}@${p.version}`,
      licenses: [{ license: { name: p.license } }],
    })),
  };
await writeFile(`${base}/sbom.cdx.json`, JSON.stringify(sbom, null, 2), {
  flag: "wx",
});
await writeFile(
  `${base}/licenses-lifecycle.json`,
  JSON.stringify(
    {
      packages,
      unknown: packages.filter((p) => p.license === "UNKNOWN"),
      lifecycle: packages.filter((p) => Object.keys(p.lifecycle).length),
      policy:
        "frozen install; lifecycle scripts denied; optional prebuilt binaries; no dependency upgrade",
      review:
        "Lifecycle code and installed scripts are inventoried for review; presence is not approval to execute.",
    },
    null,
    2,
  ),
  { flag: "wx" },
);
await writeFile(
  `${base}/static-secrets-check.json`,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      findings,
      scanned: files.length,
      lockSha256: createHash("sha256").update(lock).digest("hex"),
      hashes,
      scope:
        "Pattern/static checks; not a penetration test or independent audit",
    },
    null,
    2,
  ),
  { flag: "wx" },
);
console.log({
  packages: packages.length,
  unknownLicenses: packages.filter((p) => p.license === "UNKNOWN").length,
  lifecycle: packages.filter((p) => Object.keys(p.lifecycle).length).length,
  findings: findings.length,
});
