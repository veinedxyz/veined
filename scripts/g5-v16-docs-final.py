"""V1.6 G5 final documents generated from evidence: reserve reconciliation, G7 controlled pilot plan (only if
G5 PASS) or ONEchain route fallback decision (only if BLOCKED), and the final autonomous-closure summary."""
import json, os, runpy

H = runpy.run_path(os.path.join(os.path.dirname(__file__), "g5-v16-docs.py"), run_name="helpers")
J, write, fmt_units, REL = H["J"], H["write"], H["fmt_units"], H["REL"]


def signed_units(v):
    v = str(v)
    return "-" + fmt_units(v[1:]) if v.startswith("-") else fmt_units(v)


def reserve_doc():
    led = J("reserve/bsc-ledger-reconciliation.json")
    r = J("manifests/reserve-reconciliation.json")
    bis = J(led["physical"]["bisectArtifact"])
    hist = J("reserve/historical-deltas.json")
    pre = J("reserve/prefunding-window.json")
    L, C = led["ledger"], led["checks"]
    lines = [
        "# G5 reserve reconciliation — BSC CROSS for ONEchain → BSC", "",
        f"Result: **{'RECONCILED' if led['RECONCILED'] else 'NOT RECONCILED'}** at BSC block {led['pinnedBlock']} (`{led['pinnedBlockHash']}`). Spendable reserve for a NEW transfer: **{fmt_units(r['spendableReserveBaseUnits'])} CROSS** ({r['spendableReserveBaseUnits']} base units). Evidence: `{REL}/reserve/` (`bsc-ledger-reconciliation.json`, scan manifest, surplus bisection, historical deltas, pre-funding window, in-flight enumeration).", "",
        "## Exact payout semantics (BSCBridgeV2 @ 6da2fb2, byte-proven, fork-tested)", "",
        "- CROSS pair `(612055, CROSS)` is `isOrigin=true`. BSC→ONE `bridgeToken` pulls `value+fee`, forwards `fee` to `dev` in the same call and does `deposited += value`. ONE→BSC finalize pays `CROSS.transfer(to, value)` (100k-gas call) and then `deposited -= value` (checked: a value above `deposited` reverts the whole batch).",
        "- A failed transfer (e.g. insufficient balance) parks the item as pending (`pendingAmount += value`, `deposited` unchanged, index advances); `releasePending` and VERIFIER `manualReleasePendingWithRecipient` later pay and decrement `deposited` exactly once; ADMIN `removePending` drops an obligation without touching `deposited`.",
        "- `burnCrossToDeadWallet` moves CROSS user→dead wallet without touching the bridge balance or `deposited`; ONE then pays native CROSS to the dead wallet (`ONE.minted += value`).",
        f"- BSC verifier value thresholds: verificationAmountThreshold = {r['verifierValueThresholds']['verificationAmountThreshold']}, periodTotalValueThreshold = {r['verifierValueThresholds']['periodTotalValueThreshold']} (disabled: no automatic amount delay). BSC executor = none (no extraData settlement path).",
        "- Therefore, for a NEW transfer queued behind every earlier index: **spendable = min(balanceOf(bridge), deposited) − pendingAmount − Σ in-flight**; the route maximum is additionally bounded by ONE `minted` (initiation requires `minted ≥ value`).", "",
        "## Pinned state", "",
        "| Quantity | Value (CROSS) |", "|---|---|",
        f"| Physical balance of the bridge | {fmt_units(r['physicalCrossBaseUnits'])} |",
        f"| `deposited` | {fmt_units(r['deposited'])} |",
        f"| `pendingAmount` | {fmt_units(r['pendingAmount'])} |",
        f"| Active pending records (complete `allPendingIndex` set) | {len(r['activePendingRecords'])}: " + "; ".join(f"index {p['index']} value {p['value']} status {p['status']}" for p in r["activePendingRecords"]) + f" (sum {r['activePendingSum']}) |",
        f"| In-flight ONE→BSC (initiated, not yet finalized) | {r['inFlightCount']} (enumerated {r['inFlightEnumerated']}, sum {fmt_units(r['inFlightSum'])}) |",
        f"| Surplus (balance − deposited, not spendable) | {fmt_units(r['surplusBaseUnits'])} |",
        f"| **Spendable reserve** | **{fmt_units(r['spendableReserveBaseUnits'])}** |",
        f"| Route minimum / max by reserve / max by contract (ONE minted) / effective max | {fmt_units(r['routeMinimum'])} / {fmt_units(r['routeMaximumByReserve'])} / {fmt_units(r['routeMaximumByContract'])} / {fmt_units(r['effectiveMaximum'])} |", "",
        "Pending index 20 (value 0, status None) is a legacy record written by the first implementation on 2025-05-21 for a zero-value test initiation (the ONE-side index 20 also has value 0; only the network fee was paid). It has no reserve effect.", "",
        "## Event-sourced ledger (proxy creation → pinned block)", "",
        f"- Scan: blocks {led['scan']['start']}–{led['scan']['end']} in {led['scan']['chunks']} hash-pinned 50k-block chunks (contiguous), {led['scan']['proxyLogs']} bridge-proxy logs; CROSS Transfer logs to/from the bridge for the contiguous prefix up to block {led['scan']['transferCoverage']['to']} ({led['scan']['transferLogs']} logs). The only public historical-log endpoint found is quota-limited; the physical balance after the prefix is therefore reconciled by archive-state bisection (below).",
        f"- Initial `deposited` = {fmt_units(L['initialDeposited'])} (initializeBSCBridge crossInitialSupply).",
        f"- Deposits {L['depositCount']} = {fmt_units(L['deposits'])}; payouts {L['payoutCount']} = {fmt_units(L['payouts'])} (released from pending {fmt_units(L['releasedPayouts'])}); dead-wallet burns {L['burnCount']} = {fmt_units(L['burns'])}; fees forwarded {fmt_units(L['feesForwarded'])}; pending created {fmt_units(L['pendingCreated'])} / removed {fmt_units(L['pendingRemoved'])}; manual releases {L['manualReleased']}; executor settlements {L['executorCalls']}; CBU-09 self-payouts {L['selfPayoutCount']}.",
        f"- Computed `deposited` = {fmt_units(L['computedDeposited'])}; computed `pendingAmount` = {fmt_units(L['computedPendingAmount'])}.", "",
        "| Check | Result |", "|---|---|",
    ] + [f"| {k} | {'PASS' if v else 'FAIL'} |" for k, v in C.items()] + [
        "", "## Physical balance", "",
        "- Pre-funding window (archive state): the initializer credited `deposited` = 20,000,000 at block 48753627 without a transfer; the CROSS token owner `0xd68e6d93…` funded 30 + 19,999,970 at blocks 48781968 / 48782186. No payout happened in that window (first finalize at block 49283675). Surplus by block: " + "; ".join(f"{x['block']}: {signed_units(x['surplus'])}" for x in pre["rows"]) + ".",
        f"- Transfer-log prefix balance at block {led['physical']['transferPrefixEnd']} = {fmt_units(led['physical']['prefixBalanceFromLogs'])}; archive `balanceOf` at that block = {fmt_units(led['physical']['archiveBalanceAtPrefixEnd'])} (equal: {C['PREFIX_BALANCE_EQUALS_ARCHIVE']}).",
        f"- Archive-state bisection of s(b) = balance − deposited from block {bis['start']} (post-funding, s = 0) to {bis['end']}: {bis['archiveCalls']} archive calls, monotonic on a {bis['gridPoints']}-point grid; change points: " + ("; ".join(f"block {c['block']} Δ {fmt_units(c['delta'])} ({', '.join(t['tx'] for t in c['txs'])})" for c in bis["changePoints"]) or "none") + f"; the change deltas sum to the total change: {bis['CHANGES_SUM_TO_TOTAL']}. Monotonicity follows from the exact code: bridge CROSS only leaves through payouts (with `deposited −= v`), fee forwards inside deposits, or the executor path (absent on BSC; zero executor events), so no compensating pair can hide between samples.",
        f"- Surplus decomposition: direct inbound transfers without a bridge event {fmt_units(led['surplus']['directInboundSum'])} − unfunded initial credit {fmt_units(led['surplus']['initialUnfundedDeposited'])} + CBU-09 self-payouts ({len(led['surplus']['cbu09SelfPayouts'])}) = **{fmt_units(led['surplus']['explained'])}** = observed surplus {fmt_units(led['surplus']['value'])}. The only post-funding direct inbound is 10 CROSS from EOA `0x9589dd33…` (plain ERC-20 `transfer`, tx `0xa4327d94…`, block 89752453).", "",
        "## Cross-chain reconciliation", "",
        f"- ONE `minted` (block {led['crossChain']['oneBlock']}) − BSC `deposited` = {fmt_units(led['crossChain']['difference'])} = Σ dead-wallet burns {fmt_units(led['crossChain']['burnsToDeadWallets'])} ({led['crossChain']['burnCount']} burns): **{C['CROSS_CHAIN_MINTED_MINUS_DEPOSITED_EQUALS_BURNS']}**. Both initializers credited 20,000,000 and no transfer was in flight at the ledger pins ({json.dumps(led['crossChain']['inFlightAtPins'])}).",
        "- ONE side: bridge native balance + `minted` = 1,000,000,000 exactly (fork-tested; read live).", "",
        "## Historical cross-checks (§31)", "",
        "Archive state before/after each proven payout block: " + "; ".join(f"block {c['block']}: Δdeposited {signed_units(c['observed']['depositedDelta'])}, Δbalance {signed_units(c['observed']['balanceDelta'])}, Δpending {c['observed']['pendingDelta']} — {'MATCH' if c['MATCH'] else 'MISMATCH'}" for c in hist["cases"]) + ".", "",
        "## Caps and privileged paths", "",
        "No per-transfer maximum exists on BSC finalize besides `deposited`/balance; ONE initiation requires `minted ≥ value`; the minimum is read live from the verifier. ADMIN can drop pending obligations, VERIFIER can redirect a pending payout and ADMIN can upgrade instantly (single EOA): these are trust assumptions, monitored by the runtime-drift policy, not modelled away (see G5_LEGACY_RUNTIME_SECURITY_REVIEW.md).",
    ]
    write("G5_RESERVE_RECONCILIATION.md", "\n".join(lines))


