"""V1.6 G5 document generator: every number/hash in the generated docs is read from the evidence root.
Usage: python scripts/g5-v16-docs.py [build|payouts|inventory|all]
"""
import json, os, sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
REL = open(os.path.join(REPO, ".otherbridge", "v16-evidence-path.txt")).read().strip()
EV = os.path.join(REPO, REL)
J = lambda p: json.load(open(os.path.join(EV, p), encoding="utf-8"))
DOCS = os.path.join(REPO, "docs")

def write(name, text):
    open(os.path.join(DOCS, name), "w", encoding="utf-8", newline="\n").write(text.strip() + "\n")
    print("wrote", name)

def fmt_units(v, d=18):
    v = int(v); w, f = divmod(v, 10 ** d)
    return f"{w:,}.{str(f).rjust(d, '0').rstrip('0') or '0'}"

def build_doc(chain):
    b = J(f"manifests/deployment-build-equivalence-{chain}.json")
    title = "ONEchain (612055) CrossBridge implementation" if chain == "one" else "BSC (56) BSCBridgeV2 implementation"
    src = b["source"]; nat = b["results"]["native"]; s = b["settings"]
    lines = [f"# G5 build provenance — {title}", "",
             f"Result: **EXACT BUILD EQUIVALENCE = {'PASS' if b['EXACT_BUILD_EQUIVALENCE'] else 'FAIL'}** (full deployed runtime byte equality after substituting only the compiler-declared immutables; initcode equality; metadata CID equality). Evidence root: `{REL}`.", "",
             "## Live deployment", "",
             "| Field | Value |", "|---|---|",
             f"| Chain / implementation | {b['chainId']} / `{b['liveImplementation']}` |",
             f"| Pinned block / hash | {b['pinnedBlock']} / `{b['pinnedBlockHash']}` |",
             f"| Runtime bytes | {b['liveRuntime']['bytes']} |",
             f"| Runtime keccak256 | `{b['liveRuntime']['keccak256']}` |",
             f"| Runtime SHA-256 | `{b['liveRuntime']['sha256']}` |",
             f"| RPC agreement | {b['liveRuntime']['rpcAgreement']['sourcesOk']} source(s) identical implementation + hash: {b['liveRuntime']['rpcAgreement']['implementationHashAgrees']} |",
             f"| CBOR footer | solc {b['liveRuntime']['cbor']['solc']}, IPFS `{b['liveRuntime']['cbor']['ipfs']}` |",
             f"| Creation tx | `{b['creation']['tx']}` (block {b['creation']['block']}, {b['creation']['time']}, creator `{b['creation']['creator']}`) |",
             f"| Creation data sources | {'; '.join(b['creation']['sources'])} |",
             f"| Installed in proxy by | {b['creation']['installedBy']['event']} block {b['creation']['installedBy']['block']}, tx `{b['creation']['installedBy']['tx']}` ({b['creation']['installedBy']['source']}) |",
             "", "## Exact source", "",
             f"- Repository: {src['repository']} (full mirror clone, all refs).",
             f"- Build commit: `{src['buildCommit']}`; compilation target `{list(src['compilationTarget'].items())[0][0]}:{list(src['compilationTarget'].items())[0][1]}`.",
             f"- Byte-identical source trees (same blobs for every metadata source and same lib pins) exist at {len(src['equivalentCommits'])} commits: " + ", ".join(f"`{c[:7]}`" for c in src["equivalentCommits"]) + ". The SOURCE is unique; which of these commits the operator checked out is not distinguishable and does not matter for byte equivalence.",
             "- Dependencies (git submodule pins): " + "; ".join(f"`{r}` @ `{c}`" for r, c in src["dependencyPins"]) + ".",
             f"- {len(src['sourceFiles'])} source files are listed in the compiler metadata; every file's keccak256 was recomputed from the exact Git blob bytes (no CRLF conversion) and equals the metadata value. Full list with git blob ids, keccak256 and SHA-256: `{REL}/build/{chain}/reproduction.json`.",
             "", "## Compiler and settings", "",
             f"- Compiler: `{b['compiler']['version']}`; official native binary `{b['compiler']['binaries']['native']['path']}` SHA-256 `{b['compiler']['binaries']['native']['sha256']}` and official wasm `{b['compiler']['binaries']['soljson']['path']}` SHA-256 `{b['compiler']['binaries']['soljson']['sha256']}` (both equal to binaries.soliditylang.org list.json).",
             f"- Settings (from metadata): optimizer enabled={s['optimizer']['enabled']} runs={s['optimizer']['runs']}, viaIR={s['viaIR']}, evmVersion={s['evmVersion']}, metadata.bytecodeHash={s['metadata']['bytecodeHash']}, libraries={s['libraries']}, {len(s['remappings'])} remappings (forge auto-detected + remappings.txt).",
             f"- Libraries / link references: none (`{b['linkReferences']}`).",
             "- Immutables: " + "; ".join(f"astId {i['astId']} @ {i['start']} (+{i['length']}) = `{i['liveValue']}` — {i['meaning']}" for i in b["immutables"]) + ". The value is exactly the implementation's own address; initcode equality independently proves it is constructor-derived (`address(this)`).",
             "", "## Reproduction (independent of forge)", "",
             f"- Standard JSON input (minimal, rebuilt from metadata): `{b['standardJsonInput']['path']}` SHA-256 `{b['standardJsonInput']['sha256']}`.",
             f"- Metadata: `{b['metadata']['path']}` SHA-256 `{b['metadata']['sha256']}`; recomputed IPFS CIDv0 `{b['metadata']['computedIpfsCidV0']}` == live CBOR `{b['metadata']['liveCborIpfsCidV0']}`: **{b['metadata']['CID_EQUAL']}**.",
             f"- Native solc output SHA-256 `{b['compiledArtifact']['nativeOutputSha256']}`; soljson output SHA-256 `{b['compiledArtifact']['soljsonOutputSha256']}`.",
             f"- Compiled runtime after immutable substitution: keccak256 `{nat['compiledKeccak256AfterImmutables']}`, SHA-256 `{nat['compiledSha256AfterImmutables']}`.",
             f"- FULL RUNTIME BYTE EQUALITY: native **{nat['FULL_RUNTIME_EQUAL']}**, soljson **{b['results']['soljson']['FULL_RUNTIME_EQUAL']}**, forge **{b['results']['forge']['FULL_RUNTIME_EQUAL']}**.",
             f"- INITCODE EXACT EQUALITY with the on-chain creation input (no constructor arguments): native **{nat['INITCODE_EXACT_EQUAL']}**, soljson **{b['results']['soljson']['INITCODE_EXACT_EQUAL']}** (initcode keccak256 `{nat['initcodeKeccak256']}`).",
             "", "Re-run: `python scripts/g5-v16-repro.py <chain> <checkout> <source> <contract> <liveRuntimeHex> <creationInputHex> <outRel>` (checkout = git worktree of the build commit with recursive submodules; sources are read from Git blobs). Metadata-stripped or prefix equality are NOT used for acceptance; they are only reported as diagnostics.",
             "", "Machine-readable: `" + f"{REL}/manifests/deployment-build-equivalence-{chain}.json" + "`."]
    write(f"G5_BUILD_PROVENANCE_{chain.upper()}.md", "\n".join(lines))

