// VEINED-MC1 (lanes review MINOR-2, MAJOR-1): every scanner bypass the independent review demonstrated
// (D:/vnd/hk1/mc1/evidence/R-review/LANES_REVIEW.md, payloads temp/review-lanes/m/*.txt) now FAILS scripts/verify-safety.mjs
// with its own message; the unmutated copy passes. Same harness as swap-lane-verify-safety.test.ts: the REAL script on a
// temporary copy of the scanned tree, exactly the injected change, every file restored afterwards.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SCRIPT = resolve("scripts/verify-safety.mjs");
const TEMP = process.env.FL1 ? join(process.env.FL1, "temp") : tmpdir();
const LANE = "src/swap/lane";
const ENGINE = `${LANE}/bridge-engine.ts`;
const TRANSPORT = `${LANE}/transport.ts`;
const READS = `${LANE}/reads.ts`;
const MSG = {
  global: "Swap lane: the global object touched in a lane file",
  egress:
    "Swap lane: no WebSocket, EventSource, XMLHttpRequest, beacon, eval, Function or import.meta in a lane file",
  module:
    "Swap lane: no network, process or VM module (bare or node:) in a lane file",
  rawModule:
    "Swap lane: no raw network module, child process or globalThis indexing",
  fetchCount:
    "Swap lane: the fetch identifier outside the transport's two call sites",
  reexport: "Swap lane: a re-export of the lane transport",
  handsOut:
    "Swap lane: reads.ts hands out a transport function (only direct calls are allowed)",
  named:
    "Swap lane: a transport function named outside the transport and reads.ts",
  signer: "Signer endpoint, token or header fragment outside the lane adapter",
  status: "Swap lane signer status outside the runtimes",
  dynamic:
    /Non-literal dynamic import\(\) in src|Swap lane module loaded dynamically/,
};
const T = 120_000;
let root = "";
let runs = 0;
beforeAll(() => {
  mkdirSync(TEMP, { recursive: true });
  root = mkdtempSync(join(TEMP, "lanes-review-verify-safety-"));
  for (const p of [
    "src",
    "services",
    "packages",
    ".env.example",
    "package.json",
  ])
    cpSync(resolve(p), join(root, p), { recursive: true });
}, T);
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
function run() {
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    env: {
      ...process.env,
      OTHERBRIDGE_EVIDENCE_ROOT: join(root, `.out-${++runs}`),
    },
    encoding: "utf8",
    timeout: T,
  });
  return { ok: r.status === 0, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}
function withChange(file: string, edit: (text: string | null) => string) {
  const p = join(root, file);
  const before = existsSync(p) ? readFileSync(p, "utf8") : null;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, edit(before));
  try {
    return run();
  } finally {
    if (before === null) rmSync(p);
    else writeFileSync(p, before);
  }
}
const append = (code: string) => (t: string | null) => `${t ?? ""}\n${code}\n`;
const expectFail = (
  r: { ok: boolean; output: string },
  message: string | RegExp,
) => {
  expect(r.ok, r.output.slice(-800)).toBe(false);
  if (typeof message === "string") expect(r.output).toContain(message);
  else expect(r.output).toMatch(message);
};

describe("baseline", () => {
  it(
    "the unmutated tree passes",
    () => {
      const r = run();
      expect(r.ok, r.output.slice(-800)).toBe(true);
    },
    T,
  );
});

