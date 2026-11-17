// VEINED-MC1 lanes review ROUND 2 (D:/vnd/hk1/mc1/evidence/R-review/LANES_REVIEW_R2.md):
//   MINOR-2  every one of the 22 scanner variants that still PASSED scripts/verify-safety.mjs (run-r2.sh + the two adapter
//            mutations; payloads temp/review-lanes-r2/m/, embedded below byte for byte) now FAILS with its own message;
//   NEW-1    the ONE process-wide dispatch lock is pinned (both engines use it, nothing else may);
//   NEW-4    the explicit, never-default ARMED-PROFILE scan (`--armed-profile`): an armed-looking copy passes it and
//            fails the default scan; an armed copy with a forbidden egress (or another signer shape) still fails it.
// Same harness as lanes-review-verify-safety.test.ts: the REAL script on a temporary copy of the scanned tree, exactly
// the injected change, every file restored afterwards; the unmutated copy passes before and after.
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
const REVIEW_M = "D:/vnd/hk1/mc1/temp/review-lanes-r2/m";
const LANE = "src/swap/lane";
const ENGINE = `${LANE}/engine.ts`;
const BRIDGE_ENGINE = `${LANE}/bridge-engine.ts`;
const READS = `${LANE}/reads.ts`;
const ADAPTER = `${LANE}/signer-adapter.ts`;
const NEW_LANE_FILE = `${LANE}/zz-probe.ts`;
const API_ROUTE = "src/app/api/zz-probe/route.ts";
const SERVER_FILE = "src/server/zz-probe.ts";
const MSG = {
  g: "Swap lane: no Function constructor, .constructor, process other than process.cwd(), builtin loader or egress name in a lane file",
  h: "Swap lane: a lane file imports a module outside the lane allow-list",
  i: "Swap lane: no namespace import and no export * in a lane file",
  k: "Swap lane: the signer is reached only through postSigner's six direct calls, sign_send only after the gate re-run (no alias, no .call, no other reference)",
  l: "Swap lane: both engines spend a step only inside the ONE process-wide dispatch lock (dispatch-lock.ts)",
  signer: "Signer endpoint, token or header fragment outside the lane adapter",
  loopback: "Loopback literal outside the lane adapter (src/swap, src/app/api)",
  reexport: "Swap lane: a re-export of the lane transport",
  byString:
    "Swap lane: a transport function named by a string outside the transport",
  importers: (m: string) =>
    `Swap lane module ${m} imported outside its allowed importers`,
  global: "Swap lane: the global object touched in a lane file",
  egress:
    "Swap lane: no WebSocket, EventSource, XMLHttpRequest, beacon, eval, Function or import.meta in a lane file",
  fileSet:
    "Swap lane: a file in src/swap/lane outside the pinned lane file set",
  swapDisarmed:
    "Swap lane: disarmed (record null, key digest null, wiring false, signer null)",
  swapArmed:
    "Swap lane (armed profile): protected facts are disarmed values or exact armed values",
  bridgeArmed:
    "Bridge lane (armed profile): protected facts are disarmed values or exact armed values",
  noArmed:
    "Armed profile: no exact armed OWNER_SWAP_LANE_SIGNER / OWNER_BRIDGE_LANE_SIGNER declaration (use the default scan)",
};
// The review's payloads (temp/review-lanes-r2/m/*.txt), byte for byte (checked against the files below when present).
const PAYLOADS = {
  "v-ctor":
    '\n// r2 probe: the Function constructor reached through a function\'s prototype (no "Function(", no eval, no global name)\nconst Ctor = (() => 0).constructor as unknown as (\n  ...a: string[]\n) => (u: string) => Promise<unknown>;\nexport const probeCtor = (u: string) => Ctor("u", "return fe" + "tch(u)")(u);\n',
  "v-fn-alias":
    '\n// r2 probe: the Function constructor through a plain alias (the ban is the text "Function(")\nconst ProbeF = Function;\nexport const probeFnAlias = ProbeF("u", "return fe" + "tch(u)") as (u: string) => unknown;\nexport const probeFnParen = new (Function)("u", "return fe" + "tch(u)") as (u: string) => unknown;\n',
  "v-getbuiltin":
    '\n// r2 probe: Node 22.3+ process.getBuiltinModule with a built specifier (no quoted module name, no import)\nconst probeMod = process.getBuiltinModule("nod" + "e:ht" + "tps") as unknown as {\n  request: (u: string) => unknown;\n};\nexport const probeGb = (u: string) => probeMod.request(u);\n',
  "v-helper":
    'import { jsonRead } from "../server/transport";\n// r2 probe: a lane file borrowing a NON-lane egress helper (not the lane transport, no fetch identifier here)\nexport const probeHelper = (u: string, body: string) =>\n  jsonRead(u, { method: "POST", body }, AbortSignal.timeout(1000));\n',
  "v-hdr2":
    'import { readFileSync } from "node:fs";\n// r2 probe: the signer hand-off outside the adapter with different fragment boundaries (header, token file, port,\n// method), no "127.0.0.1:" literal and no 329x literal.\nexport async function probeSigner2(body: unknown) {\n  const h: Record<string, string> = { "content-type": "application/json" };\n  h["x-f" + "l1-s" + "igner-t" + "oken"] = readFileSync(\n    "D:/vnd/hk1/mc1/journal/signer-v" + "5.token",\n    "utf8",\n  ).trim();\n  const u = new URL("http://127.0.0.1/");\n  u.port = String(0xcdc);\n  return fetch(u, {\n    method: "POST",\n    headers: h,\n    body: JSON.stringify({ method: "sign_" + "send", ...(body as object) }),\n  });\n}\n',
  "v-case-transport":
    'import * as T from "./Transport";\n// r2 probe: the lane transport imported under a different letter case (Windows resolves it), called by a built name\nexport const probeCase = (m: string) =>\n  (T as unknown as Record<string, (...a: unknown[]) => unknown>)["lane" + "JsonRpc"](\n    "8453",\n    0,\n    m,\n    [],\n    AbortSignal.timeout(1000),\n  );\n',
  "v-case-adapter":
    'import * as A from "../../../swap/lane/Signer-Adapter";\n// r2 probe: an API route reaching the signer adapter under a different letter case, minting and sending by built names\nexport async function POST(req: Request) {\n  const facts = (await req.json()) as { tx: Record<string, string>; step: string };\n  const X = A as unknown as Record<string, (...a: unknown[]) => unknown>;\n  const auth = X["mintLane" + "DispatchAuthority"](facts);\n  return Response.json(await X["sendLane" + "Transaction"](auth, facts.tx, facts.step));\n}\n',
  "v-reexport-ns":
    '\n// r2 probe: a namespace re-export of the raw transport (the rule matches "export * from" / "export { } from" only)\nexport * as probeTransport from "./transport";\n',
  "v-reexport-ns2":
    '\n// r2 probe: a namespace import of the raw transport handed out by a plain export (no "from", no function name)\nimport * as probeNs from "./transport";\nexport { probeNs };\n',
  "v-useleak-ns":
    'import { probeTransport } from "../../../swap/lane/reads";\n// r2 probe: an API route using the namespace re-export by a built name\nexport async function GET() {\n  const T = probeTransport as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;\n  return Response.json(await T["lane" + "JsonRpc"]("8453", 0, "eth_blockNumber", [], AbortSignal.timeout(1000)));\n}\n',
} as const;
// review-lanes-r2/mk-adapter-mut.mjs: the very same lines, after the very same anchor, as the first lines of
// sendLaneTransaction — BEFORE the authority, transaction and gate checks.
const ADAPTER_ANCHOR =
  'step: "APPROVE" | "SWAP" | "REVOKE",\n): Promise<LaneSignerResult> {\n';