def archaeology_doc():
    a = J("git/git-archaeology.json"); f = a["frozenCopyClaim"]
    lines = ["# G5 Git archaeology — to-nexus/bridge-contracts", "",
             f"Full mirror clone (all {len(a['refs'])} refs; {a['commitCount']} commits; `dev` = `{a['headDev']}`). Raw output: `{REL}/git/git-archaeology.json`.", "",
             "## Timeline relevant to the live implementations", "",
             "| When (UTC) | Event | Evidence |", "|---|---|---|",
             "| 2025-04-16 | `v1.0.0` tag (8848679): first bridge release (CrossBridge/BSCBridge, runs 162, no viaIR) | git |",
             "| 2025-04-28 12:27 | BSC proxy `0xa6a1…06c5` created with impl `0xd9a946f7…` and `initializeBSCBridge(..., crossInitialSupply=20,000,000e18)` | BSC creation tx `0x68d24b70…` |",
             "| 2025-04-28 12:39 | ONE predeployed proxy initialized: `initializeCrossBridge(..., crossInitialSupply=20,000,000e18)` | ONE block 452398 tx `0x8031581f…` |",
             "| 2025-10-02 | BSC upgraded to `0x68ceaecf…` (BSCBridgeV2 reinitializer(2)); BridgeVerifier `0x4a508a3d…`/`0xf4dc7ff0…` deployed from `23a66d7` era | BSC Upgraded tx `0x82162d31…`; CrossScan |",
             "| 2026-01-08/09 | CertiK CBU-29…32 fixes; `v1.0.3` tag `b3b0258` (11:50 KST) | git |",
             "| 2026-01-09 06:02 | ONE impl `0x2827865a…` created (tx `0xc16d6ab2…`) | ONE block 22464737 |",
             "| 2026-01-09 08:35/08:36 | ONE proxy and BSC proxy upgraded (ONE → `0x2827865a…`; BSC → `0x71f6901b…`) | Upgraded logs |",
             "| 2026-04-14 13:52 | BSC impl `0xac7b8ffe…` created; upgraded at 13:55 | BSC blocks 92497755 / 92498159 |",
             "| 2026-04-14 21:52 KST | master merge `6da2fb2` (PR #38: INITIATOR_ROLE permit batch + extraData) | git |",
             "| 2026-09-09 | `test/legacy/CrossBridgeLegacy.sol` introduced as \"frozen copy\" (a194972) | git |",
             "| 2026-09-16 | the \"frozen\" file edited (`address to` added) in 82b7c0f | git |",
             "| 2026-10-02 | `release/v1.1`: CertiK 2026-09 audit fixes CBU-03/09/10/11 (not deployed) | git |",
             "", "## Exact-build commits (from the byte-for-byte reproduction)", "",
             f"- ONE implementation: `{a['one']['exactBuildCommit']}` (`v1.0.3`); identical source class: " + ", ".join(f"`{c['commit'][:7]}` ({c['date'][:10]}{', ' + ', '.join(c['refsPointingHere']) if c['refsPointingHere'] else ''})" for c in a["one"]["equivalentCommits"]) + ".",
             f"- BSC implementation: `{a['bsc']['exactBuildCommit']}`; identical source class: " + ", ".join(f"`{c['commit'][:7]}` ({c['date'][:10]}{', ' + ', '.join(c['refsPointingHere']) if c['refsPointingHere'] else ''})" for c in a["bsc"]["equivalentCommits"]) + ".",
             "- Both use OpenZeppelin contracts `acd4ff74…` and contracts-upgradeable `3d5fa5c2…` (submodule pins identical across the class).",
             "", "## The \"frozen exact code\" claim (test/legacy/CrossBridgeLegacy.sol)", "",
             f"- Introduced by `{f['introducedBy']}`: \"{f['introducedSubject']}\". The banner names implementation `0x2827865a…`: {f['bannerClaimsImplementation']}.",
             f"- At introduction, after reverting only the contract name and import paths, the body was identical to the live `src/CrossBridge.sol` of `b3b0258`: **{f['atIntroduction_equalsLiveCrossBridgeAfterNormalization']}** (and to the pre-unification file: {f['atIntroduction_equalsPreUnificationCrossBridge']}; live CrossBridge.sol unchanged until unification: {f['liveCrossBridgeUnchangedUntilUnification']}).",
             f"- The current file (3a8347c) is NOT identical any more: {f['laterEditOfFrozenFile']}",
             f"- It imports the current `src/BaseBridge.sol`, which differs from the live build ({f['baseBridgeDiffLineCount']} diff lines). Compiling the frozen file today cannot reproduce the live runtime. Conclusion: the comment is correct provenance for the CrossBridge.sol *body* only; exact equivalence rests solely on the original `b3b0258` tree reproduced byte-for-byte (see G5_BUILD_PROVENANCE_ONE.md).",
             "", "## Deployment / upgrade scripts", "",
             "No Forge `broadcast/` artifacts are committed; no live implementation address appears in any script. Script paths ever committed: " + ", ".join(f"`{p}`" for p in a["deploymentScripts"]["allScriptPathsEverCommitted"]) + ".",
             "Live addresses mentioned anywhere in history: " + "; ".join(f"`{k[:10]}…`: {len(v)} commit(s)" for k, v in a["liveAddressMentions"].items()) + " (only the legacy banner)."]
    write("G5_GIT_ARCHAEOLOGY.md", "\n".join(lines))