describe("lane files: the global object, network globals, eval / Function, network / VM modules", () => {
  it.each([
    [
      "alias globalThis then index it (alias-global)",
      ENGINE,
      'const g0 = globalThis as unknown as Record<string, (u: string) => Promise<unknown>>;\nexport const probeLeak = (u: string) => g0["fe" + "tch"](u);',
      MSG.global,
    ],
    [
      "const G = globalThis in the transport (t-alias: a third egress)",
      TRANSPORT,
      'const G = globalThis;\nexport const probeT = (u: string) => (G as unknown as { [k: string]: (x: string) => unknown })["fe" + "tch"](u);',
      MSG.global,
    ],
    [
      "self / window / global",
      ENGINE,
      "export const s = () => self;",
      MSG.global,
    ],
    [
      "new WebSocket(u)",
      ENGINE,
      "export const probeWs = (u: string) => new WebSocket(u);",
      MSG.egress,
    ],
    [
      "a wss:// literal through WebSocket (ws-url)",
      ENGINE,
      'const PROBE_URL = "wss://example.invalid/rpc";\nexport const probeWs2 = () => new WebSocket(PROBE_URL);',
      MSG.egress,
    ],
    [
      "new EventSource(u)",
      ENGINE,
      "export const probeEs = (u: string) => new EventSource(u);",
      MSG.egress,
    ],
    [
      "XMLHttpRequest",
      ENGINE,
      "export const x = () => new XMLHttpRequest();",
      MSG.egress,
    ],
    [
      "(0, eval)(...)",
      ENGINE,
      'export const probeEval = (u: string) => (0, eval)("fe" + "tch")(u);',
      MSG.egress,
    ],
    [
      "new Function(...)",
      ENGINE,
      'export const probeFn = new Function("u", "return fe" + "tch(u)");',
      MSG.egress,
    ],
    ["import.meta", ENGINE, "export const m = () => import.meta;", MSG.egress],
    [
      'bare "http2"',
      ENGINE,
      'import * as h2 from "http2";\nexport const probeH2 = (u: string) => h2.connect(u);',
      MSG.module,
    ],
    [
      'bare "dgram"',
      ENGINE,
      'import * as dg from "dgram";\nexport const probeDg = () => dg.createSocket("udp4");',
      MSG.module,
    ],
    [
      '"node:vm"',
      ENGINE,
      'import * as vm from "node:vm";\nexport const probeVm = (c: string) => vm.runInThisContext(c);',
      MSG.module,
    ],
    [
      'bare "dns" / "worker_threads"',
      ENGINE,
      'import * as d from "dns";\nexport const r = d.resolve;',
      MSG.module,
    ],
    [
      '"node:https" request (xhr)',
      ENGINE,
      'import { request } from "node:https";\nexport const probeReq = (u: string) => request(u);',
      MSG.rawModule,
    ],
  ] as const)(
    "%s",
    (_name, file, code, message) => {
      expectFail(withChange(file, append(code)), `${message}: ${file}`);
    },
    T,
  );
  it(
    "a third fetch reference in the transport (an alias, not a call)",
    () => {
      expectFail(
        withChange(TRANSPORT, append("export const f2 = fetch;")),
        MSG.fetchCount,
      );
    },
    T,
  );
  it(
    "dynamic imports of the transport (importmeta / lazyimport payloads)",
    () => {
      expectFail(
        withChange(
          READS,
          append(
            'export const probeImp = async () => (await import("./trans" + "port")).laneJsonRpc;',
          ),
        ),
        MSG.dynamic,
      );
      expectFail(
        withChange(
          READS,
          append(
            'export const probeImp2 = async () => (await import(/* x */ "./transport")).laneJsonRpc;',
          ),
        ),
        MSG.dynamic,
      );
    },
    2 * T,
  );
});

describe("the raw transport never escapes reads.ts", () => {
  it(
    'export { laneJsonRpc, laneGetLogs, laneLifiQuote } from "./transport" in reads.ts (reexport)',
    () => {
      expectFail(
        withChange(
          READS,
          append(
            'export { laneJsonRpc, laneGetLogs, laneLifiQuote } from "./transport";',
          ),
        ),
        `${MSG.reexport}: ${READS}`,
      );
    },
    T,
  );
  it(
    "reads.ts handing a transport function out as a value",
    () => {
      expectFail(
        withChange(READS, append("export const leak = laneJsonRpc;")),
        `${MSG.handsOut}: ${READS}`,
      );
      expectFail(
        withChange(READS, append("export { laneLifiQuote };")),
        `${MSG.handsOut}: ${READS}`,
      );
    },
    2 * T,
  );
  it(
    "an API route importing transport functions through reads.ts (useleak)",
    () => {
      const file = "src/app/api/lane-leak/route.ts";
      expectFail(
        withChange(file, () =>
          [
            'import { laneLifiQuote, laneJsonRpc } from "../../../swap/lane/reads";',
            "export async function GET() {",
            '  await laneJsonRpc("1", 0, "eth_call", [{ to: "0x0000000000000000000000000000000000000001", data: "0x" }, "0x1"], AbortSignal.timeout(1000));',
            '  return new Response(JSON.stringify(await laneLifiQuote({ fromChain: "1", toChain: "10", fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", toToken: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", fromAmount: "1", account: "0x0000000000000000000000000000000000000001" }, AbortSignal.timeout(1000))));',
            "}",
            "",
          ].join("\n"),
        ),
        `${MSG.named}: ${file}`,
      );
    },
    T,
  );
});

