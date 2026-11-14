"""V1.7 G7-prep review bundle (OTHERBRIDGE_G7_PREP_REVIEW_BUNDLE.zip).
Writes only into a NEW uniquely named directory under ../otherbridge-review-bundles; never touches prior bundles.
Usage: python scripts/g7-bundle.py --reserve   (create the unique directory, record the path)
       python scripts/g7-bundle.py             (build, CRC-test, hash, write integrity files)"""
from pathlib import Path
import datetime, hashlib, json, re, sys, uuid, zipfile

workspace = Path(__file__).resolve().parent.parent
evidence_rel = (workspace / ".otherbridge/g7-evidence-path.txt").read_text(encoding="utf8").strip()
evidence = workspace / evidence_rel
bundles = workspace.parent / "otherbridge-review-bundles"
pointer = workspace / ".otherbridge/g7-review-zip-path.txt"
NAME = "OTHERBRIDGE_G7_PREP_REVIEW_BUNDLE.zip"
sha = lambda b: hashlib.sha256(b).hexdigest()

if "--reserve" in sys.argv:
    if pointer.exists():
        sys.exit(f"already reserved: {pointer.read_text().strip()}")
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    destination = bundles / f"{stamp}-g7prep-{uuid.uuid4().hex[:10]}"
    destination.mkdir(parents=True, exist_ok=False)
    pointer.write_text(str(destination / NAME), encoding="utf8")
    print(destination / NAME)
    sys.exit(0)

archive = Path(pointer.read_text(encoding="utf8").strip())
assert archive.parent.resolve().is_relative_to(bundles.resolve()), archive
assert not archive.exists(), "bundle already built; refusing to overwrite"

files = {}
def add(rel):
    p = workspace / rel
    if p.is_file():
        files[Path(rel).as_posix()] = p
    elif p.is_dir():
        for q in p.rglob("*"):
            if q.is_file():
                files[q.relative_to(workspace).as_posix()] = q

# Source changes, scripts, tests, configuration touched by V1.7
for rel in ["src/g7", "tests/unit/g7-prep.test.ts", "scripts/g7-prepare.ts", "scripts/g7-track.ts",
            "scripts/g7-docs.ts", "scripts/g7-safety-scan.ts", "scripts/g7-preserve.mjs", "scripts/g7-bundle.py",
            "scripts/ts-hooks.mjs", "package.json", ".prettierignore", "tsconfig.json", "vitest.config.ts"]:
    add(rel)
# Unchanged V1.6/V1.5 code the G7 tools rely on (context for review; byte-identical to the start of the run)
for rel in ["src/g5", "src/security/firewall.ts", "src/routing/model.ts", "src/routing/fee-policy.ts",
            "src/adapters/onebridge.ts", "src/adapters/native-abi.ts", "src/adapters/native-decoder.ts",
            "src/adapters/deployment.ts", "src/core/model.ts", "src/core/flow.ts", "scripts/verify-safety.mjs",
            "scripts/g5-v16-payout-proof.mjs", "scripts/g5-v16-proof-lib.mjs", "scripts/g5-v16-lib.mjs"]:
    add(rel)
# Docs, decision and package
for rel in ["docs/G7_OWNER_APPROVAL_CARD.md", "docs/G7_SIGNATURE_CHECKLIST.md", "docs/G7_PILOT_RECORD_TEMPLATE.md",
            "docs/G7_PREP_REPORT.md", "docs/G7_CONTROLLED_PILOT_PLAN.md", "docs/G5_FINAL_AUTONOMOUS_CLOSURE.md",
            "docs/G5_RESERVE_RECONCILIATION.md", "docs/G5_LEGACY_RUNTIME_SECURITY_REVIEW.md",
            "docs/TRANSACTION_FIREWALL_SPEC.md", "docs/SECURITY_RELEASE_GATE.md",
            "G7_PREP_DECISION.json", "G7_UNSIGNED_TRANSACTION.json", "G7_INTENT_DIGEST.json",
            "GOAL_OTHERBRIDGE_V1_7_G7_CONTROLLED_PILOT_PREP_ONLY.md", "OTHERBRIDGE_V1_HANDOFF.md",
            ".otherbridge/EXECUTION_STATE.md", ".otherbridge/g7-evidence-path.txt", "AGENTS.md", "CLAUDE.md"]:
    add(rel)
# The complete G7-prep evidence root
add(evidence_rel)

