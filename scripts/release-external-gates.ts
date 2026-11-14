import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parseEnv } from "node:util";
import { checkCredentials } from "../src/release/credentials";
import {
  evaluateExternalGates,
  V116_TECHNICAL_BASE,
} from "../src/release/external-gates";
const arg = (name: string) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
// All paths are explicit local operator files; no remote input or credential files are emitted.
function read(path: string | undefined, required = false): unknown {
  if (!path || !existsSync(path)) {
    if (required) throw Error("INPUT_MISSING");
    return undefined;
  }
  if (readFileSync(path).byteLength > 2_000_000) throw Error("INPUT_TOO_LARGE");
  return JSON.parse(readFileSync(path, "utf8"));
}
try {
  const env = {
    ...(existsSync(".env.local")
      ? parseEnv(readFileSync(".env.local", "utf8"))
      : {}),
    ...process.env,
  };
  const credentials = arg("credentials")
    ? read(arg("credentials"), true)
    : await checkCredentials(env);
  const candidate = read("release/candidate.json", true) as Record<
    string,
    unknown
  >;
  const result = evaluateExternalGates({
    manifest: read("release/EXTERNAL_GATES.json", true),
    credentials,
    canonicalBase: Object.fromEntries(
      Object.keys(V116_TECHNICAL_BASE).map((key) => [key, candidate[key]]),
    ),
    externalStatus: read("release/EXTERNAL_STATUS.json", true),
    ownerEvidence: read(arg("owner-evidence") ?? "release/owner-evidence.json"),
    audit: read(arg("audit") ?? "release/audit-result.json"),
    pentest: read(arg("pentest") ?? "release/pentest-result.json"),
    legal: read(arg("legal") ?? "release/legal-approval.json"),
    ownerRelease: read(arg("owner-release") ?? "release/owner-release.json"),
  });
  const out = arg("out");
  if (out) {
    const path = resolve(out);
    if (
      !path.startsWith(process.cwd() + "/") &&
      !path.startsWith(process.cwd() + "\\")
    )
      throw Error("OUTPUT_REFUSED");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  }
  console.log(JSON.stringify(result, null, 2));
  // Exit 2 means expected external incompleteness; exit 1 means invalid engineering/configuration input.
  process.exitCode = result.errors.length ? 1 : 2;
} catch {
  console.error("EXTERNAL_GATE_CHECK_FAILED_REDACTED");
  process.exitCode = 1;
}