const PREGATE = {
  "adapter-pregate-call":
    '  await postSigner.call(null, OWNER_SWAP_LANE_SIGNER, { method: "sign_send", declared: { lane: "SWAP", route: "base-usdc-weth-univ3-max1", step: "APPROVE" }, tx });\n',
  "adapter-pregate-alias":
    '  const P = postSigner;\n  await P(OWNER_SWAP_LANE_SIGNER, { method: "sign_send", declared: { lane: "SWAP", route: "base-usdc-weth-univ3-max1", step: "APPROVE" }, tx });\n',
} as const;

const T = 120_000;
let root = "";
let runs = 0;
beforeAll(() => {
  mkdirSync(TEMP, { recursive: true });
  root = mkdtempSync(join(TEMP, "lanes-review-r2-verify-safety-"));
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
function run(args: readonly string[] = []) {
  const out = join(root, `.out-${++runs}`);
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    env: { ...process.env, OTHERBRIDGE_EVIDENCE_ROOT: out },
    encoding: "utf8",
    timeout: T,
  });
  return {
    ok: r.status === 0,
    output: `${r.stdout ?? ""}\n${r.stderr ?? ""}`,
    out,
  };
}
type Edit = (text: string | null) => string;
/** Applies every edit (file -> new text), runs the scanner, restores every file. */
function withChanges(edits: readonly [string, Edit][], args: string[] = []) {
  const before = edits.map(([file]) => {
    const p = join(root, file);
    return [p, existsSync(p) ? readFileSync(p, "utf8") : null] as const;
  });
  try {
    for (const [file, edit] of edits) {
      const p = join(root, file);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, edit(existsSync(p) ? readFileSync(p, "utf8") : null));
    }
    return run(args);
  } finally {
    for (const [p, text] of before.reverse())
      if (text === null) rmSync(p, { force: true });
      else writeFileSync(p, text);
  }
}
const withChange = (file: string, edit: Edit, args: string[] = []) =>
  withChanges([[file, edit]], args);