def g7_doc(d):
    r = J("manifests/reserve-reconciliation.json"); sim = J("simulations/simulation-final.json"); s = sim["summary"]
    gas = s["estimateGas"]
    lines = [
        "# G7 controlled pilot plan — PREPARED ONLY, NOT EXECUTED", "",
        "**Status: G7 = NOT_RUN — USER_APPROVAL_REQUIRED.** Nothing in this plan has been signed, approved, permitted or broadcast. Production execution remains globally disabled (`GLOBAL_EXECUTION_ENABLED=false`). This plan requires a separate, explicit owner approval and acceptance of the trust model (single admin EOA, 2-of-3 validator EOAs).", "",
        "## Route and pins", "",
        f"- ONEchain 612055 proxy `{d['source']['proxy']}` → implementation `{d['source']['implementation']}` (runtime keccak `{d['source']['runtimeHash']}`, exact build `{d['source']['buildCommit']}`).",
        f"- BSC 56 proxy `{d['destination']['proxy']}` → implementation `{d['destination']['implementation']}` (runtime keccak `{d['destination']['runtimeHash']}`, exact build `{d['destination']['buildCommit']}`); canonical token CROSS `0x6bf62ca91e397B5A7d1D6bCe97D9092065d7A510`.",
        "- Verifier (both chains, identical runtime `0x4d8c535d…`), validator set (3 EOAs, threshold 2), admin and VERIFIER_ROLE sets are pinned in `src/g5/route-pins.ts`; any change → `REVIEW_REQUIRED` → abort.", "",
        "## Smallest safe amount and exposure", "",
        f"- Amount: the live minimum **{fmt_units(s['minimum'])} ONE** (one transfer only). Network fee {fmt_units(s['networkFee'])} ONE, service fee {fmt_units(s['serviceFee'])} ONE → exact `msg.value` **{fmt_units(s['exactMsgValue'])} ONE** (the live code requires exact equality).",
        f"- Gas: estimate {gas} at the final pin; budget with the existing 20 % margin at the then-current gas price.",
        f"- Maximum financial exposure: {fmt_units(s['exactMsgValue'])} ONE + gas. No approval, permit or allowance is ever created (native route).",
        f"- Reserve at the evidence pin: spendable {fmt_units(r['spendableReserveBaseUnits'])} CROSS (block {r['pinnedBlock']}); the pilot amount is {int(s['minimum']) / max(1, int(r['spendableReserveBaseUnits'])):.2e} of it.", "",
        "## Preflight (all must hold immediately before any signature; otherwise abort)", "",
        "1. Owner approval for G7 recorded; external security review status acknowledged (NOT_RUN at V1.6).",
        "2. Fresh pins on both chains equal the G5 pins (implementations, runtime/proxy/verifier/token code hashes, validator set, threshold, admin, VERIFIER_ROLE) — `evaluateRouteDrift` = `VERIFIED_READ_ONLY`.",
        "3. No pause: global, chain, pair initiate/finalize pause all false; `maxExtraDataLength` unchanged; extraData = `0x`.",
        "4. Reserve: `deriveSpendableReserve` verified=true at a fresh pinned block with complete pending set and in-flight enumeration; spendable ≥ amount.",
        "5. Fresh quote ≤ 60 s old: minimum/fee re-read from the verifier at the pinned block; `eth_call` returns true and `eth_estimateGas` succeeds for the exact calldata and value from the funded EOA; recipient = sender EOA (empty code on both chains, never a bridge/token contract).",
        "6. Funded EOA balance ≥ exact value + gas budget; wallet chain = 612055; transaction preview shows `to` = ONE proxy, `value` = exact value, selector `bridgeToken`.", "",
        "## Abort conditions", "",
        "Any preflight failure; any drift reason; quote older than 60 s; fee or minimum change between quote and signing; RPC disagreement between the two official ONE endpoints; BSC finalize paused; pending queue non-empty with value > 0 for CROSS; validator/threshold change; implementation upgrade announcement.", "",
        "## Post-send tracking", "",
        "1. Source: receipt on ONE (status 1), `BridgeInitiated(toChainID=56, index=i, to=sender, value=amount)` from the proxy; record index i.",
        "2. Destination: watch BSC for `BridgeFinalized(fromChainID=612055, index=i)` preceded by `CROSS Transfer(bridge → sender, amount)`; `nextFinalizeIndex(612055)` passes i; block ≤ `finalized` tag.",
        "3. Produce a payout proof with `scripts/g5-v16-payout-proof.mjs` (header hash + receipt-trie proof + validator signatures) and attach it to the pilot record.", "",
        "## Recovery plan", "",
        "- If BSC records `BridgePending` (e.g. TransferFailed/TokenPaused): the record is visible via `getPendingArguments(612055, i)`; `releasePending` is permissionless once the reason clears; otherwise only the operator's VERIFIER/ADMIN roles can act (manual release / removal) — escalate to the operator with the proof.",
        "- If the source tx reverts: only gas is lost (exact-value requirement or fee change); re-quote, do not resend blindly.",
        "- If the destination never finalizes within the observed historical window: keep the record in `SETTLEMENT_PENDING`, re-check validator/threshold/pauses, escalate to the operator; never retry the source transfer.",
    ]
    write("G7_CONTROLLED_PILOT_PLAN.md", "\n".join(lines))


