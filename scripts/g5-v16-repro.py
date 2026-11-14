"""V1.6 G5 exact-build reproduction (independent of forge).

1. Read the forge artifact's raw metadata for the target contract.
2. Recompute the IPFS CIDv0 of that metadata and require it to equal the live CBOR IPFS hash.
3. Rebuild a MINIMAL Standard JSON input from the metadata only (sources listed in metadata, content
   read from the Git checkout and required to match the metadata keccak256 per file, settings copied).
4. Compile with the official native solc binary and the official soljson (wasm) build (both SHA-256-checked).
5. Compare full deployed runtime (after immutable substitution only) and the creation code against the
   on-chain creation input.

Usage: python scripts/g5-v16-repro.py <chain> <checkout> <sourcePath> <contractName> <liveRuntimeHex> <creationInputHex> <outRel>
"""
import hashlib, json, os, subprocess, sys, datetime

sys.path.insert(0, os.path.dirname(__file__))
_cmp = {}
exec(open(os.path.join(os.path.dirname(__file__), "g5-v16-compare.py"), encoding="utf-8").read().split("if __name__")[0], _cmp)
keccak, compare_objects = _cmp["keccak"], _cmp["compare_objects"]

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
EVID = os.path.join(REPO, open(os.path.join(REPO, ".otherbridge", "v16-evidence-path.txt")).read().strip())
FORENSICS = os.path.abspath(os.path.join(REPO, "..", "otherbridge-forensics", "v16"))
SOLC = os.path.join(FORENSICS, "solc", "solc-0.8.28.exe")
SOLJSON = os.path.join(FORENSICS, "solc", "soljson-0.8.28.js")
EXPECTED = {SOLC: "76a71001309810aafd0462d9b2f2612bf19b89550c866140edca26e533de06bc",
            SOLJSON: "72ef580a6ec5943130028e5294313f24e9435520acc89f8c9dbfd0139d9ae146"}

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58(b: bytes) -> str:
    n = int.from_bytes(b, "big"); s = ""
    while n: n, r = divmod(n, 58); s = B58[r] + s
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + s

def varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F; n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n: return bytes(out)

def ipfs_cidv0(content: bytes) -> str:
    """CIDv0 of a single-chunk UnixFS file (go-ipfs default, < 256 KiB) — what solc embeds."""
    if len(content) > 262144: raise ValueError("MULTI_CHUNK_NOT_SUPPORTED")
    unixfs = b"\x08\x02" + b"\x12" + varint(len(content)) + content + b"\x18" + varint(len(content))
    pbnode = b"\x0a" + varint(len(unixfs)) + unixfs
    return b58(b"\x12\x20" + hashlib.sha256(pbnode).digest())

def file_sha(p): return hashlib.sha256(open(p, "rb").read()).hexdigest()

def git_blob(checkout: str, path: str):
    """Exact committed bytes (no CRLF conversion) from the innermost Git repo containing `path`."""
    parts = path.split("/")
    repo, rel = checkout, path
    for i in range(len(parts) - 1, 0, -1):
        cand = os.path.join(checkout, *parts[:i])
        if os.path.exists(os.path.join(cand, ".git")):
            repo, rel = cand, "/".join(parts[i:]); break
    head = subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    oid = subprocess.run(["git", "-C", repo, "rev-parse", f"HEAD:{rel}"], capture_output=True, text=True, check=True).stdout.strip()
    data = subprocess.run(["git", "-C", repo, "cat-file", "blob", oid], capture_output=True, check=True).stdout
    return data, {"repo": os.path.relpath(repo, checkout).replace("\\", "/"), "repoCommit": head, "gitBlob": oid}

def run_native(std_json: str):
    r = subprocess.run([SOLC, "--standard-json"], input=std_json.encode(), capture_output=True, timeout=1800)
    return json.loads(r.stdout.decode())

def run_soljson(std_json: str):
    r = subprocess.run(["node", os.path.join(REPO, "scripts", "g5-v16-soljson.mjs"), SOLJSON], input=std_json.encode(), capture_output=True, timeout=3600, cwd=REPO)
    text = r.stdout.decode()
    version, _, body = text.partition("\n")
    return version, json.loads(body)

