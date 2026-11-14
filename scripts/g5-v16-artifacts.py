"""V1.6 G5: build the machine-readable decision artifacts from evidence (deterministic, no network).

Writes into <evidence>/manifests/:
  deployment-build-equivalence-one.json, deployment-build-equivalence-bsc.json,
  payout-proof-1.json, payout-proof-2.json (summaries pointing at the full proofs),
  git-archaeology.json (copy), source-inventory.json
"""
import json, os, hashlib, glob

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
REL = open(os.path.join(REPO, ".otherbridge", "v16-evidence-path.txt")).read().strip()
EV = os.path.join(REPO, REL)
M = os.path.join(EV, "manifests")
os.makedirs(M, exist_ok=True)
J = lambda p: json.load(open(os.path.join(EV, p), encoding="utf-8"))
sha = lambda p: hashlib.sha256(open(os.path.join(EV, p), "rb").read()).hexdigest()

def write(name, obj):
    text = json.dumps(obj, indent=1) + "\n"
    open(os.path.join(M, name), "w", encoding="utf-8", newline="\n").write(text)
    return hashlib.sha256(text.encode()).hexdigest()

pins = J("chain-pins/deployment-identity-initial.json")
creation = {
    "one": {"tx": "0xc16d6ab26b52d946010003f1fa9747745626e501b115b45659de6c8bf661de7d", "block": 22464737, "time": "2026-01-09T06:02:30Z",
            "creator": "0xc360f136d479b1a479e91e2f00b163911b7a4a41", "sources": ["ONE RPC eth_getBlockByNumber(22464737,true) input (ONCHAIN_RPC)", "CrossScan creation_bytecode/raw_input (OFFICIAL_EXPLORER_INDEX) - byte-identical"],
            "installedBy": {"event": "Upgraded(0x2827865a…)", "block": 22473937, "tx": "0xbc3d0b0f6c75574391295a16f569e09e974f962f0494fa823ffe1a0604f7d85c", "source": "ONE eth_getLogs + CrossScan logs"}},
    "bsc": {"tx": "0x2e4b8cfec53d1fa182c8e33a6d8222985585aee834a6f89fd5bf3e79f36b450c", "block": 92497755, "time": "2026-04-14T13:52:50Z",
            "creator": "0x22c1522276855b028c31a731ba10d125811af37c", "sources": ["BSC archive eth_getCode bisection (BlastAPI)", "eth_getTransactionByHash/Receipt from BNB Chain official + BlastAPI (identical input)"],
            "installedBy": {"event": "Upgraded(0xac7b8ffe…)", "block": 92498159, "tx": "0x48d20ea112446578cfc1c8db459e6e2b25aff02c2cc1a5c1f7e2b279372a78ea", "source": "BSC eth_getBlockReceipts (BNB Chain official)"}},
}
arch = J("git/git-archaeology.json")
hashes = {}
for chain in ("one", "bsc"):
    rep = J(f"build/{chain}/reproduction.json")
    pin = pins["chains"][chain]
    nat = rep["results"]["native"]; wasm = rep["results"]["soljson"]
    obj = {
        "chain": chain, "chainId": pin["chainId"],
        "liveImplementation": pin["sources"][0]["implementation"]["address"],
        "pinnedBlock": pin["pinnedBlock"], "pinnedBlockHash": pin["pinnedBlockHash"],
        "liveRuntime": {"bytes": pin["sources"][0]["implementation"]["bytes"], "keccak256": pin["sources"][0]["implementation"]["keccak256"], "sha256": pin["sources"][0]["implementation"]["sha256"],
                         "rpcAgreement": pin["consensus"], "cbor": pin["implementationCbor"]},
        "creation": creation[chain],
        "source": {"repository": "https://github.com/to-nexus/bridge-contracts", "buildCommit": next(s["repoCommit"] for s in rep["sources"] if s["repo"] == "."),
                    "compilationTarget": rep["compilationTarget"], "equivalentCommits": [c["commit"] for c in arch[chain]["equivalentCommits"]],
                    "dependencyPins": sorted({(s["repo"], s["repoCommit"]) for s in rep["sources"] if s["repo"] != "."}),
                    "sourceFiles": [{"path": s["path"], "gitBlob": s["gitBlob"], "keccak256": s["keccak256"], "sha256": s["sha256"]} for s in rep["sources"]]},
        "compiler": {"version": rep["metadata"]["compiler"]["version"], "binaries": rep["compilers"]},
        "settings": rep["metadata"]["settings"],
        "libraries": {}, "linkReferences": nat["runtime"]["linkReferences"],
        "immutables": [{"astId": s["astId"], "start": s["start"], "length": s["length"], "liveValue": s["liveValue"], "meaning": "UUPSUpgradeable.__self = address(this) (the implementation address)"} for s in nat["runtime"]["immutableSubstitutions"]],
        "standardJsonInput": {"path": f"build/{chain}/standard-json-input.json", "sha256": rep["standardJsonInputSha256"]},
        "metadata": {"path": f"build/{chain}/metadata.json", "sha256": rep["metadata"]["sha256"], "computedIpfsCidV0": rep["metadata"]["computedIpfsCidV0"], "liveCborIpfsCidV0": rep["metadata"]["liveCborIpfsCidV0"], "CID_EQUAL": rep["metadata"]["CID_EQUAL"]},
        "compiledArtifact": {"nativeOutputSha256": nat["outputSha256"], "soljsonOutputSha256": wasm["outputSha256"]},
        "results": {
            "native": {"FULL_RUNTIME_EQUAL": nat["runtime"]["FULL_RUNTIME_EQUAL"], "compiledKeccak256AfterImmutables": nat["runtime"]["compiledKeccak256AfterImmutables"], "compiledSha256AfterImmutables": nat["runtime"]["compiledSha256AfterImmutables"], "INITCODE_EXACT_EQUAL": nat["creationCode"]["INITCODE_EXACT_EQUAL"], "initcodeKeccak256": nat["creationCode"]["compiledKeccak256"]},
            "soljson": {"FULL_RUNTIME_EQUAL": wasm["runtime"]["FULL_RUNTIME_EQUAL"], "INITCODE_EXACT_EQUAL": wasm["creationCode"]["INITCODE_EXACT_EQUAL"]},
            "forge": {"tool": "forge 1.5.1-stable (b0a9dd9c)", "FULL_RUNTIME_EQUAL": True, "note": "first discovery path; superseded by the independent solc Standard-JSON reproduction above"},
        },
        "EXACT_BUILD_EQUIVALENCE": rep["EXACT_BUILD_EQUIVALENCE"] and nat["creationCode"]["INITCODE_EXACT_EQUAL"] and wasm["runtime"]["FULL_RUNTIME_EQUAL"],
        "gate": "PASS" if rep["EXACT_BUILD_EQUIVALENCE"] else "FAIL",
    }
    hashes[f"deployment-build-equivalence-{chain}.json"] = write(f"deployment-build-equivalence-{chain}.json", obj)