describe("the signer's endpoint, token, header and method live in the adapter alone", () => {
  it(
    "header fragments + the token path + the loopback port outside the lane (hdr-outside)",
    () => {
      const file = "src/server/probe-signer.ts";
      expectFail(
        withChange(file, () =>
          [
            'import { readFileSync } from "node:fs";',
            "export async function probeSigner(body: unknown) {",
            '  const h: Record<string, string> = { "content-type": "application/json" };',
            '  h["x-fl" + "1-sig" + "ner-to" + "ken"] = readFileSync("D:/vnd/hk1/mc1/journal/signer-v5" + ".token", "utf8");',
            '  return fetch("http://127.0.0.1:" + 3292 + "/", { method: "POST", headers: h, body: JSON.stringify({ method: "sign_send", ...(body as object) }) });',
            "}",
            "",
          ].join("\n"),
        ),
        `${MSG.signer}: ${file}`,
      );
    },
    T,
  );
  it.each([
    ['a "sign_send" method name', 'export const M = "sign_send";'],
    ["the loopback signer URL", 'export const U = "http://127.0.0.1:3292/";'],
    ["a bare signer port", "export const PORT = 3292;"],
    [
      "a token-file path",
      'export const P = "D:/vnd/hk1/mc1/journal/signer-v5.token";',
    ],
  ] as const)(
    "%s in another src file",
    (_name, code) => {
      const file = "src/server/probe-signer.ts";
      expectFail(
        withChange(file, () => `${code}\n`),
        `${MSG.signer}: ${file}`,
      );
    },
    T,
  );
  // The real signer port in an approval file is refused. Whichever rule runs first names it: the swap lane's own
  // disarmed rule (13) precedes (e); in the bridge lane (e) precedes the bridge disarmed rule (13b).
  it.each([
    [
      `${LANE}/approval.ts`,
      "export const OWNER_SWAP_LANE_SIGNER = null as Readonly<{",
      'export const OWNER_SWAP_LANE_SIGNER = { url: "http://127.0.0.1:3291/", tokenFile: "t" } as Readonly<{',
      "Swap lane: disarmed (record null, key digest null, wiring false, signer null)",
    ],
    [
      `${LANE}/bridge-approval.ts`,
      "export const OWNER_BRIDGE_LANE_SIGNER = null as Readonly<{",
      'export const OWNER_BRIDGE_LANE_SIGNER = { url: "http://127.0.0.1:3292/", tokenFile: "t" } as Readonly<{',
      `${MSG.signer}: ${LANE}/bridge-approval.ts`,
    ],
  ] as const)(
    "the real signer loopback port in an approval file (%s)",
    (file, from, to, message) => {
      expectFail(
        withChange(file, (t) => {
          const next = (t ?? "").replace(from, to);
          if (next === t) throw new Error(`MUTATION_ANCHOR_MISSING ${from}`);
          return next;
        }),
        message,
      );
    },
    T,
  );
  it(
    "the signer status reached outside the runtimes",
    () => {
      expectFail(
        withChange(
          ENGINE,
          append(
            'import { laneSignerStatus } from "./signer-adapter";\nexport const s = () => laneSignerStatus("BRIDGE");',
          ),
        ),
        `${MSG.status}: ${ENGINE}`,
      );
    },
    T,
  );
  it(
    "the unmutated tree still passes after all the mutations above",
    () => {
      expect(run().ok).toBe(true);
    },
    T,
  );
});
