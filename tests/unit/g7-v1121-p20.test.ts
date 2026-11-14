import { afterAll, describe, expect, it, vi } from "vitest";
import {
  ExecutionEvidence,
  EXECUTION_COUNTERS,
  noWriteReasons,
} from "../../src/g7/write-evidence";
import { ReadOnlyRpc } from "../../src/g7/rpc";
import { ENDPOINTS, BSC_STATE_SOURCES } from "../../src/g7/policy";
import {
  fixturePreflight as source,
  fixtureTracker,
  type FixtureScenario,
} from "../../scripts/g7-pilot/fixture";
import { failedOutcome } from "../../scripts/g7-pilot/preflight";
import { PilotSession, fileLockStore } from "../../scripts/g7-pilot/session";
import { tmpdir } from "node:os";
import {
  parseLaunchArgs,
  createPilotRuntime,
} from "../../scripts/g7-pilot/launch";
import {
  scanG7Sources,
  type CandidateBaseline,
} from "../../scripts/g7-safety-scan";
import { candidateSelection as configuredCandidate } from "../fixtures/g7-candidate";
import {
  CONFIRMATION_PHRASE,
  PILOT_SCOPE,
} from "../../scripts/g7-pilot/policy";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
let ownedCandidate: CandidateBaseline | undefined;
let ownedDirectory: string | undefined;
const candidateRoot = resolve("evidence/otherbridge-v1-12-1");
function candidateSelection(): CandidateBaseline {
  const configured = configuredCandidate();
  if (configured) return configured;
  if (!ownedCandidate) {
    const acceptedPath = readFileSync(
      ".otherbridge/g7-protected-baseline.txt",
      "utf8",
    ).trim();
    const files = new Set([
      ...Object.keys(JSON.parse(readFileSync(acceptedPath, "utf8"))),
      "src/g7/witness-pool.ts",
      "src/g7/witness-logs.ts",
      "src/g7/in-flight-reserve.ts",
      "src/data/store/g7-cache.ts",
      "scripts/v112-g7-diagnostics.ts",
      "scripts/v112-seed-checkpoint.ts",
      "src/g7/write-evidence.ts",
      "src/features/wallet/adapter.ts",
    ]);
    mkdirSync(candidateRoot, { recursive: true });
    ownedDirectory = mkdtempSync(join(candidateRoot, "v1121-unit-candidate-"));
    mkdirSync(join(ownedDirectory, "protected"));
    const contents = JSON.stringify(
      Object.fromEntries(
        [...files]
          .sort()
          .map((p) => [
            p,
            createHash("sha256").update(readFileSync(p)).digest("hex"),
          ]),
      ),
    );
    const path = join(ownedDirectory, "protected", "candidate.json");
    writeFileSync(path, contents);
    ownedCandidate = {
      path: path
        .replaceAll("\\", "/")
        .slice(process.cwd().replaceAll("\\", "/").length + 1),
      sha256: createHash("sha256").update(contents).digest("hex"),
      scope: "fixture-validation",
    };
  }
  return ownedCandidate;
}
function fixturePreflight(
  scenario: FixtureScenario,
  clock: () => number = Date.now,
) {
  return source(scenario, clock, { candidateBaseline: candidateSelection() });
}
afterAll(() => {
  if (!ownedDirectory) return;
  const target = resolve(ownedDirectory);
  if (
    !target.startsWith(candidateRoot + "\\") &&
    !target.startsWith(candidateRoot + "/")
  )
    throw Error("BAD_CLEANUP_PATH");
  rmSync(target, { recursive: true, force: true });
});
const gate = (
  o: Awaited<ReturnType<ReturnType<typeof source>["run"]>>,
  id: string,
) => o.gates.find((g) => g.id === id)!;
const wallet = {
  account: PILOT_SCOPE.account,
  chainId: PILOT_SCOPE.sourceChainIdHex,
};
const confirmations = { scope: true, trust: true, phrase: CONFIRMATION_PHRASE };
const session = (p = fixturePreflight("ready")) =>
  new PilotSession({
    mode: "dry-run",
    fixture: true,
    preflight: p,
    tracker: fixtureTracker("ready"),
    lock: null,
    journal: () => {},
  });