// the reviewer's mut.sh modes: `cat payload >> file`, `cat payload file`, a new file with exactly the payload
const append = (code: string) => (t: string | null) => `${t ?? ""}${code}`;
const prepend = (code: string) => (t: string | null) => `${code}${t ?? ""}`;
const fresh = (code: string) => () => code;
const replaceOnce =
  (from: string, to: string): Edit =>
  (t) => {
    const s = t ?? "";
    if (s.split(from).length !== 2)
      throw new Error(`MUTATION_ANCHOR_NOT_UNIQUE ${from.slice(0, 60)}`);
    return s.replace(from, to);
  };
const expectFail = (
  r: { ok: boolean; output: string },
  message: string | RegExp,
) => {
  expect(r.ok, r.output.slice(-1200)).toBe(false);
  if (typeof message === "string") expect(r.output).toContain(message);
  else expect(r.output).toMatch(message);
};

describe("baseline", () => {
  it(
    "the unmutated tree passes the default scan (still disarmed), rule counts unchanged",
    () => {
      const r = run();
      expect(r.ok, r.output.slice(-1200)).toBe(true);
      const out = JSON.parse(
        readFileSync(join(r.out, "safety.json"), "utf8"),
      ) as {
        result: string;
        g14Canary: { rules: number };
        swapLane: { rules: number };
      };
      expect(out.result).toBe("PASS");
      expect(out.g14Canary.rules).toBe(12);
      expect(out.swapLane.rules).toBe(2);
    },
    T,
  );
  it.skipIf(!existsSync(REVIEW_M))(
    "the embedded payloads are the review's files byte for byte",
    () => {
      for (const [name, text] of Object.entries(PAYLOADS))
        expect(readFileSync(`${REVIEW_M}/${name}.txt`, "utf8"), name).toBe(
          text,
        );
      for (const [name, line] of Object.entries(PREGATE)) {
        const review = readFileSync(`${REVIEW_M}/${name}.txt`, "utf8");
        expect(review.includes(ADAPTER_ANCHOR + line), name).toBe(true);
      }
    },
  );
});