def main():
    chain, checkout, src, name, live_hex, creation_hex, out_rel = sys.argv[1:8]
    out_dir = os.path.join(EVID, out_rel); os.makedirs(out_dir, exist_ok=True)
    for p, h in EXPECTED.items():
        if file_sha(p) != h: raise SystemExit(f"COMPILER_CHECKSUM_MISMATCH {p}")
    live = bytes.fromhex(open(live_hex).read().strip().removeprefix("0x"))
    creation_input = bytes.fromhex(open(creation_hex).read().strip().removeprefix("0x"))
    art = json.load(open(os.path.join(checkout, "out", os.path.basename(src), f"{name}.json"), encoding="utf-8"))
    raw_meta = art["rawMetadata"]
    raw_bytes = raw_meta.encode("utf-8")
    meta = json.loads(raw_meta)
    cid = ipfs_cidv0(raw_bytes)
    # Live CBOR IPFS hash
    n = int.from_bytes(live[-2:], "big"); cbor = live[-2 - n:-2]
    live_mh = cbor[cbor.index(b"\x58\x22") + 2: cbor.index(b"\x58\x22") + 2 + 34]
    live_cid = b58(live_mh)
    open(os.path.join(out_dir, "metadata.json"), "wb").write(raw_bytes)
    # Minimal Standard JSON from metadata
    sources, src_report = {}, []
    for path, info in meta["sources"].items():
        content, gitinfo = git_blob(checkout, path)
        k = keccak(content)
        ok = k == info["keccak256"]
        src_report.append({"path": path, **gitinfo, "keccak256": k, "metadataKeccak256": info["keccak256"], "match": ok, "sha256": hashlib.sha256(content).hexdigest(), "license": info.get("license"), "bytes": len(content)})
        sources[path] = {"content": content.decode("utf-8")}
    settings = dict(meta["settings"])
    target = settings.pop("compilationTarget")
    settings["outputSelection"] = {"*": {"*": ["abi", "metadata", "evm.bytecode.object", "evm.bytecode.linkReferences", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences", "evm.deployedBytecode.linkReferences", "storageLayout"]}}
    std = {"language": meta["language"], "sources": sources, "settings": settings}
    std_text = json.dumps(std, sort_keys=True, separators=(",", ":"))
    open(os.path.join(out_dir, "standard-json-input.json"), "w", encoding="utf-8", newline="\n").write(std_text)
    results = {}
    for label, runner in (("native", run_native), ("soljson", run_soljson)):
        started = datetime.datetime.now(datetime.timezone.utc).isoformat()
        if label == "native":
            outj = runner(std_text); version = subprocess.run([SOLC, "--version"], capture_output=True, text=True).stdout.strip().splitlines()[-1]
        else:
            version, outj = runner(std_text)
        errs = [e for e in outj.get("errors", []) if e.get("severity") == "error"]
        out_text = json.dumps(outj, sort_keys=True)
        open(os.path.join(out_dir, f"standard-json-output-{label}.json"), "w", encoding="utf-8").write(out_text)
        if errs:
            results[label] = {"version": version, "errors": errs[:5]}; continue
        (tpath, tname), = target.items()
        c = outj["contracts"][tpath][tname]
        cmpres = compare_objects(c["evm"]["deployedBytecode"], live, f"{chain}-{label}")
        creation = bytes.fromhex(c["evm"]["bytecode"]["object"])
        args = creation_input[len(creation):] if creation_input.startswith(creation) else None
        results[label] = {
            "compilerVersion": version, "startedAt": started,
            "outputSha256": hashlib.sha256(out_text.encode()).hexdigest(),
            "metadataEqualsForgeRawMetadata": c["metadata"] == raw_meta,
            "runtime": cmpres,
            "creationCode": {"compiledBytes": len(creation), "onchainInputBytes": len(creation_input),
                              "compiledKeccak256": keccak(creation), "onchainInputKeccak256": keccak(creation_input),
                              "INITCODE_PREFIX_EQUAL": creation_input.startswith(creation),
                              "INITCODE_EXACT_EQUAL": creation == creation_input,
                              "constructorArgsHex": args.hex() if args is not None else None},
            "storageLayout": c.get("storageLayout"),
        }
        open(os.path.join(out_dir, f"compiled-runtime-{label}.hex"), "w").write("0x" + c["evm"]["deployedBytecode"]["object"])
    summary = {
        "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "chain": chain, "checkout": checkout, "compilationTarget": target,
        "compilers": {"native": {"path": "solc-windows-amd64-v0.8.28+commit.7893614a.exe", "sha256": EXPECTED[SOLC]},
                       "soljson": {"path": "soljson-v0.8.28+commit.7893614a.js", "sha256": EXPECTED[SOLJSON]}},
        "metadata": {"bytes": len(raw_bytes), "sha256": hashlib.sha256(raw_bytes).hexdigest(), "computedIpfsCidV0": cid, "liveCborIpfsCidV0": live_cid, "CID_EQUAL": cid == live_cid,
                      "compiler": meta["compiler"], "settings": meta["settings"]},
        "sources": src_report, "allSourceHashesMatchMetadata": all(s["match"] for s in src_report),
        "standardJsonInputSha256": hashlib.sha256(std_text.encode()).hexdigest(),
        "results": results,
        "EXACT_BUILD_EQUIVALENCE": all(r.get("runtime", {}).get("FULL_RUNTIME_EQUAL") for r in results.values()) and cid == live_cid and all(s["match"] for s in src_report),
    }
    for r in results.values():
        if "storageLayout" in r: r["storageLayout"] = {"storage": [{k: e[k] for k in ("label", "slot", "offset", "type")} for e in r["storageLayout"]["storage"]]}
    text = json.dumps(summary, indent=1)
    open(os.path.join(out_dir, "reproduction.json"), "w", encoding="utf-8").write(text + "\n")
    brief = {k: summary[k] for k in ("chain", "compilationTarget", "allSourceHashesMatchMetadata", "standardJsonInputSha256", "EXACT_BUILD_EQUIVALENCE")}
    brief["cid"] = summary["metadata"]["CID_EQUAL"]
    for l, r in results.items():
        brief[l] = {"version": r.get("compilerVersion"), "FULL_RUNTIME_EQUAL": r.get("runtime", {}).get("FULL_RUNTIME_EQUAL"), "initcode": r.get("creationCode"), "errors": r.get("errors")}
    print(json.dumps(brief, indent=1))

if __name__ == "__main__":
    main()
