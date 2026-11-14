"""V1.6 G5 decision: computes gates A-J strictly from evidence artifacts (never from prose) and writes
G5_DECISION.json, G5_CURRENT_ROUTE_SNAPSHOT.json and reserve-reconciliation.json into <evidence>/manifests/,
plus a SHA-256 manifest of every machine-readable artifact. Exit code 0 always; the status is data.
"""
import json, os, hashlib, re, datetime

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
REL = open(os.path.join(REPO, ".otherbridge", "v16-evidence-path.txt")).read().strip()
EV = os.path.join(REPO, REL)
M = os.path.join(EV, "manifests")
J = lambda p: json.load(open(os.path.join(EV, p), encoding="utf-8"))
exists = lambda p: os.path.exists(os.path.join(EV, p))

def write(name, obj):
    text = json.dumps(obj, indent=1) + "\n"
    open(os.path.join(M, name), "w", encoding="utf-8", newline="\n").write(text)

gates, blockers, notes = {}, [], {}
def gate(key, ok, detail):
    gates[key] = {"status": "PASS" if ok else "FAIL", "detail": detail}
    if not ok: blockers.append(key)

# A — live deployment identity (final pins)
pins = J("chain-pins/deployment-identity-final.json")
a_ok = True; a_det = {}
for c, exp_impl, exp_hash, exp_proxy in (("one", "0x2827865ad5330faf855af8b743c701ae9c818034", "0x8bb2e9361035520a62a806cf78ff6f325d32c578a63f35ad49263524361e04bc", "0x0dac1e1deb9381d1139c43a9d49d022a4786242e90744abd0f77bf85375b548b"),
                                         ("bsc", "0xac7b8ffed19d670930b8caa0693189b33454e8d8", "0x47b60de2375276f3ead49ea41f35c58d068d6bd57625d3553db4257476f91f22", "0x25b30cfa97d56a7b846443ce92558cf31d86e95966c5afa22dacb0213c52ff9b")):
    ch = pins["chains"][c]; ok_src = [s for s in ch["sources"] if not s.get("error")]
    good = len(ok_src) >= 2 and all(s["implementationFromSlot"] == exp_impl and s["implementation"]["keccak256"] == exp_hash and s["proxy"]["keccak256"] == exp_proxy and s["blockHashAgrees"] for s in ok_src)
    a_det[c] = {"block": ch["pinnedBlock"], "blockHash": ch["pinnedBlockHash"], "sourcesAgreeing": len(ok_src), "implementation": exp_impl, "runtimeKeccak256": exp_hash, "proxyRuntimeKeccak256": exp_proxy, "ok": good}
    a_ok &= good
gate("A_LIVE_DEPLOYMENT_IDENTITY", a_ok, a_det)

# B, C — exact builds
for key, c in (("B_ONE_EXACT_SOURCE_BUILD_EQUIVALENCE", "one"), ("C_BSC_EXACT_SOURCE_BUILD_EQUIVALENCE", "bsc")):
    b = J(f"manifests/deployment-build-equivalence-{c}.json")
    gate(key, b["EXACT_BUILD_EQUIVALENCE"] is True, {"commit": b["source"]["buildCommit"], "compiler": b["compiler"]["version"], "settings": b["settings"]["optimizer"] | {"viaIR": b["settings"]["viaIR"], "evmVersion": b["settings"]["evmVersion"]},
        "fullRuntimeEqual": b["results"]["native"]["FULL_RUNTIME_EQUAL"] and b["results"]["soljson"]["FULL_RUNTIME_EQUAL"], "initcodeEqual": b["results"]["native"]["INITCODE_EXACT_EQUAL"], "metadataCidEqual": b["metadata"]["CID_EQUAL"], "standardJsonSha256": b["standardJsonInput"]["sha256"]})

