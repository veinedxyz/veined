import { createHash, randomUUID } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { createRequire } from "node:module";
const out = process.argv[2];
if (!out) throw Error("OUTPUT_REQUIRED");
mkdirSync(out, { recursive: true });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const cli = join(
  dirname(process.execPath),
  "node_modules/corepack/dist/pnpm.js",
);
const require = createRequire(import.meta.url),
  yamlDir = readdirSync("node_modules/.pnpm").find((n) => /^js-yaml@/.test(n));
const yaml = require(
  resolve("node_modules/.pnpm", yamlDir, "node_modules/js-yaml"),
);
const jobs = [];
for (const [scope, cwd] of [
  ["root", process.cwd()],
  ["provider", resolve("swap-providers")],
])
  for (const [kind, args] of [
    ["prod", ["list", "--prod", "--depth", "Infinity", "--json"]],
    ["all", ["list", "--depth", "Infinity", "--json"]],
    ["licenses", ["licenses", "list", "--json"]],
  ])
    jobs.push({ scope, cwd, kind, args });
const commands = await Promise.all(
  jobs.map(async (job) => {
    let stdout = "",
      stderr = "";
    const startedAt = new Date().toISOString(),
      child = spawn(process.execPath, [cli, ...job.args], { cwd: job.cwd });
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    const exitCode = await new Promise((r) => child.on("close", r));
    if (exitCode !== 0) throw Error("INVENTORY_FAILED:" + job.scope + job.kind);
    const path = join(out, job.scope + "-" + job.kind + ".json");
    writeFileSync(path, stdout);
    writeFileSync(path + ".stderr.log", stderr);
    return {
      ...job,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode,
      path,
      sha256: sha(Buffer.from(stdout)),
    };
  }),
);
const read = (scope, kind) =>
  JSON.parse(readFileSync(join(out, scope + "-" + kind + ".json"), "utf8"));
function flatten(node, map = new Map()) {
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
  ])
    for (const [name, item] of Object.entries(node?.[field] ?? {})) {
      const id = name + "@" + item.version;
      if (map.has(id)) continue;
      map.set(id, {
        name,
        version: item.version,
        path: item.path,
        resolved: item.resolved,
      });
      flatten(item, map);
    }
  return map;
}
const reports = [];
const registryMetadata = existsSync("release/npm-license-metadata.json")
  ? JSON.parse(readFileSync("release/npm-license-metadata.json"))
  : {};
for (const scope of ["root", "provider"]) {
  const prod = flatten(read(scope, "prod")[0]),
    all = flatten(read(scope, "all")[0]);
  const lockFile =
      scope === "root" ? "pnpm-lock.yaml" : "swap-providers/pnpm-lock.yaml",
    lockBytes = readFileSync(lockFile),
    lock = yaml.load(lockBytes.toString());
  const licenses = new Map();
  for (const [group, items] of Object.entries(read(scope, "licenses")))
    for (const item of items)
      for (const v of item.versions ?? [])
        licenses.set(item.name + "@" + v, item.license ?? group);
  for (const [classification, graph] of [
    ["production", prod],
    ["dev-test", new Map([...all].filter(([id]) => !prod.has(id)))],
  ]) {
    const components = [],
      unknown = [];
    for (const [id, p] of [...graph].sort(([a], [b]) => (a < b ? -1 : 1))) {
      let installed;
      try {
        installed = JSON.parse(
          readFileSync(join(p.path, "package.json"), "utf8"),
        );
      } catch {}
      const name = installed?.name ?? p.name,
        version = installed?.version ?? p.version;
      const entry =
        lock.packages?.[name + "@" + version] ?? lock.packages?.[id];
      const integrity = entry?.resolution?.integrity ?? null;
      const registryEntry = registryMetadata[id];
      const registryLicense =
        registryEntry?.integrity === integrity
          ? registryEntry.license
          : undefined;
      const license =
        installed?.license ??
        licenses.get(id) ??
        registryLicense ??
        "NOASSERTION";
      if (!integrity || license === "NOASSERTION")
        unknown.push({
          id,
          integrityKnown: !!integrity,
          licenseKnown: license !== "NOASSERTION",
        });
      components.push({
        type: "library",
        "bom-ref": scope + ":" + id,
        name,
        version,
        purl: `pkg:npm/${name.replace("@", "%40")}@${version}`,
        scope: "required",
        licenses: [
          {
            license: {
              name:
                typeof license === "string"
                  ? license
                  : (license.type ?? "NOASSERTION"),
            },
          },
        ],
        ...(integrity
          ? {
              hashes: integrity.split(" ").map((s) => {
                const i = s.indexOf("-");
                return {
                  alg: s.slice(0, i).replace(/^sha/, "SHA-"),
                  content: Buffer.from(s.slice(i + 1), "base64").toString(
                    "hex",
                  ),
                };
              }),
            }
          : {}),
        properties: [
          { name: "otherbridge:classification", value: classification },
          { name: "otherbridge:graph", value: scope },
          { name: "otherbridge:lock-sha256", value: sha(lockBytes) },
          { name: "otherbridge:integrity", value: integrity ?? "NOASSERTION" },
          {
            name: "otherbridge:license-review",
            value:
              license === "NOASSERTION"
                ? "LEGAL_REVIEW_REQUIRED"
                : "DECLARED_METADATA_NOT_LEGAL_APPROVAL",
          },
        ],
      });
    }
    const file = scope + "-" + classification + ".cdx.json";
    writeFileSync(
      join(out, file),
      JSON.stringify(
        {
          bomFormat: "CycloneDX",
          specVersion: "1.6",
          serialNumber: "urn:uuid:" + randomUUID(),
          version: 1,
          metadata: {
            timestamp: new Date().toISOString(),
            component: {
              type: "application",
              name: "Otherbridge " + scope + " " + classification,
              version: "1.16",
            },
          },
          components,
        },
        null,
        2,
      ) + "\n",
    );
    reports.push({
      scope,
      classification,
      file,
      count: components.length,
      unknown,
      lockFile,
      lockSha256: sha(lockBytes),
    });
  }
}
writeFileSync(
  join(out, "sbom-receipt.json"),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      commands,
      reports,
      method:
        "Actual pnpm dependency graph; shared dev/runtime members remain production; lock SRI bytes and installed license declarations; missing metadata explicitly NOASSERTION.",
      pass: reports.every(
        (r) => r.count > 0 && r.unknown.every((x) => x.integrityKnown),
      ),
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify(
    reports.map((r) => ({
      scope: r.scope,
      classification: r.classification,
      count: r.count,
      unknown: r.unknown,
    })),
    null,
    2,
  ),
);