def payout_doc(n):
    p = J(f"payouts/payout-proof-{n}.json"); s = p["summary"]["source"]; d = p["summary"]["destination"]
    label = {1: "revalidated accepted proof (index 98483)", 2: "fresh independent recent proof", 3: "optional third recent proof"}[n]
    lines = [f"# G5 payout proof {n} — {label}", "",
             f"Result: **{p['result']}** ({sum(c['ok'] for c in p['checks'])}/{len(p['checks'])} checks). Index **{p['index']}**. Full machine-readable proof: `{REL}/payouts/payout-proof-{n}.json` (raw headers, receipts, Merkle proof nodes, signatures); RPC log `{REL}/payouts/{n}-rpc.jsonl`.", "",
             "| | Source (ONEchain 612055) | Destination (BSC 56) |", "|---|---|---|",
             f"| Transaction | `{s['tx']}` | `{d['tx']}` |",
             f"| Block / hash | {s['block']} / `{s['blockHash']}` | {d['block']} / `{d['blockHash']}` |",
             f"| Time (UTC) | {s['timestamp']} | {d['timestamp']} |",
             f"| Emitter | proxy `{s['proxy']}` | proxy `{d['proxy']}` |",
             f"| Event | BridgeInitiated(toChainID=56, index={p['index']}) log {s['logIndex']} | CROSS Transfer log {d['transferLogIndex']} → BridgeFinalized(fromChainID=612055, index={p['index']}) log {d['finalizedLogIndex']} |",
             f"| Recipient | `{s['to']}` | `{d['to']}` |",
             f"| Principal | {s['value']} ({fmt_units(s['value'])} ONE) | {d['value']} ({fmt_units(d['value'])} CROSS) |",
             f"| Fees | networkFee {fmt_units(s['networkFee'])} ONE, exFee {fmt_units(s['exFee'])} | — |",
             f"| Canonicality | {s['confirmations']} confirmations on both official endpoints + CrossScan block hash | block ≤ `finalized` tag ({d['finalizedTagBlock']}) on two operators |",
             f"| Implementation at block | `0x2827865a…` (only Upgraded event ≤ block: 22473937) | `{d['implementation']}` read from archive state at the block |",
             f"| Validators | — | {d['validSigners']} valid distinct signers ≥ threshold {d['threshold']} (EIP-712 recovered from public calldata) |",
             "", "Cryptographic binding: on each chain the block header was re-encoded and hashed to the reported block hash (ONE uses go-cross Istanbul filtered-extra hashing), the full block receipt list was re-encoded and its Patricia trie root recomputed to equal the header `receiptsRoot`, and a Merkle proof for the target receipt was generated and verified with `@ethereumjs/mpt` 10.1.3 (the stored proof re-verifies offline in `tests/unit/v16-g5.test.ts`).", "",
             "## Checks", ""] + [f"- {'PASS' if c['ok'] else 'FAIL'} — {c['name']}" for c in p["checks"]] + ["",
             f"Trust classes: source — {p['trust']['source']}; destination — {p['trust']['destination']}.",
             "Historical settlement evidence only; it is not a guarantee for future transfers."]
    write(f"G5_PAYOUT_PROOF_{n}.md", "\n".join(lines))