# D — reserve semantics: exact source + fork invariants + archive historical deltas
fork_log = open(os.path.join(EV, "fork-tests", "fork-tests-final.log"), encoding="utf-8", errors="replace").read() if exists("fork-tests/fork-tests-final.log") else ""
m = re.search(r"(\d+) tests passed, (\d+) failed, (\d+) skipped", fork_log)
fork_ok = bool(m) and int(m.group(2)) == 0 and int(m.group(1)) >= 22
hist = J("reserve/historical-deltas.json")
gate("D_RESERVE_ACCOUNTING_SEMANTICS", fork_ok and hist["allMatch"] and gates["C_BSC_EXACT_SOURCE_BUILD_EQUIVALENCE"]["status"] == "PASS",
     {"source": "exact BSCBridgeV2@6da2fb2 (byte-proven)", "forkTests": m.group(0) if m else "MISSING", "historicalDeltaCases": len(hist["cases"]), "historicalAllMatch": hist["allMatch"]})

# E — pinned spendable reserve reconciliation at the FINAL pinned block
led = J("reserve/bsc-ledger-reconciliation.json")
snap = J("reserve/route-snapshot-final.json")
bsc = snap["chains"]["bsc"]; st = next(s for s in bsc["sources"] if not s.get("error"))["state"]
one = snap["chains"]["one"]; ost = next(s for s in one["sources"] if not s.get("error"))["state"]
pair = next(p for p in st["chains"]["612055"]["pairs"] if p["localToken"].lower() == "0x6bf62ca91e397b5a7d1d6bce97d9092065d7a510")
balance, dep, pend = int(st["cross"]["balanceOfBridge"]), int(pair["deposited"]), int(pair["pendingAmount"])
pending_sum = sum(int(p["args"]["value"]) for p in st["chains"]["612055"]["pending"] if p["args"]["toToken"].lower() == "0x6bf62ca91e397b5a7d1d6bce97d9092065d7a510")
in_flight_count = int(ost["chains"]["56"]["nextInitiateIndex"]) - int(st["chains"]["612055"]["nextFinalizeIndex"])
in_flight = J("reserve/in-flight-final.json") if exists("reserve/in-flight-final.json") else {"enumerated": in_flight_count <= 0, "values": []}
in_flight_sum = sum(int(v) for v in in_flight["values"])
spendable = max(0, min(balance, dep) - pend - in_flight_sum)
minted = int(next(p for p in ost["chains"]["56"]["pairs"] if p["localToken"].lower() == "0x0000000000000000000000000000000000000001")["minted"])
minimum = int(ost["verifier"]["tokenConfigToRemote"][0])
reserve = {
    "pinnedBlock": bsc["block"], "pinnedBlockHash": bsc["blockHash"], "physicalCrossBaseUnits": str(balance), "deposited": str(dep), "pendingAmount": str(pend),
    "activePendingRecords": [{"index": p["index"], "toToken": p["args"]["toToken"], "value": p["args"]["value"], "status": p["status"], "delayExpiration": p["delayExpiration"]} for p in st["chains"]["612055"]["pending"]],
    "activePendingSum": str(pending_sum), "inFlightCount": max(0, in_flight_count), "inFlightEnumerated": in_flight["enumerated"], "inFlightSum": str(in_flight_sum),
    "spendableReserveBaseUnits": str(spendable), "spendableReserveCROSS": f"{spendable / 10**18:,.6f}", "routeMinimum": str(minimum),
    "routeMaximumByReserve": str(spendable), "routeMaximumByContract": str(minted), "effectiveMaximum": str(min(spendable, minted)),
    "surplusBaseUnits": str(balance - dep), "verifierValueThresholds": {"verificationAmountThreshold": st["verifier"]["getVerificationAmountThreshold"], "periodTotalValueThreshold": st["verifier"]["getPeriodTotalValueThreshold"]},
    "ledgerReconciled": led["RECONCILED"], "ledgerPinnedBlock": led["pinnedBlock"], "ledgerChecks": led["checks"],
}
raw = st["routePairRawStorage"]["decoded"]
raw_ok = all(str(raw[k]).lower() == str(pair[k]).lower() for k in ("localToken", "remoteToken", "isOrigin", "paused", "pendingAmount", "deposited", "minted"))
reserve["rawStorageMatchesGetTokenPair"] = raw_ok
e_ok = raw_ok and (led["RECONCILED"] is True and led["pinnedBlock"] == bsc["block"] and pending_sum == pend and in_flight["enumerated"] and spendable >= minimum and bsc["consensus"]["identicalState"])
gate("E_PINNED_SPENDABLE_RESERVE_RECONCILIATION", e_ok, {k: reserve[k] for k in ("pinnedBlock", "physicalCrossBaseUnits", "deposited", "pendingAmount", "activePendingSum", "inFlightCount", "spendableReserveBaseUnits", "ledgerReconciled", "rawStorageMatchesGetTokenPair")})
write("reserve-reconciliation.json", reserve)