describe("MINOR-2: the 22 round-2 variants (run-r2.sh order) fail, each with its own rule", () => {
  const CASES: [string, string, Edit, string | RegExp][] = [];
  for (const [p, message] of [
    ["v-ctor", MSG.g],
    ["v-getbuiltin", MSG.g],
    ["v-helper", MSG.h],
    ["v-fn-alias", MSG.g],
  ] as const) {
    CASES.push([
      `${p}-newfile`,
      NEW_LANE_FILE,
      fresh(PAYLOADS[p]),
      `${message}: ${NEW_LANE_FILE}`,
    ]);
    CASES.push([
      `${p}-bridge-engine`,
      BRIDGE_ENGINE,
      append(PAYLOADS[p]),
      `${message}: ${BRIDGE_ENGINE}`,
    ]);
    CASES.push([
      `${p}-engine`,
      ENGINE,
      append(PAYLOADS[p]),
      `${message}: ${ENGINE}`,
    ]);
  }
  CASES.push(
    [
      "v-helper-engine-prepend",
      ENGINE,
      prepend(PAYLOADS["v-helper"]),
      `${MSG.h}: ${ENGINE}`,
    ],
    [
      "v-hdr2-server",
      SERVER_FILE,
      fresh(PAYLOADS["v-hdr2"]),
      `${MSG.signer}: ${SERVER_FILE}`,
    ],
    [
      "v-hdr2-api",
      API_ROUTE,
      fresh(PAYLOADS["v-hdr2"]),
      `${MSG.signer}: ${API_ROUTE}`,
    ],
    [
      "v-case-transport-newfile",
      NEW_LANE_FILE,
      fresh(PAYLOADS["v-case-transport"]),
      `${MSG.importers("src/swap/lane/transport")}: ${NEW_LANE_FILE}`,
    ],
    [
      "v-case-adapter-api",
      API_ROUTE,
      fresh(PAYLOADS["v-case-adapter"]),
      `${MSG.importers("src/swap/lane/signer-adapter")}: ${API_ROUTE}`,
    ],
    [
      "v-reexport-ns-reads",
      READS,
      append(PAYLOADS["v-reexport-ns"]),
      `${MSG.reexport}: ${READS}`,
    ],
    [
      "v-reexport-ns2-reads",
      READS,
      append(PAYLOADS["v-reexport-ns2"]),
      `${MSG.i}: ${READS}`,
    ],
  );
  it.each(CASES)(
    "%s",
    (_name, file, edit, message) => {
      expectFail(withChange(file, edit), message);
    },
    T,
  );
  it(
    "v-useleak-ns-combined: the namespace re-export in reads.ts + an API route using it by a built name",
    () => {
      expectFail(
        withChanges([
          [READS, append(PAYLOADS["v-reexport-ns"])],
          [API_ROUTE, fresh(PAYLOADS["v-useleak-ns"])],
        ]),
        new RegExp(
          `${MSG.byString}: ${API_ROUTE}|${MSG.reexport}: ${READS}`.replace(
            /[()]/g,
            "\\$&",
          ),
        ),
      );
    },
    T,
  );
  it.each(Object.entries(PREGATE))(
    "%s: a send before the gate in sendLaneTransaction",
    (_name, line) => {
      expectFail(
        withChange(ADAPTER, replaceOnce(ADAPTER_ANCHOR, ADAPTER_ANCHOR + line)),
        MSG.k,
      );
    },
    T,
  );
});

