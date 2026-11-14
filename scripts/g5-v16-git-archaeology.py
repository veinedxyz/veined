"""V1.6 G5 Git archaeology over the full to-nexus/bridge-contracts history (all refs).

Outputs evidence <root>/git/git-archaeology.json:
- repository refs/tags/commit counts
- source-equivalence class: every commit whose blobs for ALL metadata-listed top-level sources and
  whose lib submodule pins equal the exact-build commit (ONE: CrossBridge, BSC: BSCBridgeV2)
- verification of the test/legacy/CrossBridgeLegacy.sol "frozen exact copy" claim
- history of deployment/upgrade scripts mentioning implementation deployment
"""
import json, os, subprocess, sys, hashlib, datetime, re, difflib

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
EVID = os.path.join(REPO, open(os.path.join(REPO, ".otherbridge", "v16-evidence-path.txt")).read().strip())
GIT = os.path.abspath(os.path.join(REPO, "..", "otherbridge-forensics", "v16", "bridge-contracts.git"))

def g(*args, check=True):
    r = subprocess.run(["git", "--git-dir", GIT, *args], capture_output=True, check=check)
    return r.stdout.decode("utf-8", "replace")

def blob(commit, path):
    r = subprocess.run(["git", "--git-dir", GIT, "rev-parse", f"{commit}:{path}"], capture_output=True)
    return r.stdout.decode().strip() if r.returncode == 0 else None

def show(commit, path):
    r = subprocess.run(["git", "--git-dir", GIT, "show", f"{commit}:{path}"], capture_output=True)
    return r.stdout if r.returncode == 0 else None

out = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "repository": "https://github.com/to-nexus/bridge-contracts", "mirror": "git clone --mirror (all refs)"}
out["refs"] = [l.split(" ", 1) for l in g("for-each-ref", "--format=%(objectname) %(refname)").strip().splitlines()]
commits = g("rev-list", "--all", "--date-order").split()
out["commitCount"] = len(commits)
out["headDev"] = g("rev-parse", "refs/heads/dev").strip()

def equivalence(chain, exact_commit, compile_target):
    rep = json.load(open(os.path.join(EVID, "build", chain, "reproduction.json")))
    top = [s["path"] for s in rep["sources"] if s["repo"] == "."]
    libs = sorted({s["repo"] for s in rep["sources"] if s["repo"] != "."})
    ref_blobs = {p: blob(exact_commit, p) for p in top}
    ref_libs = {l: g("ls-tree", exact_commit, l).split()[2] for l in libs}
    members = []
    for c in commits:
        if all(blob(c, p) == b for p, b in ref_blobs.items()):
            lib_ok = all((g("ls-tree", c, l, check=False).split() or [None, None, None])[2] == v for l, v in ref_libs.items())
            if lib_ok:
                members.append(c)
    info = []
    for c in members:
        meta = g("show", "-s", "--format=%H%x00%ad%x00%an%x00%s", "--date=iso-strict", c).split("\x00")
        refs = [r for o, r in out["refs"] if o == c]
        info.append({"commit": meta[0], "date": meta[1], "author": meta[2], "subject": meta[3].strip(), "refsPointingHere": refs})
    info.sort(key=lambda x: x["date"])
    return {"exactBuildCommit": exact_commit, "compilationTarget": compile_target, "topLevelSourceBlobs": ref_blobs, "libSubmodulePins": ref_libs,
            "equivalentCommits": info, "count": len(info),
            "note": "Every listed commit yields byte-identical metadata sources and lib pins, hence the identical build. The deployment commit is not uniquely identifiable among them; the SOURCE is."}

out["one"] = equivalence("one", "b3b025852a100d6b825a85ab26e7895fde65e633", "src/CrossBridge.sol:CrossBridge")
out["bsc"] = equivalence("bsc", "6da2fb2d7a2fee2414fea894fe521f6362884569", "src/BSCBridgeV2.sol:BSCBridgeV2")

# Frozen-copy claim
legacy_commit = "a19497279f2f66eabc7aa427d354b35dbb28c41a"
legacy = show("3a8347cd005d00e50af9194204a55da69f96ddfc", "test/legacy/CrossBridgeLegacy.sol").decode()
live_src = show("b3b025852a100d6b825a85ab26e7895fde65e633", "src/CrossBridge.sol").decode()
pre_unify = show(legacy_commit + "^", "src/CrossBridge.sol").decode()
def normalize(t):
    t = re.sub(r"// =+\n(//.*\n)*// =+\n\n", "", t)  # drop the FROZEN banner
    t = t.replace("CrossBridgeLegacy", "CrossBridge").replace("../../src/", "./")
    return t