# F, G — payout proofs
for key, n in (("F_PAYOUT_PROOF_1", 1), ("G_PAYOUT_PROOF_2", 2)):
    p = J(f"payouts/payout-proof-{n}.json")
    gate(key, p["result"] == "PASS", {"index": p["index"], "source": p["summary"]["source"]["tx"], "destination": p["summary"]["destination"]["tx"], "checks": f"{sum(c['ok'] for c in p['checks'])}/{len(p['checks'])}"})
p3 = J("payouts/payout-proof-3.json"); notes["payoutProof3"] = {"result": p3["result"], "index": p3["index"]}

# H, I — fresh simulation at the final pin
sim = J("simulations/simulation-final.json"); g = sim["gates"]
gate("H_CURRENT_POSITIVE_READONLY_SIMULATION", g["POSITIVE_SIMULATION"] and g["runtimePinned"] and g["routeOpen"] and g["balanceCoversValuePlusGas"] and g["rpcsAgree"] and g["noStateOverride"] and not g["signed"] and not g["broadcast"],
     {"pinnedBlock": sim["pinnedBlock"], "minimum": sim["summary"]["minimum"], "networkFee": sim["summary"]["networkFee"], "serviceFee": sim["summary"]["serviceFee"], "exactMsgValue": sim["summary"]["exactMsgValue"], "estimateGas": sim["summary"]["estimateGas"]})
gate("I_NEGATIVE_CONTROL", g["NEGATIVE_CONTROL"], {"controls": sim["summary"]["negative"]})

# J — runtime drift recheck
drift = J("chain-pins/drift-recheck.json")
gate("J_RUNTIME_DRIFT_RECHECK", drift["RUNTIME_DRIFT_RECHECK"] == "PASS", {c: {"from": v["from"], "to": v["to"], "events": len(v["events"]), "noDrift": v["NO_DRIFT"]} for c, v in drift["chains"].items()})

