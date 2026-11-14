// G14 CLOSURE — integration tests of the DELIVERED build exactly as it is (disarmed: no owner record, wiring false).
// SYNTHETIC_TEST_ONLY: no wallet, no key, no network. The positive end-to-end flow on the real composition runs in the
// separate positive test-only variant (tests/fixtures/g14-closure/positive*.test.ts, see TEST_MATRIX_TR.md); here the
// delivered build must refuse every signing-path action, return nothing signable, read nothing and store nothing.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../../src/app/api/execution/route";
import { setAppLimiterForTests } from "../../src/server/api-guard";
import { MemoryRateLimiter } from "../../src/server/rate-limit";
import { DEFAULT_CANARY_STORE_DIR } from "../../src/execution/server/canary/runtime";
import { CanaryDurableStore } from "../../src/execution/server/canary/durable-store";
import { OWNER_CANARY_APPROVAL } from "../../src/security/canary-approval";
import { CANARY_LIVE_WIRING } from "../../src/execution/server/gate";

const ORIGIN = "http://127.0.0.1:3100";
const SYN = "0x3333333333333333333333333333333333333333";
const call = async (body: unknown, headers: Record<string, string> = {}) => {
  const res = await POST(
    new NextRequest(`${ORIGIN}/api/execution`, {
      method: "POST",
      headers: {
        host: "127.0.0.1:3100",
        origin: ORIGIN,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: await res.json() };
};
let fetches = 0;
beforeEach(() => {
  setAppLimiterForTests(new MemoryRateLimiter());
  fetches = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      fetches++;
      throw new Error("NO_NETWORK_IN_THIS_SUITE");
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  setAppLimiterForTests(undefined);
});
const H32 = "a".repeat(32),
  H64 = "c".repeat(64),
  RECORD = "canary-closure-0001";
const bodies: Record<string, Record<string, unknown>> = {
  "canary-authorize": { session: H64, record: RECORD, trustedGesture: true },
  "canary-prepare": { session: H64, record: RECORD, token: {} },
  "canary-confirm": {
    session: H64,
    record: RECORD,
    step: "SEND",
    review: H64,
    attempt: H32,
    digest: H64,
  },
  "canary-record": {
    session: H64,
    kind: "requested",
    ref: {
      record: RECORD,
      action: "SEND",
      attempt: H32,
      digest: H64,
      request: H32,
    },
  },
  "canary-track": { session: H64, record: RECORD },
};

describe("the delivered build: canary implementation present, activation disabled, owner record absent", () => {
  it("states the truth: PRESENT / DISABLED / ABSENT, CLOSED gate, no amount", async () => {
    expect(OWNER_CANARY_APPROVAL).toBeNull();
    expect(CANARY_LIVE_WIRING).toBe(false);
    const r = await call({ action: "canary-status" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      amount: null,
      implementation: "PRESENT",
      activation: "DISABLED",
      ownerRecord: "ABSENT",
      wiring: false,
      gate: { state: "CLOSED" },
    });
    expect(r.json.gate.reasons).toEqual(
      expect.arrayContaining(["NO_OWNER_APPROVED_CANARY", "CANARY_NOT_WIRED"]),
    );
  });
  it("a canary review is read-only and answers CLOSED without reading a chain, a quote or a store", async () => {
    const r = await call({
      action: "canary-review",
      account: SYN,
      chainId: "8453",
      amount: "5000000",
    });
    expect(r.status).toBe(200);
    expect(r.json.review).toBeNull();
    expect(r.json.activation).toBe("DISABLED");
    expect(fetches).toBe(0);
    expect(existsSync(DEFAULT_CANARY_STORE_DIR())).toBe(false);
  });
  it("review 2 N9: a canary resume (with or without a key) is read-only and answers CLOSED without the runtime or a store", async () => {
    for (const body of [
      { action: "canary-resume", account: SYN, amount: "5000000" },
      {
        action: "canary-resume",
        account: SYN,
        amount: "5000000",
        record: RECORD,
        resumeKey: H64,
      },
    ]) {
      const r = await call(body);
      expect(r.status).toBe(200);
      expect(r.json.resume).toBeNull();
      expect(r.json.activation).toBe("DISABLED");
      expect(JSON.stringify(r.json)).not.toMatch(
        /session|inspection|"data":"0x/,
      );
    }
    expect(fetches).toBe(0);
    expect(existsSync(DEFAULT_CANARY_STORE_DIR())).toBe(false);
  });
  it("every signing-path canary action is 403 WRITE_DISABLED before the runtime: nothing signable, nothing read, nothing stored", async () => {
    for (const [action, body] of Object.entries(bodies)) {
      const r = await call({ action, ...body });
      expect(r.status, action).toBe(403);
      expect(r.json.error, action).toBe("WRITE_DISABLED");
      expect(JSON.stringify(r.json), action).not.toMatch(
        /transaction|"data":"0x|calldata|"token"|nonce|preparation|digest/i,
      );
    }
    // The accepted write actions are refused exactly as before.
    for (const action of ["authorize", "prepare", "send", "approve", "sign"]) {
      const r = await call({ action });
      expect(r.status, action).toBe(403);
      expect(r.json.error).toBe("WRITE_DISABLED");
    }
    expect(fetches).toBe(0);
    expect(existsSync(DEFAULT_CANARY_STORE_DIR())).toBe(false);
  });
  it("strict schemas: malformed canary requests are INVALID_REQUEST, never a write", async () => {
    for (const body of [
      { action: "canary-authorize", ...bodies["canary-authorize"], extra: 1 },
      { action: "canary-review", account: "0x1", chainId: "8453", amount: "5" },
      {
        action: "canary-review",
        account: SYN,
        chainId: "8453",
        amount: "5000000",
        ready: true,
      },
      { action: "canary-record", ...bodies["canary-record"], kind: "delete" },
      { action: "canary-confirm", ...bodies["canary-confirm"], attempt: "x" },
    ]) {
      const r = await call(body);
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(r.json.error).toBe("INVALID_REQUEST");
    }
  });
  it("origin and content type are checked before the body; a foreign origin never reaches a canary action", async () => {
    const r = await call(
      { action: "canary-status" },
      { origin: "https://evil.example" },
    );
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("ORIGIN_REJECTED");
    const res = await POST(
      new NextRequest(`${ORIGIN}/api/execution`, {
        method: "POST",
        headers: {
          host: "127.0.0.1:3100",
          origin: ORIGIN,
          "content-type": "text/plain",
        },
        body: JSON.stringify({ action: "canary-status" }),
      }),
    );
    expect(res.status).toBe(422);
  });
  it("the canary actions have their own rate scope; the review's 5-per-minute allowance is unchanged", async () => {
    setAppLimiterForTests(new MemoryRateLimiter());
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const res = await POST(
        new NextRequest(`${ORIGIN}/api/execution`, {
          method: "POST",
          headers: {
            host: "127.0.0.1:3100",
            origin: ORIGIN,
            "content-type": "application/json",
          },
          body: JSON.stringify({ action: "canary-status" }),
        }),
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
    setAppLimiterForTests(new MemoryRateLimiter());
    const gate: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await POST(
        new NextRequest(`${ORIGIN}/api/execution`, {
          method: "POST",
          headers: {
            host: "127.0.0.1:3100",
            origin: ORIGIN,
            "content-type": "application/json",
          },
          body: JSON.stringify({ action: "gate" }),
        }),
      );
      gate.push(res.status);
    }
    expect(gate).toEqual([200, 200, 200, 200, 200, 429]);
  });
});

// The durable store does not depend on arming: its OS-level writer lock is proven with two REAL processes here too.
const STORE = join(
  process.cwd(),
  "src/execution/server/canary/durable-store.ts",
);
function holder(dir: string): Promise<string> {
  const script = `
    const { CanaryDurableStore } = await import(${JSON.stringify("file:///" + STORE.replaceAll("\\", "/"))});
    try { const s = CanaryDurableStore.open(${JSON.stringify(dir)}); s.append("USE", { line: String(process.pid) });
      console.log("HOLD_OK"); await new Promise((r) => setTimeout(r, 3000)); s.close(); }
    catch (e) { console.log(e.code ?? String(e)); }`;
  return new Promise((resolve) => {
    const c = spawn(
      process.execPath,
      [
        "--experimental-transform-types",
        "--disable-warning=ExperimentalWarning",
        "--import",
        "./scripts/ts-hooks.mjs",
        "--input-type=module",
        "-e",
        script,
      ],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    c.stdout.on("data", (b) => (out += b));
    c.stderr.on("data", (b) => (out += b));
    c.on("exit", () => resolve(out));
  });
}
describe("durable store across real processes", () => {
  it(
    "two processes race for one store directory: exactly one writer; the other is refused by the OS lock",
    { timeout: 60_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "g14-closure-race-"));
      try {
        const outs = await Promise.all([holder(dir), holder(dir)]);
        expect(
          outs.filter((o) => o.includes("HOLD_OK")),
          outs.join("|"),
        ).toHaveLength(1);
        expect(
          outs.filter((o) => o.includes("STORE_LOCKED")),
          outs.join("|"),
        ).toHaveLength(1);
        const s = CanaryDurableStore.inspect(dir);
        expect(s.status).toBe("READY");
        expect(s.entries.filter((e) => e.type === "USE")).toHaveLength(1);
        expect(readdirSync(dir).sort()).toEqual(["journal.ndjson"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
  it(
    "a process killed in the middle of its work leaves a lock that the next open takes over (and journals)",
    { timeout: 60_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "g14-closure-kill-"));
      try {
        const script = `
        const { CanaryDurableStore } = await import(${JSON.stringify("file:///" + STORE.replaceAll("\\", "/"))});
        const s = CanaryDurableStore.open(${JSON.stringify(dir)}); s.append("USE", { line: "before-kill" });
        process.kill(process.pid, "SIGKILL");`;
        await new Promise((resolve) => {
          const c = spawn(
            process.execPath,
            [
              "--experimental-transform-types",
              "--disable-warning=ExperimentalWarning",
              "--import",
              "./scripts/ts-hooks.mjs",
              "--input-type=module",
              "-e",
              script,
            ],
            { cwd: process.cwd(), stdio: "ignore" },
          );
          c.on("exit", resolve);
        });
        expect(existsSync(CanaryDurableStore.lockPath(dir))).toBe(true);
        const s = CanaryDurableStore.open(dir);
        expect(s.status).toBe("READY");
        expect(
          s.of("USE").map((e) => (e.data as { line: string }).line),
        ).toEqual(["before-kill"]);
        expect(
          (s.of("OPEN").at(-1)!.data as { takeoverOf: number | null })
            .takeoverOf,
        ).not.toBeNull();
        s.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("durable store: stale-lock take-over across real processes (review 1 F2)", () => {
  it(
    "two processes race to take over one DEAD writer's lock: exactly one becomes the writer",
    { timeout: 60_000 },
    async () => {
      for (let round = 0; round < 3; round++) {
        const dir = mkdtempSync(join(tmpdir(), "g14-closure-stale-"));
        try {
          CanaryDurableStore.open(dir).close();
          // A lock left by a process that no longer exists.
          writeFileSync(
            CanaryDurableStore.lockPath(dir),
            JSON.stringify({ pid: 999_999_999, token: "f".repeat(32), at: 1 }),
          );
          const outs = await Promise.all([holder(dir), holder(dir)]);
          expect(
            outs.filter((o) => o.includes("HOLD_OK")),
            outs.join("|"),
          ).toHaveLength(1);
          expect(
            outs.filter((o) => o.includes("STORE_LOCKED")),
            outs.join("|"),
          ).toHaveLength(1);
          const s = CanaryDurableStore.inspect(dir);
          expect(s.status).toBe("READY");
          expect(s.entries.filter((e) => e.type === "USE")).toHaveLength(1);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    },
  );
});

// G14 follow-up F4 (lock assumptions): measured on the INSTALLED Node, with a real worker thread of a real process.
describe("follow-up F4: a worker thread never opens the store (measured on the installed Node)", () => {
  it("the worker is refused STORE_THREAD_UNSUPPORTED; both threads' performance.timeOrigin are reported", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g14-f4-worker-"));
    try {
      const script = `
        const { Worker } = await import("node:worker_threads");
        const code = \`
          const { parentPort, isMainThread } = await import("node:worker_threads");
          let open = null;
          try { const { CanaryDurableStore } = await import(${JSON.stringify("file:///" + STORE.replaceAll("\\", "/"))});
            CanaryDurableStore.open(${JSON.stringify(dir)}); open = "OPENED"; }
          catch (e) { open = e.code ?? String(e); }
          parentPort.postMessage({ timeOrigin: performance.timeOrigin, isMainThread, open });\`;
        const w = new Worker(code, { eval: true });
        const m = await new Promise((r) => w.once("message", r));
        await w.terminate();
        console.log(JSON.stringify({ node: process.version, main: performance.timeOrigin, worker: m }));`;
      const out = await new Promise<string>((resolve) => {
        const c = spawn(
          process.execPath,
          [
            "--experimental-transform-types",
            "--disable-warning=ExperimentalWarning",
            "--import",
            "./scripts/ts-hooks.mjs",
            "--input-type=module",
            "-e",
            script,
          ],
          { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
        );
        let text = "";
        c.stdout.on("data", (d) => (text += String(d)));
        c.stderr.on("data", (d) => (text += String(d)));
        c.on("close", () => resolve(text));
      });
      const line = out.split(/\r?\n/).find((l) => l.startsWith("{"));
      expect(line, out).toBeDefined();
      const r = JSON.parse(line!) as {
        node: string;
        main: number;
        worker: { timeOrigin: number; isMainThread: boolean; open: string };
      };
      expect(r.worker.isMainThread).toBe(false);
      expect(r.worker.open).toBe("STORE_THREAD_UNSUPPORTED");
      // Recorded, not relied on: whether the two clocks' origins agree is a property of this Node version.
      console.log(
        `[lock-probe] node ${r.node} main.timeOrigin ${r.main} worker.timeOrigin ${r.worker.timeOrigin}`,
      );
      expect(existsSync(join(dir, "writer.lock"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