diff_live = list(difflib.unified_diff(live_src.splitlines(), normalize(legacy).splitlines(), "b3b0258:src/CrossBridge.sol", "legacy(normalized)", lineterm="", n=1))
diff_pre = list(difflib.unified_diff(pre_unify.splitlines(), normalize(legacy).splitlines(), "a194972^:src/CrossBridge.sol", "legacy(normalized)", lineterm="", n=1))
legacy_intro = show(legacy_commit, "test/legacy/CrossBridgeLegacy.sol").decode()
legacy_history = g("log", "--all", "--format=%H %ad %s", "--date=short", "--", "test/legacy/CrossBridgeLegacy.sol").strip().splitlines()
base_live = show("b3b025852a100d6b825a85ab26e7895fde65e633", "src/BaseBridge.sol").decode()
base_now = show("3a8347cd005d00e50af9194204a55da69f96ddfc", "src/BaseBridge.sol").decode()
base_diff = list(difflib.unified_diff(base_live.splitlines(), base_now.splitlines(), "b3b0258:src/BaseBridge.sol", "3a8347c:src/BaseBridge.sol", lineterm="", n=0))
out["frozenCopyClaim"] = {
    "file": "test/legacy/CrossBridgeLegacy.sol", "introducedBy": legacy_commit,
    "introducedSubject": g("show", "-s", "--format=%s", legacy_commit).strip(),
    "bannerClaimsImplementation": "0x2827865ad5330faf855af8b743c701ae9c818034" in legacy,
    "contractBodyEqualsLiveCrossBridgeAfterNameAndImportNormalization": len(diff_live) == 0,
    "diffAgainstLiveSourceAfterNormalization": diff_live[:80],
    "contractBodyEqualsPreUnificationCrossBridge": len(diff_pre) == 0,
    "atIntroduction_equalsLiveCrossBridgeAfterNormalization": normalize(legacy_intro) == live_src,
    "atIntroduction_equalsPreUnificationCrossBridge": normalize(legacy_intro) == pre_unify,
    "liveCrossBridgeUnchangedUntilUnification": pre_unify == live_src,
    "legacyFileHistory": legacy_history,
    "laterEditOfFrozenFile": "82b7c0f (2026-09-16) added `address to` to _checkFinalizeAmount to compile against the newer BaseBridge; the current file is therefore NOT a byte-for-byte copy of the live source body anymore.",
    "baseBridgeChangedSinceLiveBuild": len(base_diff) > 0,
    "baseBridgeDiffLineCount": len(base_diff),
    "consequence": "The frozen file imports the CURRENT src/BaseBridge.sol; compiling it today does NOT reproduce the live implementation. Exact equivalence comes only from the original b3b0258 tree (proven byte-for-byte in build/one).",
}

# Deployment/upgrade scripts history
scripts = {}
for path in ["script/Implementation.s.sol", "script/Bridge.s.sol", "script/BSCBridgeV2.s.sol", "script/BaseBridge.s.sol"]:
    log = g("log", "--all", "--format=%h %ad %s", "--date=short", "--", path, check=False).strip().splitlines()
    if log: scripts[path] = log[:30]
names = sorted({p for p in g("log", "--all", "--name-only", "--format=", "--", "script").split() if p.startswith("script/")})
out["deploymentScripts"] = {"allScriptPathsEverCommitted": names, "historyOfKeyScripts": scripts}
out["liveAddressMentions"] = {a: g("log", "--all", "-i", f"-G{a}", "--format=%h %ad %s", "--date=short").strip().splitlines()
                              for a in ["2827865ad5330faf855af8b743c701ae9c818034", "ac7b8ffed19d670930b8caa0693189b33454e8d8", "a6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5"]}
os.makedirs(os.path.join(EVID, "git"), exist_ok=True)
text = json.dumps(out, indent=1)
open(os.path.join(EVID, "git", "git-archaeology.json"), "w", encoding="utf-8").write(text + "\n")
print(json.dumps({"commits": out["commitCount"], "oneEquivalent": [(x["commit"][:7], x["date"], x["refsPointingHere"]) for x in out["one"]["equivalentCommits"]],
                  "bscEquivalent": [(x["commit"][:7], x["date"], x["refsPointingHere"]) for x in out["bsc"]["equivalentCommits"]],
                  "frozen": {k: v for k, v in out["frozenCopyClaim"].items() if k != "diffAgainstLiveSourceAfterNormalization"},
                  "diffSample": out["frozenCopyClaim"]["diffAgainstLiveSourceAfterNormalization"][:20],
                  "scripts": out["deploymentScripts"]["allScriptPathsEverCommitted"]}, indent=1))