status = "PASS" if not blockers else "BLOCKED"
decision = {
    "status": status, "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "evidenceRoot": REL,
    "source": {"chainId": 612055, "proxy": "0xb81d6e000000000000000000000000000000c0de", "implementation": "0x2827865ad5330faf855af8b743c701ae9c818034", "runtimeHash": a_det["one"]["runtimeKeccak256"], "buildEquivalent": gates["B_ONE_EXACT_SOURCE_BUILD_EQUIVALENCE"]["status"] == "PASS", "buildCommit": gates["B_ONE_EXACT_SOURCE_BUILD_EQUIVALENCE"]["detail"]["commit"]},
    "destination": {"chainId": 56, "proxy": "0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5", "implementation": "0xac7b8ffed19d670930b8caa0693189b33454e8d8", "runtimeHash": a_det["bsc"]["runtimeKeccak256"], "buildEquivalent": gates["C_BSC_EXACT_SOURCE_BUILD_EQUIVALENCE"]["status"] == "PASS", "buildCommit": gates["C_BSC_EXACT_SOURCE_BUILD_EQUIVALENCE"]["detail"]["commit"]},
    "reserve": {"verified": gates["E_PINNED_SPENDABLE_RESERVE_RECONCILIATION"]["status"] == "PASS", "pinnedBlock": str(reserve["pinnedBlock"]), "spendableBaseUnits": reserve["spendableReserveBaseUnits"]},
    "payoutProofs": sum(1 for k in ("F_PAYOUT_PROOF_1", "G_PAYOUT_PROOF_2") if gates[k]["status"] == "PASS") + (1 if p3["result"] == "PASS" else 0),
    "currentSimulation": gates["H_CURRENT_POSITIVE_READONLY_SIMULATION"]["status"], "negativeControl": gates["I_NEGATIVE_CONTROL"]["status"],
    "gates": gates, "remainingBlockers": blockers, "notes": notes,
    "routeRisk": "Settlement and upgrade authority are EOA-controlled (single admin EOA; 2-of-3 validator EOAs); G5 is point-in-time and enforced by the runtime-drift policy (see docs/G5_LEGACY_RUNTIME_SECURITY_REVIEW.md G5-SR-01).",
    "g7": "NOT_RUN - USER_APPROVAL_REQUIRED", "productionExecution": "DISABLED",
    "externalSecurityReview": "NOT_RUN", "legalReview": "NOT_RUN",
    "realSignatures": 0, "approvals": 0, "permits": 0, "broadcasts": 0, "deploys": 0, "feeCollection": 0,
}
write("G5_DECISION.json", decision)
route = {"observedAt": snap["at"], "one": {"block": one["block"], "blockHash": one["blockHash"], "paused": ost["paused"], "pair": ost["chains"]["56"]["pairs"][0], "finalizePaused": ost["chains"]["56"]["finalizePaused"], "chainPaused": ost["chains"]["56"]["chainPaused"], "nextInitiateIndex": ost["chains"]["56"]["nextInitiateIndex"], "nextFinalizeIndex": ost["chains"]["56"]["nextFinalizeIndex"], "threshold": ost["threshold"], "validators": ost["roles"]["VALIDATOR_ROLE"], "admins": ost["roles"]["ADMIN_ROLE"], "verifier": ost["verifier"]["address"], "verifierCodeHash": ost["verifier"]["codeHash"], "fees": {"minimum": ost["verifier"]["tokenConfigToRemote"][0], "networkFee": ost["verifier"]["tokenConfigToRemote"][1], "exFeeRate": ost["verifier"]["tokenConfigToRemote"][2]}, "crossSupply": ost["crossSupply"], "crossSupplyLimit": ost["crossSupplyLimit"], "implementationCodeHash": ost["implementationCodeHash"], "proxyCodeHash": ost["proxyCodeHash"]},
         "bsc": {"block": bsc["block"], "blockHash": bsc["blockHash"], "paused": st["paused"], "pair": pair, "finalizePaused": st["chains"]["612055"]["finalizePaused"], "chainPaused": st["chains"]["612055"]["chainPaused"], "nextInitiateIndex": st["chains"]["612055"]["nextInitiateIndex"], "nextFinalizeIndex": st["chains"]["612055"]["nextFinalizeIndex"], "threshold": st["threshold"], "validators": st["roles"]["VALIDATOR_ROLE"], "admins": st["roles"]["ADMIN_ROLE"], "verifier": st["verifier"]["address"], "verifierCodeHash": st["verifier"]["codeHash"], "verifierThresholds": reserve["verifierValueThresholds"], "implementationCodeHash": st["implementationCodeHash"], "proxyCodeHash": st["proxyCodeHash"], "cross": st["cross"]},
         "reserve": {k: reserve[k] for k in ("physicalCrossBaseUnits", "deposited", "pendingAmount", "activePendingSum", "inFlightCount", "spendableReserveBaseUnits", "routeMinimum", "effectiveMaximum")},
         "consensus": {"bsc": bsc["consensus"], "one": one["consensus"]}}
write("G5_CURRENT_ROUTE_SNAPSHOT.json", route)
# SHA-256 manifest of all machine-readable artifacts
names = sorted(f for f in os.listdir(M) if f.endswith(".json") and f != "SHA256_MANIFEST.json")
manifest = {f: hashlib.sha256(open(os.path.join(M, f), "rb").read()).hexdigest() for f in names}
write("SHA256_MANIFEST.json", manifest)
print(json.dumps({"status": status, "blockers": blockers, "gates": {k: v["status"] for k, v in gates.items()}, "spendable": reserve["spendableReserveCROSS"]}, indent=1))