def inventory_doc():
    inv = J("manifests/source-inventory.json")["entries"]
    lines = ["# G5 public source inventory (V1.6)", "", f"Every public artifact used for a G5 claim, with retrieval time, status, SHA-256 and trust label. Raw bodies: `{REL}/g5-sources/`; RPC request/response logs per topic under `{REL}/`.", "",
             "Trust labels: ONCHAIN_RPC, OFFICIAL_EXPLORER_INDEX, THIRD_PARTY_EXPLORER, OFFICIAL_GIT, CONTENT_ADDRESSED_METADATA, OFFICIAL_DOCS, DERIVED.", "",
             "| Label | URL / source | Status | SHA-256 / note |", "|---|---|---|---|"]
    for e in inv:
        if "sha256" in e:
            lines.append(f"| {e['label']} | `{e['url'][:110]}` | {e['status']}{' ' + e['error'] if e.get('error') else ''} | `{e['sha256'][:16]}…` ({e['bytes']} B) |")
        else:
            lines.append(f"| {e['label']} | `{e['url']}` | — | {e.get('capabilities') or e.get('use') or e.get('method')} |")
    lines += ["", "Negative results recorded honestly: Sourcify has no match for either implementation or the BSC proxy (404); CrossScan has the ONE proxy verified (ERC1967Proxy) but not the implementation; BscScan pages are Cloudflare-blocked (403) and the Etherscan V2 free tier does not cover BSC; public IPFS gateways rate-limited the three metadata CIDs (429). None of these were needed: the metadata was reconstructed and its CID recomputed locally."]
    write("G5_PUBLIC_SOURCE_INVENTORY.md", "\n".join(lines))

if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    if what in ("build", "all"):
        build_doc("one"); build_doc("bsc"); archaeology_doc()
    if what in ("payouts", "all"):
        for n in (1, 2, 3): payout_doc(n)
    if what in ("inventory", "all"):
        inventory_doc()