def fallback_doc(d):
    lines = [
        "# ONEchain route fallback decision (G5 BLOCKED)", "",
        "G5 remains **BLOCKED**. Exact unresolved gates: " + ", ".join(f"`{b}`" for b in d["remainingBlockers"]) + ".", "",
        "| Option | Assessment |", "|---|---|",
        "| A. Keep ONEchain read-only / unavailable for execution | Recommended until every gate passes: no unverified contract risk; the read-only observer, simulation and tracking stay available. |",
        "| B. Use the existing ONEbridge only after external evidence/audit | Still blocked on the gates above. |",
        "| C. Build a proprietary bridge | Conflicts with the no-custody/no-proprietary-liquidity strategy; needs contracts, validators, audits and capital. Not recommended. |",
        "| D. Another third-party ONEchain route | None found that is real, liquid, reputable and independently verifiable. |", "",
        "No option is enabled automatically.",
    ]
    write("ONECHAIN_ROUTE_FALLBACK_DECISION.md", "\n".join(lines))


def closure_doc(d):
    g = d["gates"]
    lines = [
        f"# G5 final autonomous closure — {'G5 AUTONOMOUSLY VERIFIED' if d['status'] == 'PASS' else 'G5 REMAINS BLOCKED'}", "",
        f"Decision: **G5 = {d['status']}** (observed {d['observedAt']}). Machine-readable: `{REL}/manifests/G5_DECISION.json`. Every gate below is computed by `scripts/g5-v16-decision.py` from evidence booleans only.", "",
        "| Gate | Status | Key evidence |", "|---|---|---|",
    ] + [f"| {k} | {v['status']} | {json.dumps(v['detail'], ensure_ascii=False)[:260]} |" for k, v in g.items()] + [
        "", "## What was produced without operator e-mail", "",
        "- Exact deployment builds of both live implementations reproduced byte-for-byte (full runtime after legitimate UUPS `__self` immutable substitution, initcode equal to the on-chain creation input, metadata CID equal) with official native and wasm solc 0.8.28, from the official Git history: ONE `b3b0258` (v1.0.3) `CrossBridge`, BSC `6da2fb2` `BSCBridgeV2`; additionally BridgeVerifier (`23a66d7`) and the CROSS token (to-nexus/cross-token, OZ 5.1.0, solc 0.8.22).",
        "- Complete EIP-1967 histories of both proxies; implementation active at every proof block.",
        "- Event-sourced BSC reserve ledger reconciled exactly at the pinned block, physical balance classified (pre-funding window, one 10 CROSS direct transfer), cross-chain identity ONE minted − BSC deposited = Σ dead-wallet burns.",
        "- Three canonical payout proofs (indices 98483, 98728, 98727) with recomputed block-header hashes (incl. ONEchain Istanbul hashing), receipt-trie Merkle proofs against `receiptsRoot`, recovered validator signatures, and archive-verified implementation at the destination block. Old pruned candidate 92555 was not needed: public ONE nodes prune the tx-hash index but still serve `eth_getBlockReceipts`.",
        "- Fresh positive read-only simulation and six negative controls at the final pin; runtime-drift recheck between the evidence pins and the final pins.", "",
        "## Self-review (§93)", "",
        "1. A Git comment was not treated as equivalence: the frozen legacy file was shown to differ today; equivalence rests on byte equality of the original tree.",
        "2. Metadata-stripped/prefix equality is never used for acceptance; full runtime + initcode + CID equality is.",
        "3. Implementations were verified at each historical proof block (archive state on BSC, complete Upgraded history on ONE).",
        "4. Reserve uses the exact semantics with pending and in-flight obligations, not the token balance.",
        "5. All pending indices were enumerated (`allPendingIndex`, complete set; legacy index 20 value 0).",
        "6. Fees (forwarded to dev in-call) and the initial supply (unfunded credit later funded by the token owner) explain every balance delta; one direct 10 CROSS transfer is classified.",
        "7. Source and destination index, recipient, principal and token are identical in each proof; source-destination are not same-value coincidences (index binding + validator-signed args).",
        "8. Receipts are bound to canonical headers by recomputed hashes; BSC blocks are below the `finalized` tag on two operators; ONE blocks agree on two official endpoints and the official explorer index (same organisation — labelled).",
        "9. Explorer data is labelled OFFICIAL_EXPLORER_INDEX / THIRD_PARTY and never substituted for RPC where RPC was available.",
        "10. No current-implementation assumption for old payouts: each proof checks the implementation at its block.",
        "11. The positive simulation is from the final pin; no state override; no signing.",
        "12. Real transactions: 0 signatures, 0 approvals, 0 permits, 0 broadcasts, 0 deploys, 0 fee collection.",
        "13. The route gate was strengthened (settlement-trust pins, verifier/token code pins, in-flight obligations), never weakened.", "",
        "## Unchanged external statuses", "",
        "INDEPENDENT_EXTERNAL_SOURCE_REVIEW = NOT_RUN · WEB_API_PENTEST_EXTERNAL = NOT_RUN · TRANSACTION_FIREWALL_EXTERNAL_REVIEW = NOT_RUN · LEGAL_REVIEW = NOT_RUN · OWNER_RELEASE_APPROVAL = NOT_RUN · G7 = NOT_RUN — USER_APPROVAL_REQUIRED · Production execution = DISABLED.", "",
        f"Route risk (not a G5 evidence gate, disclosed): {d['routeRisk']}",
    ]
    write("G5_FINAL_AUTONOMOUS_CLOSURE.md", "\n".join(lines))


if __name__ == "__main__":
    d = J("manifests/G5_DECISION.json")
    reserve_doc()
    if d["status"] == "PASS":
        g7_doc(d)
    else:
        fallback_doc(d)
    closure_doc(d)