describe("MINOR-2: neighbours of the 22 (closed by the same rules)", () => {
  it.each([
    [
      "the useleak route alone (a built transport name, whatever reads.ts exports)",
      API_ROUTE,
      fresh(PAYLOADS["v-useleak-ns"]),
      `${MSG.byString}: ${API_ROUTE}`,
    ],
    [
      'a built ".constructor" key in a lane file',
      ENGINE,
      append(
        '\nexport const probeK = (f: () => void) => (f as unknown as Record<string, unknown>)["con" + "structor"];\n',
      ),
      `${MSG.g}: ${ENGINE}`,
    ],
    [
      "process indexed by a built name",
      BRIDGE_ENGINE,
      append(
        '\nexport const probeP = () => (process as unknown as Record<string, unknown>)["getBuilt" + "inModule"];\n',
      ),
      `${MSG.g}: ${BRIDGE_ENGINE}`,
    ],
    [
      "the runtime singleton alias indexed (globals[...])",
      `${LANE}/runtime.ts`,
      append(
        '\nexport const probeG = () => (globals as unknown as Record<string, unknown>)["fe" + "tch"];\n',
      ),
      `${MSG.global}: ${LANE}/runtime.ts`,
    ],
    [
      "a fetch alias inside the adapter",
      ADAPTER,
      append(
        "\nconst probeF = fetch;\nexport const probeA = (u: string) => probeF(u);\n",
      ),
      MSG.k,
    ],
    [
      "a postSigner reference outside its calls (an array)",
      ADAPTER,
      append("\nexport const probeArr = [postSigner];\n"),
      MSG.k,
    ],
    [
      'a built "sign_" + "send" anywhere in the adapter',
      ADAPTER,
      append('\nexport const probeM = "sign_" + "send";\n'),
      MSG.k,
    ],
    [
      "a lane file with another extension (.tsx escapes the .ts rules)",
      `${LANE}/zz-probe.tsx`,
      fresh("export const probeX = 1;\n"),
      `${MSG.fileSet}: ${LANE}/zz-probe.tsx`,
    ],
    [
      "a harmless new lane file (the lane file set is pinned)",
      NEW_LANE_FILE,
      fresh("export const probeX = 1;\n"),
      `${MSG.fileSet}: ${NEW_LANE_FILE}`,
    ],
    [
      "a loopback literal in an API route",
      API_ROUTE,
      fresh('export const probeL = "http://local" + "host:8080/";\n'),
      `${MSG.loopback}: ${API_ROUTE}`,
    ],
    [
      "the signer port in another notation outside the adapter",
      SERVER_FILE,
      fresh("export const probeN = 0o6334;\n"),
      `${MSG.signer}: ${SERVER_FILE}`,
    ],
  ] as const)(
    "%s",
    (_name, file, edit, message) => {
      expectFail(withChange(file, edit), message);
    },
    T,
  );
});

describe("NEW-1: the ONE process-wide dispatch lock is pinned", () => {
  const LOCK_HEAD = (cls: string) =>
    `    return withLaneDispatchLock(\n      this.#lockKey,\n      () => new ${cls}("DISPATCH_IN_PROGRESS"),\n      async () => {\n        const rec = this.#rec,`;
  it.each([
    [
      "the swap revoke run through a local stand-in instead of the lock",
      ENGINE,
      "SwapLaneError",
    ],
    [
      "the bridge revoke run through a local stand-in instead of the lock",
      BRIDGE_ENGINE,
      "BridgeLaneError",
    ],
  ] as const)(
    "%s",
    (_name, file, cls) => {
      expectFail(
        withChange(
          file,
          replaceOnce(
            LOCK_HEAD(cls),
            LOCK_HEAD(cls).replace(
              "return withLaneDispatchLock(",
              "return ((_k: string, _b: unknown, f: () => Promise<never>) => f())(",
            ),
          ),
        ),
        `${MSG.l}: ${file}`,
      );
    },
    T,
  );
  it(
    "another module importing the lock",
    () => {
      expectFail(
        withChange(
          READS,
          append(
            '\nimport { withLaneDispatchLock } from "./dispatch-lock";\nexport const probeLock = withLaneDispatchLock;\n',
          ),
        ),
        `${MSG.importers("src/swap/lane/dispatch-lock")}: ${READS}`,
      );
    },
    T,
  );
  it(
    "the lock's global holder touched from outside the lock module",
    () => {
      expectFail(
        withChange(
          SERVER_FILE,
          fresh(
            'export const probeH = () => (globalThis as unknown as Record<string, unknown>)["__veinedLane" + "DispatchLock"];\n',
          ),
        ),
        `${MSG.l}: ${SERVER_FILE}`,
      );
    },
    T,
  );
  it(
    "a hand-off after the lock span (the outcome recorded outside #recordDispatch)",
    () => {
      expectFail(
        withChange(
          ENGINE,
          replaceOnce(
            "  // ------------------------------------------------------------------------------------------------ track\n",
            '  #probe() {\n    this.#d.store.append("DISPATCH", { step: "SWAP", outcome: "REFUSED", hash: null, problems: [] });\n  }\n  // ------------------------------------------------------------------------------------------------ track\n',
          ),
        ),
        `${MSG.l}: ${ENGINE}`,
      );
    },
    T,
  );
});