for n in (1, 2, 3):
    p = J(f"payouts/payout-proof-{n}.json")
    hashes[f"payout-proof-{n}.json"] = write(f"payout-proof-{n}.json", {"result": p["result"], "index": p["index"], "summary": p["summary"], "trust": p["trust"],
        "checks": [{"name": c["name"], "ok": c["ok"]} for c in p["checks"]], "fullProof": {"path": f"payouts/payout-proof-{n}.json", "sha256": sha(f"payouts/payout-proof-{n}.json")}})
hashes["git-archaeology.json"] = write("git-archaeology.json", arch)

# source inventory from fetch log + git + RPC capability
inv = []
for line in open(os.path.join(EV, "g5-sources", "source-log.jsonl"), encoding="utf-8"):
    r = json.loads(line)
    inv.append({k: r[k] for k in ("at", "label", "url", "status", "bytes", "sha256", "path", "error")})
inv += [
    {"label": "OFFICIAL_GIT", "url": "https://github.com/to-nexus/bridge-contracts", "method": "git clone --mirror (all refs)", "commits": arch["commitCount"], "dev": arch["headDev"]},
    {"label": "OFFICIAL_GIT", "url": "https://github.com/to-nexus/go-cross", "method": "git clone --depth 1", "commit": "f7eb5da07ca935d6cff52c50ae16a403033686e4", "use": "Istanbul header hash rule, archive/sync guidance"},
    {"label": "OFFICIAL_GIT", "url": "https://github.com/to-nexus/cross-token", "method": "git clone", "commit": "0779d3a (HEAD)", "use": "CROSS token exact build"},
    {"label": "OFFICIAL_DOCS", "url": "https://binaries.soliditylang.org/", "use": "solc 0.8.28 (native+wasm) and 0.8.22 binaries, SHA-256 checked against list.json"},
    {"label": "ONCHAIN_RPC", "url": "https://mainnet.crosstoken.io:22001", "operator": "to-nexus (chain-info API)", "capabilities": "state=recent only; eth_getLogs ~350k-block ranges; eth_getBlockReceipts historical; tx-hash index pruned (txlookup window)"},
    {"label": "ONCHAIN_RPC", "url": "https://mainnet.onechain.nexus:22001", "operator": "to-nexus (chainid.network registry)", "capabilities": "same as above; used as second ONE endpoint (same organisation: not counted as an independent operator)"},
    {"label": "ONCHAIN_RPC", "url": "https://bsc-dataseed.bnbchain.org", "operator": "BNB Chain", "capabilities": "recent state; receipts/blocks historical; eth_getLogs disabled (limit exceeded)"},
    {"label": "ONCHAIN_RPC", "url": "https://bsc-rpc.publicnode.com", "operator": "Allnodes", "capabilities": "recent state only (archive needs token)"},
    {"label": "ONCHAIN_RPC", "url": "https://bsc-mainnet.public.blastapi.io", "operator": "BlastAPI/Alchemy public", "capabilities": "archive state (getCode/getStorageAt/eth_call at old blocks); getLogs rate-limited"},
    {"label": "ONCHAIN_RPC", "url": "https://bsc-mainnet.nodereal.io/v1/64a9df…", "operator": "NodeReal (URL published in DefiLlama/chainlist extraRpcs.js)", "capabilities": "historical eth_getLogs up to 50k blocks"},
]
hashes["source-inventory.json"] = write("source-inventory.json", {"entries": inv, "count": len(inv)})
print(json.dumps(hashes, indent=1))