def excluded(name):
    parts = Path(name).parts
    base = Path(name).name
    return (any(p in [".git", "node_modules", ".next", "__pycache__", "secrets"] for p in parts)
            or name.lower().endswith((".zip", ".tsbuildinfo", ".pyc", ".pem", ".key"))
            or (base.startswith(".env") and base != ".env.example")
            or base == "g7-review-zip-path.txt"
            or re.search(r"(wallet[-_]?sessions?|credentials|private[-_]?keys?|seed[-_]?phrases?)(\.(json|txt|key|pem))?$", name, re.I))
excluded_names = sorted(n for n in files if excluded(n))
for n in excluded_names:
    del files[n]

# Secret scan: generic patterns + the literal local secret values (never printed).
local_secrets = []
for env_local in [workspace / ".env.data.local", workspace / ".env.staging.local"]:
    if env_local.exists():
        for line in env_local.read_text(encoding="utf8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                value = line.split("=", 1)[1].strip()
                if len(value) >= 16:
                    local_secrets.append(value.encode())
                for m in re.finditer(r"://[^:/@\s]+:([^@\s]+)@", value):
                    local_secrets.append(m.group(1).encode())
patterns = [
    re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(rb"(?i)[\"']?(?:private_key|privatekey|mnemonic|seed_phrase)[\"']?\s*[:=]\s*[\"'](?:0x[0-9a-f]{64}|(?:[a-z]+ ){11,23}[a-z]+)[\"']"),
    re.compile(rb"(?i)(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[\"']?\s*[:=]\s*[\"'](?!REDACTED|YOUR_|test|false|undefined|null)[A-Za-z0-9_-]{24,}[\"']"),
    re.compile(rb"ob_(?:live|test)_[a-z0-9]{12}_(?!A{43})[A-Za-z0-9_-]{43}"),
    re.compile(rb"postgres(?:ql)?://(?!u:p@h/db)[^:/@\s\"'`]+:(?!\$\{)[^@\s\"'`]+@"),
]
findings = []
for name, path in sorted(files.items()):
    b = path.read_bytes()
    if any(p.search(b) for p in patterns):
        findings.append({"path": name, "kind": "pattern"})
    if any(s in b for s in local_secrets):
        findings.append({"path": name, "kind": "local-secret-value"})
if findings:
    sys.exit(f"SECRET_SCAN_FINDINGS {json.dumps(findings)}")

manifest = {name: {"sha256": sha(path.read_bytes()), "bytes": path.stat().st_size} for name, path in sorted(files.items())}
meta = {
    "bundle": NAME,
    "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "evidenceRoot": evidence_rel,
    "decision": json.loads((workspace / "G7_PREP_DECISION.json").read_text(encoding="utf8"))["status"],
    "files": len(manifest),
    "excludedByPolicy": excluded_names,
    "excludes": [".git", "node_modules", ".next", "real env files", "wallet sessions", "API keys", "private keys",
                 "seed phrases", "prior ZIPs"],
    "secretScan": {"patterns": len(patterns), "localSecretValues": len(local_secrets), "findings": 0},
}
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for name, path in sorted(files.items()):
        z.write(path, name)
    z.writestr("BUNDLE_MANIFEST.json", json.dumps({"meta": meta, "files": manifest}, indent=1))
with zipfile.ZipFile(archive) as z:
    bad = z.testzip()
    assert bad is None, f"CRC failure: {bad}"
    infos = z.infolist()
    entry_check = all(sha(z.read(i.filename)) == manifest[i.filename]["sha256"] for i in infos if i.filename != "BUNDLE_MANIFEST.json")
    crc = {i.filename: f"{i.CRC:08x}" for i in infos}
archive_sha = sha(archive.read_bytes())
integrity = {
    "archive": str(archive),
    "archiveSha256": archive_sha,
    "archiveBytes": archive.stat().st_size,
    "entries": len(infos),
    "crcTest": "PASS (zipfile.testzip() returned None)",
    "perEntrySha256Verified": entry_check,
    "crc32": crc,
    "sha256": {k: v["sha256"] for k, v in manifest.items()},
    "meta": meta,
}
(archive.parent / "BUNDLE_INTEGRITY.json").write_text(json.dumps(integrity, indent=1), encoding="utf8")
(archive.parent / (NAME + ".sha256")).write_text(f"{archive_sha}  {NAME}\n", encoding="utf8")
(evidence / "review-bundle-integrity.json").write_text(json.dumps({k: integrity[k] for k in ["archive", "archiveSha256", "archiveBytes", "entries", "crcTest", "perEntrySha256Verified"]}, indent=1), encoding="utf8")
print(json.dumps({k: integrity[k] for k in ["archive", "archiveSha256", "archiveBytes", "entries", "crcTest", "perEntrySha256Verified"]}, indent=1))