describe("NEW-4: the explicit armed-profile scan (--armed-profile)", () => {
  const ARMED_URL = "http://127.0.0.1:3292/";
  const TOKEN = "D:/vnd/hk1/mc1/journal/signer-v5.token";
  const armedFacts = (P: "SWAP" | "BRIDGE", rec: string, signer: string) =>
    [
      [
        `export const OWNER_${P}_LANE_APPROVAL =\n  null as Readonly<${rec}> | null;`,
        `export const OWNER_${P}_LANE_APPROVAL = {\n  version: 1,\n  approvalId: "synthetic-armed-record",\n} as Readonly<${rec}> | null;`,
      ],
      [
        `export const OWNER_${P}_LANE_KEY_SHA256 = null as string | null;`,
        `export const OWNER_${P}_LANE_KEY_SHA256 = "${"ab".repeat(32)}" as string | null;`,
      ],
      [
        `export const ${P}_LANE_LIVE_WIRING = false as const;`,
        `export const ${P}_LANE_LIVE_WIRING = true as const;`,
      ],
      [
        `export const OWNER_${P}_LANE_SIGNER = null as Readonly<{`,
        `export const OWNER_${P}_LANE_SIGNER = ${signer} as Readonly<{`,
      ],
    ] as const;
  const armed =
    (P: "SWAP" | "BRIDGE", rec: string, signer: string): Edit =>
    (t) => {
      let s = t ?? "";
      for (const [from, to] of armedFacts(P, rec, signer))
        s = replaceOnce(from, to)(s);
      return s;
    };
  const signerOf = (url = ARMED_URL, token = TOKEN) =>
    `{\n  url: "${url}",\n  tokenFile: "${token}",\n}`;
  const armSwap = (signer = signerOf()): [string, Edit] => [
    `${LANE}/approval.ts`,
    armed("SWAP", "OwnerSwapLaneApproval", signer),
  ];
  const armBridge = (signer = signerOf()): [string, Edit] => [
    `${LANE}/bridge-approval.ts`,
    armed("BRIDGE", "OwnerBridgeLaneApproval", signer),
  ];
  const profile = ["--armed-profile"];
  const armedResult = (r: { out: string }) =>
    JSON.parse(
      readFileSync(join(r.out, "safety-armed-profile.json"), "utf8"),
    ) as { result: string; profile: string; armedSigners: string[] };
  it(
    "an armed-looking swap approval: the DEFAULT scan refuses it (the disarmed rule), the armed profile passes it",
    () => {
      expectFail(withChanges([armSwap()]), MSG.swapDisarmed);
      const r = withChanges([armSwap()], profile);
      expect(r.ok, r.output.slice(-1200)).toBe(true);
      expect(armedResult(r)).toMatchObject({
        result: "ARMED_PROFILE_PASS",
        profile: "armed-profile",
        armedSigners: ["OWNER_SWAP_LANE_SIGNER"],
      });
      expect(existsSync(join(r.out, "safety.json"))).toBe(false);
    },
    2 * T,
  );
  it(
    "both lanes armed (one signer, port 3292): the default scan refuses, the armed profile passes",
    () => {
      expectFail(withChanges([armSwap(), armBridge()]), MSG.swapDisarmed);
      const r = withChanges([armSwap(), armBridge()], profile);
      expect(r.ok, r.output.slice(-1200)).toBe(true);
      expect(armedResult(r).armedSigners).toEqual([
        "OWNER_BRIDGE_LANE_SIGNER",
        "OWNER_SWAP_LANE_SIGNER",
      ]);
    },
    2 * T,
  );
  it(
    "an armed bridge approval alone: the default scan refuses it, the armed profile passes it",
    () => {
      expectFail(
        withChanges([armBridge()]),
        /Signer endpoint, token or header fragment outside the lane adapter: src\/swap\/lane\/bridge-approval\.ts|Bridge lane: disarmed/,
      );
      const r = withChanges([armBridge()], profile);
      expect(r.ok, r.output.slice(-1200)).toBe(true);
    },
    2 * T,
  );
  it.each([
    [
      "a WebSocket in the swap engine",
      ENGINE,
      "\nexport const probeWs = (u: string) => new WebSocket(u);\n",
      `${MSG.egress}: ${ENGINE}`,
    ],
    [
      "the Function constructor in the bridge engine (v-ctor)",
      BRIDGE_ENGINE,
      PAYLOADS["v-ctor"],
      `${MSG.g}: ${BRIDGE_ENGINE}`,
    ],
    [
      "a signer hand-off outside the adapter (v-hdr2)",
      SERVER_FILE,
      PAYLOADS["v-hdr2"],
      `${MSG.signer}: ${SERVER_FILE}`,
    ],
  ] as const)(
    "an ARMED copy with a forbidden egress still fails the armed profile: %s",
    (_name, file, code, message) => {
      expectFail(
        withChanges([armSwap(), armBridge(), [file, append(code)]], profile),
        message,
      );
    },
    T,
  );
  it.each([
    ["another port (8545)", signerOf("http://127.0.0.1:8545/"), MSG.swapArmed],
    ["another host", signerOf("http://10.0.0.7:3292/"), MSG.swapArmed],
    [
      "a token file outside the journal directory",
      signerOf(ARMED_URL, "D:/vnd/hk1/mc1/temp/signer-v5.token"),
      MSG.swapArmed,
    ],
    [
      "an extra field",
      `{\n  url: "${ARMED_URL}",\n  tokenFile: "${TOKEN}",\n  fallback: "https://example.invalid/",\n}`,
      MSG.swapArmed,
    ],
  ] as const)(
    "a signer declaration that is not the exact armed shape fails the armed profile: %s",
    (_name, signer, message) => {
      expectFail(withChanges([armSwap(signer)], profile), message);
    },
    T,
  );
  it(
    "a malformed armed key digest fails the armed-shape rule",
    () => {
      expectFail(
        withChanges(
          [
            armSwap(),
            [
              `${LANE}/approval.ts`,
              replaceOnce(`"${"ab".repeat(32)}"`, '"not-a-digest"'),
            ],
          ],
          profile,
        ),
        MSG.swapArmed,
      );
      expectFail(
        withChanges(
          [
            armBridge(),
            [
              `${LANE}/bridge-approval.ts`,
              replaceOnce(
                "BRIDGE_LANE_LIVE_WIRING = true as const;",
                "BRIDGE_LANE_LIVE_WIRING = 1 as const;",
              ),
            ],
          ],
          profile,
        ),
        MSG.bridgeArmed,
      );
    },
    2 * T,
  );
  it(
    "the disarmed tree is not an armed variant (the armed profile refuses it); an unknown argument is refused",
    () => {
      expectFail(run(profile), MSG.noArmed);
      expectFail(run(["--armed"]), "verify-safety: unknown argument --armed");
    },
    2 * T,
  );
  it(
    "the unmutated tree still passes the default scan after every mutation above",
    () => {
      const r = run();
      expect(r.ok, r.output.slice(-1200)).toBe(true);
    },
    T,
  );
});