describe("V1.12.1 execution truth separated from release integrity", () => {
  it("real fixture arm is capability only; abort before dispatch keeps issuance zero", async () => {
    const d = mkdtempSync(join(tmpdir(), "v1121-arm-"));
    const s = new PilotSession({
      mode: "real",
      fixture: true,
      preflight: fixturePreflight("ready"),
      tracker: fixtureTracker("ready"),
      lock: fileLockStore(join(d, "lock.json")),
      journal: () => {},
    });
    try {
      await s.start();
      const digest = s.latest!.review!.intentDigest;
      const f = await s.final({ intentDigest: digest, confirmations, wallet });
      const a = s.arm({
        candidateId: (f as { candidateId: string }).candidateId,
        intentDigest: digest,
        wallet,
      });
      expect(a.state).toBe("ARMED");
      expect(s.snapshot().counters.walletRequestsIssued).toBe(0);
      expect(s.snapshot().counters.walletRequestAttempts).toBe(0);
      expect(gate(s.latest!, "P20").status).toBe("PASS");
      s.walletOutcome({
        armId: (a as { armId: string }).armId,
        outcome: "ABORTED_BEFORE_WALLET_REQUEST",
      });
      expect(s.snapshot().counters.walletRequestsIssued).toBe(0);
    } finally {
      s.stop();
      const abs = resolve(d),
        base = resolve(tmpdir());
      if (!abs.startsWith(base + "\\") && !abs.startsWith(base + "/"))
        throw Error("BAD_CLEANUP_PATH");
      rmSync(d, { recursive: true, force: true });
    }
  });
  it("rate-limit recovery and alternate read source leave P20 PASS", async () => {
    let at = Date.now() + 1_000_000;
    const execution = new ExecutionEvidence();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { code: -32005, message: "quota exhausted" },
          }),
          { status: 429, headers: { "retry-after": "1" } },
        ),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ result: "0x38" }), { status: 200 }),
      );
    const rpc = new ReadOnlyRpc({ execution, fetchImpl, now: () => at });
    await expect(
      rpc.call(ENDPOINTS.bscLogs[0], "eth_chainId", []),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await rpc.raw(BSC_STATE_SOURCES[2].url, "eth_chainId", []);
    at += 120_000;
    await rpc.raw(ENDPOINTS.bscLogs[0], "eth_chainId", []);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const o = await source("ready", Date.now, {
      candidateBaseline: candidateSelection(),
      execution,
    }).run("initial");
    expect(gate(o, "P20").status).toBe("PASS");
    expect(o.status).toBe("READY");
  });
  it("persistent counters restore monotonically and reject corrupted evidence", () => {
    const a = new ExecutionEvidence();
    a.record("permits");
    const b = new ExecutionEvidence();
    b.restore(a.snapshot());
    b.restore(new ExecutionEvidence().snapshot());
    expect(b.snapshot().permits).toBe(1);
    expect(() => b.restore({} as never)).toThrow(
      "INVALID_PERSISTED_EXECUTION_EVIDENCE",
    );
  });
  it.each(["initial", "refresh", "final"] as const)(
    "prepared unsigned %s preflight passes P20 and all release controls",
    async (kind) => {
      const o = await fixturePreflight("ready").run(kind);
      expect(gate(o, "P20").status).toBe("PASS");
      expect(gate(o, "R1").status).toBe("PASS");
      expect(o.status).toBe("READY");
      expect(o.review!.intentDigest).toBe(
        "4eecb9784961717f8464be8f9a650004974e328239f614211ad51bdf65aac869",
      );
    },
  );
  it("an explicit baseline mismatch blocks release but P20 truth remains PASS", async () => {
    const mismatch = { ...candidateSelection(), sha256: "0".repeat(64) };
    const o = await source("ready", Date.now, {
      candidateBaseline: mismatch,
    }).run("initial");
    expect(gate(o, "P20")).toMatchObject({ status: "PASS", reasons: [] });
    expect(gate(o, "R1").reasons).toContain("PROTECTED_BASELINE_MISMATCH");
    expect(o.status).toBe("BLOCKED");
    expect(scanG7Sources(mismatch).pass).toBe(false);
    expect(
      scanG7Sources(mismatch).findings.some(
        (f) => f.rule === "candidate-baseline-invalid",
      ),
    ).toBe(true);
  });
  it.each(EXECUTION_COUNTERS)(
    "authoritative %s attempt fails P20 without provider dispatch",
    async (kind) => {
      const execution = new ExecutionEvidence();
      execution.record(kind);
      const o = await source("ready", Date.now, {
        candidateBaseline: candidateSelection(),
        execution,
      }).run("initial");
      expect(gate(o, "P20").status).toBe("FAIL");
      expect(gate(o, "P20").reasons.some((r) => r.includes(kind))).toBe(true);
      expect(o.status).toBe("BLOCKED");
      const s = session(
        source("ready", Date.now, {
          candidateBaseline: candidateSelection(),
          execution,
        }),
      );
      expect(s.snapshot().counters[kind]).toBe(1);
      s.stop();
    },
  );
  it.each([
    "eth_sendTransaction",
    "personal_sign",
    "eth_signTypedData_v4",
    "eth_sendRawTransaction",
    "wallet_sendCalls",
    "wallet_grantPermissions",
  ])(
    "transport rejects injected %s and records attempt before I/O",
    async (method) => {
      const fetchImpl = vi.fn();
      const execution = new ExecutionEvidence();
      const rpc = new ReadOnlyRpc({ execution, fetchImpl });
      await expect(rpc.raw(ENDPOINTS.one[0], method, [])).rejects.toMatchObject(
        { code: "METHOD_NOT_ALLOWED" },
      );
      expect(fetchImpl).not.toHaveBeenCalled();
      const o = await source("ready", Date.now, {
        candidateBaseline: candidateSelection(),
        execution,
      }).run("initial");
      expect(gate(o, "P20").status).toBe("FAIL");
      expect(execution.snapshot().prohibitedRpcAttempts).toBe(1);
    },
  );
  it("a read override remains a separate release block, with no write executed", async () => {
    const execution = new ExecutionEvidence();
    const rpc = new ReadOnlyRpc({ execution, fetchImpl: vi.fn() });
    await expect(
      rpc.raw(ENDPOINTS.one[0], "eth_call", [{}, "latest", {}]),
    ).rejects.toMatchObject({ code: "STATE_OVERRIDE_OR_BAD_ARITY" });
    const o = await source("ready", Date.now, {
      candidateBaseline: candidateSelection(),
      execution,
    }).run("initial");
    expect(gate(o, "P20").status).toBe("PASS");
    expect(gate(o, "R1").reasons).toContain("STATE_OVERRIDE_USED");
    expect(o.status).toBe("BLOCKED");
  });
  it("incomplete, negative or noninteger execution evidence never passes", () => {
    for (const e of [
      {},
      { walletRequestsIssued: -1 },
      { walletRequestsIssued: NaN },
    ])
      expect(noWriteReasons(e as never).length).toBeGreaterThan(0);
    const execution = new ExecutionEvidence();
    const old = execution.snapshot();
    execution.record("permits");
    expect(old.permits).toBe(0);
    expect(execution.snapshot().permits).toBe(1);
    expect(Object.isFrozen(old)).toBe(true);
  });
  it("RPC outage blocks X0 while authoritative zero writes leave P20 PASS", () => {
    const o = failedOutcome(
      "initial",
      Date.now(),
      new Error("WITNESS_UNAVAILABLE"),
      new ExecutionEvidence().snapshot(),
    );
    expect(o.status).toBe("BLOCKED");
    expect(gate(o, "X0").status).toBe("FAIL");
    expect(gate(o, "P20").status).toBe("PASS");
  });
  it("stale quote has its own gate; fresh refresh leaves P20 PASS", async () => {
    const p = fixturePreflight("final-stale");
    const stale = await p.run("final"),
      fresh = await p.run("refresh");
    expect(gate(stale, "P19").status).toBe("FAIL");
    expect(gate(stale, "P20").status).toBe("PASS");
    expect(gate(fresh, "P20").status).toBe("PASS");
    expect(fresh.status).toBe("READY");
  });
  it.each([
    { ...wallet, chainId: "0x1" },
    { ...wallet, account: "0x1111111111111111111111111111111111111111" },
  ])("wallet/chain binding refusal never becomes a write", async (identity) => {
    const s = session();
    await s.start();
    await expect(
      s.final({
        intentDigest: s.latest!.review!.intentDigest,
        confirmations,
        wallet: identity,
      }),
    ).rejects.toThrow(/WALLET_/);
    expect(s.snapshot().counters.walletRequestsIssued).toBe(0);
    expect(gate(s.latest!, "P20").status).toBe("PASS");
    s.stop();
  });
  it("dry suppressed arm completes with every execution counter zero", async () => {
    const s = session();
    await s.start();
    const digest = s.latest!.review!.intentDigest;
    const f = await s.final({ intentDigest: digest, confirmations, wallet });
    const a = s.arm({
      candidateId: (f as { candidateId: string }).candidateId,
      intentDigest: digest,
      wallet,
    });
    expect(a.state).toBe("DRY_RUN_COMPLETE");
    expect(noWriteReasons(s.snapshot().counters)).toEqual([]);
    expect(gate(s.latest!, "P20").status).toBe("PASS");
    s.stop();
  });
  it("dry wallet-attempt injection fails P20 and never issues a request", async () => {
    const s = session();
    await s.start();
    expect(() => s.walletAttempt("arm-0000000000000000")).toThrow(
      "DRY_WALLET_ATTEMPT_FORBIDDEN",
    );
    expect(gate(s.latest!, "P20").status).toBe("FAIL");
    expect(s.snapshot().counters.walletRequestAttempts).toBe(1);
    expect(s.snapshot().counters.walletRequestsIssued).toBe(0);
    s.stop();
  });
  it("candidate selection cannot authorize live real mode in parser or runtime", () => {
    const c = candidateSelection()!;
    expect(c).toBeDefined();
    expect(() =>
      parseLaunchArgs(
        [
          "--real",
          "--candidate-baseline",
          c.path,
          "--candidate-sha256",
          c.sha256,
        ],
        { real: "--real", dryRun: "--dry-run", defaultMode: "dry-run" },
      ),
    ).toThrow("CANDIDATE_BASELINE_CANNOT_AUTHORIZE_REAL_MODE");
    expect(() =>
      createPilotRuntime({
        mode: "real",
        fixture: undefined,
        stateDir: undefined,
        evidenceFamily: "forbidden",
        candidateBaseline: c,
      }),
    ).toThrow("CANDIDATE_BASELINE_CANNOT_AUTHORIZE_REAL_MODE");
    expect(
      () =>
        new PilotSession({
          mode: "real",
          fixture: false,
          preflight: fixturePreflight("ready"),
          tracker: fixtureTracker("ready"),
          lock: null,
          journal: () => {},
        }),
    ).toThrow("REAL_MODE_REQUIRES_ACCEPTED_BASELINE_SOURCE");
  });
  it("candidate SHA mutation is rejected without changing accepted selection", () => {
    const c = candidateSelection()!;
    const r = scanG7Sources({ ...c, sha256: "0".repeat(64) });
    expect(r.pass).toBe(false);
    expect(
      r.findings.some((f) => f.rule === "candidate-baseline-invalid"),
    ).toBe(true);
    expect(scanG7Sources().baselineScope).toBe("accepted");
  });
  it("a candidate cannot remove an accepted protected file", () => {
    const c = candidateSelection()!;
    const base = resolve("evidence/otherbridge-v1-12-1");
    const d = mkdtempSync(join(base, "v1121-adversarial-"));
    const p = join(d, "protected");
    // Existing protected folder is created explicitly; this test only owns the uniquely named path.
    const h = JSON.parse(readFileSync(c.path, "utf8"));
    delete h[Object.keys(h)[0]];
    const text = JSON.stringify(h);
    const rel =
      d
        .replaceAll("\\", "/")
        .slice(process.cwd().replaceAll("\\", "/").length + 1) +
      "/protected/candidate.json";
    mkdirSync(p);
    writeFileSync(join(p, "candidate.json"), text);
    try {
      expect(
        scanG7Sources({
          ...c,
          path: rel,
          sha256: createHash("sha256").update(text).digest("hex"),
        }).findings.some((f) => f.rule === "candidate-baseline-invalid"),
      ).toBe(true);
    } finally {
      if (
        !resolve(d).startsWith(base + "\\") &&
        !resolve(d).startsWith(base + "/")
      )
        throw Error("BAD_CLEANUP_PATH");
      rmSync(d, { recursive: true, force: true });
    }
  });
});
