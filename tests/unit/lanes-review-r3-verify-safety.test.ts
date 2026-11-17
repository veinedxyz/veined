// VEINED-MC1 lanes review ROUND 3 (D:/vnd/hk1/mc1/evidence/R-review/LANES_REVIEW_R3.md, LANES_R3_PASS_WITH_FIXES):
//   R3-1  viem only through its allow-listed named helpers (no client / transport factory, no namespace, default or
//         subpath import): a lane file has no egress through viem;
//   R3-2  in the adapter, "after the gate" is EXECUTION order: no nested function in the send functions (the exempt
//         callback set is empty), pinned statements before the gate, every postSigner call in a later top-level
//         statement, the endpoint facts and gates bound once by their imports;
//   R3-3  the dispatch lock on the syntax tree: no computed member access or alias of the signer, the store, the mint
//         or their methods; hand-offs, mints and USE / NONCE / PREPARED appends directly inside the locked callback;
//   R3-4  the protected facts are their declaration NODES (no text exemption a string can open or close); the armed
//         profile accepts exactly url http://127.0.0.1:3292/ and a local journal token path without `..` or UNC;
//   NITs  the lock state under a registry symbol, non-writable / non-configurable, refused anywhere else in src; the
//         char-code tripwire (the class stays an accepted residual outside the lane, docs/SPEC_BRIDGE_LANE.md).
// Every one of the review's 17 payloads (temp/review-lanes-r3/m/*.txt) is a permanent mutation below, in the review's
// own placement (mut.sh / run-r3.sh / run-r3.log): the 8 short ones embedded byte for byte, the 9 whole-file ones
// regenerated from the CURRENT adapter / engine with the review's own anchors (mk-adapter-mut.mjs, mk-engine-mut.mjs)
// and compared with the review's files byte for byte when they are present.
// Same harness as lanes-review-r2-verify-safety.test.ts: the REAL script on a temporary copy of the scanned tree,
// exactly the injected change, every file restored afterwards; the unmutated copy passes before and after.
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
import {
  laneDispatchPending,
  withLaneDispatchLock,
} from "../../src/swap/lane/dispatch-lock";

const SCRIPT = resolve("scripts/verify-safety.mjs");
const TEMP = process.env.FL1 ? join(process.env.FL1, "temp") : tmpdir();
const REVIEW_M = "D:/vnd/hk1/mc1/temp/review-lanes-r3/m";
const LANE = "src/swap/lane";
const ENGINE = `${LANE}/engine.ts`;
const BRIDGE_ENGINE = `${LANE}/bridge-engine.ts`;
const READS = `${LANE}/reads.ts`;
const CALLDATA = `${LANE}/calldata.ts`;
const SCOPE = `${LANE}/scope.ts`;
const RUNTIME = `${LANE}/runtime.ts`;
const ADAPTER = `${LANE}/signer-adapter.ts`;
const LOCK = `${LANE}/dispatch-lock.ts`;
const APPROVAL = `${LANE}/approval.ts`;
const BRIDGE_APPROVAL = `${LANE}/bridge-approval.ts`;
const API_ROUTE = "src/app/api/zz-probe/route.ts";
const SERVER_FILE = "src/server/zz-probe.ts";
const SERVER_LOCK = "src/server/zz-lock.ts";
const MSG = {
  h: "Swap lane: a lane file imports a module outside the lane allow-list",
  i: "Swap lane: no namespace import and no export * in a lane file",
  v: "Swap lane: viem only through its allow-listed named helpers (no client, transport, default, namespace or subpath import)",
  k: "Swap lane: the signer is reached only through postSigner's six direct calls, sign_send only after the gate re-run (no alias, no .call, no other reference)",
  k2: "Swap lane: the adapter's send functions hold no nested function, and the gate check is the first statement that can reach postSigner",
  bridgeOrder:
    "Bridge lane: single-use authority, exact tx, BRIDGE gate re-run and loopback-only signer before anything is sent",
  l: "Swap lane: both engines spend a step only inside the ONE process-wide dispatch lock (dispatch-lock.ts)",
  l2: "Swap lane: the signer hand-off, the mint and the USE / NONCE / PREPARED appends are direct calls inside the dispatch lock (no computed access, no alias)",
  mint: "Swap lane dispatch authority minted outside the engine",
  rawGlobal:
    "Swap lane: no raw network module, child process or globalThis indexing",
  global: "Swap lane: the global object touched in a lane file",
  signer: "Signer endpoint, token or header fragment outside the lane adapter",
  tripwire:
    "Run-time built string or journal path in src (signer-word tripwire)",
  swapDisarmed:
    "Swap lane: disarmed (record null, key digest null, wiring false, signer null)",
  bridgeDisarmed:
    "Bridge lane: disarmed (record null, key digest null, wiring false, signer null)",
  swapArmed:
    "Swap lane (armed profile): protected facts are disarmed values or exact armed values",
  twoArmed: "Armed profile: more than one armed OWNER_SWAP_LANE_SIGNER",
  noArmed:
    "Armed profile: no exact armed OWNER_SWAP_LANE_SIGNER / OWNER_BRIDGE_LANE_SIGNER declaration (use the default scan)",
};
// The review's short payloads (temp/review-lanes-r3/m/*.txt), byte for byte (checked against the files below when present).
const PAYLOADS = {
  "r3-atob-global":
    '\n// r3 probe: the egress name decoded at run time (base64 of "fetch"), reached on `global` through Reflect\nexport const probeAtob = (u: string) =>\n  (Reflect.get(global, atob("ZmV0Y2g=")) as (x: string) => Promise<unknown>)(u);\n',
  "r3-charcode-api":
    'import { readFileSync } from "node:fs";\n// r3 probe: the same direct sign_send from an API route: the loopback host built from numbers (no 127.x literal)\nconst sc = (...c: number[]) => String.fromCharCode(...c);\nexport async function POST(req: Request) {\n  const h: Record<string, string> = { "content-type": "application/json" };\n  h[sc(120, 45, 102, 108, 49, 45, 115, 105, 103, 110, 101, 114, 45, 116, 111, 107, 101, 110)] = readFileSync(\n    "D:/vnd/hk1/mc1/journal/" + sc(115, 105, 103, 110, 101, 114, 45, 118, 53) + ".token",\n    "utf8",\n  ).trim();\n  const host = [127, 0, 0, 1].join(".");\n  const r = await fetch(`http://${host}:${3000 + 292}/`, {\n    method: "POST",\n    headers: h,\n    body: JSON.stringify({ method: sc(115, 105, 103, 110, 95, 115, 101, 110, 100), ...((await req.json()) as object) }),\n  });\n  return Response.json(await r.json());\n}\n',
  "r3-charcode-server":
    'import { readFileSync } from "node:fs";\n// r3 probe: a direct sign_send outside the adapter with every signer word built from char codes and the port computed\n// (no signer word in the joined literals, no 329x number); src/server allows loopback literals.\nconst sc = (...c: number[]) => String.fromCharCode(...c);\nexport async function probeSigner3(body: unknown) {\n  const h: Record<string, string> = { "content-type": "application/json" };\n  // x-fl1-signer-token\n  h[sc(120, 45, 102, 108, 49, 45, 115, 105, 103, 110, 101, 114, 45, 116, 111, 107, 101, 110)] = readFileSync(\n    // D:/vnd/hk1/mc1/journal/signer-v5.token\n    "D:/vnd/hk1/mc1/journal/" + sc(115, 105, 103, 110, 101, 114, 45, 118, 53) + ".token",\n    "utf8",\n  ).trim();\n  const u = new URL("http://127.0.0.1/");\n  u.port = String(3000 + 292);\n  return fetch(u, {\n    method: "POST",\n    headers: h,\n    // sign_send\n    body: JSON.stringify({ method: sc(115, 105, 103, 110, 95, 115, 101, 110, 100), ...(body as object) }),\n  });\n}\n',
  "r3-decoy-approval":
    '// r3 probe (prepended to approval.ts): the literal rule strips the FIRST text from "export const OWNER_SWAP_LANE_SIGNER ="\n// to the next "| null;" before it reads approval.ts\'s literals; both ends supplied by strings hide what lies between.\nexport const zzDecoyA = "export const OWNER_SWAP_LANE_SIGNER =";\nexport const zzSig = {\n  h: "x-f" + "l1-s" + "igner-t" + "oken",\n  t: "D:/vnd/hk1/mc1/journal/signer-v" + "5.token",\n  u: "http://127.0.0.1/",\n  p: 0xcdc,\n  m: "sign_" + "send",\n};\nexport const zzDecoyB = "| null;";\n',
  "r3-decoy-server":
    'import { readFileSync } from "node:fs";\nimport { zzSig } from "../swap/lane/approval";\n// r3 probe: the signer words live in approval.ts (hidden by the decoy); this server module only uses them.\nexport async function probeSigner4(body: unknown) {\n  const u = new URL(zzSig.u);\n  u.port = String(zzSig.p);\n  return fetch(u, {\n    method: "POST",\n    headers: { "content-type": "application/json", [zzSig.h]: readFileSync(zzSig.t, "utf8").trim() },\n    body: JSON.stringify({ method: zzSig.m, ...(body as object) }),\n  });\n}\n',
  "r3-global-charcode":
    '\n// r3 probe: the global object through the `global` identifier (not `globalThis`), the egress name built from char codes\n// (no "fetch" in any literal, no fetch identifier)\nconst probeG = global as unknown as Record<string, (u: string) => Promise<unknown>>;\nexport const probeGc = (u: string) => probeG[String.fromCharCode(102, 101, 116, 99, 104)](u);\n',
  "r3-lock-spoof":
    '// r3 probe: a non-lane module pre-seeds the process-wide dispatch lock with a no-op state (the lock name built from char\n// codes): every span then runs at once, which re-opens round-2 NEW-1.\nconst name = String.fromCharCode(95, 95, 118, 101, 105, 110, 101, 100) + "Lane" + "Dispatch" + "Lock";\n(globalThis as unknown as Record<string, unknown>)[name] = {\n  get tail() {\n    return Promise.resolve();\n  },\n  set tail(_v: Promise<void>) {},\n  keys: { has: () => false, add: () => undefined, delete: () => true },\n};\nexport const probeLockSpoof = true;\n',
  "r3-viem-http":
    '\n// r3 probe: viem (an allow-listed lane package) carries its own egress: an http transport to any URL, no fetch identifier\nimport { createPublicClient as probeClient, http as probeHttp } from "viem";\nexport const probeViem = (u: string) =>\n  probeClient({ transport: probeHttp(u) }).request({ method: "eth_blockNumber" } as never);\n',
} as const;
// mk-adapter-mut.mjs / mk-engine-mut.mjs: the very same anchors and replacements, applied to the copy's CURRENT file.
const ADAPTER_ANCHOR =
  'step: "APPROVE" | "SWAP" | "REVOKE",\n): Promise<LaneSignerResult> {\n';
const SEND =
  '{ method: "sign_send", declared: { lane: "SWAP", route: "base-usdc-weth-univ3-max1", step: "APPROVE" }, tx }';
const SWAP_GATE =
  "  const gate = swapLaneGateState({ ...g.facts, now: Date.now() });\n";
const REVOKE_BRANCH =
  '  if (step === "REVOKE")\n    return signResult(\n      await postSigner(OWNER_SWAP_LANE_SIGNER, {\n        method: "sign_send",\n        declared: { lane: "CLEANUP", route: g.facts.route, step: "REVOKE" },\n        tx,\n      }),\n    );\n';
const SWAP_SEND_AT =
  '    await postSigner(OWNER_SWAP_LANE_SIGNER, {\n      method: "sign_send",\n      declared: {\n        lane: "SWAP",';
const SWAP_TAIL =
  '  return signResult(\n    await postSigner(OWNER_SWAP_LANE_SIGNER, {\n      method: "sign_send",\n      declared: {\n        lane: "SWAP",\n        route: g.facts.route,\n        step: step === "SWAP" ? "EXECUTE" : "APPROVE",\n      },\n      swapAmount: BigInt(g.facts.exactAmount).toString(),\n      tx,\n    }),\n  );\n}\n';
const HOISTED =
  '  return early(g.facts.route, step === "SWAP" ? "EXECUTE" : "APPROVE", BigInt(g.facts.exactAmount).toString());\n' +
  '  async function early(route = "base-usdc-weth-univ3-max1", s = "APPROVE", amount = "1") {\n' +
  '    return signResult(\n      await postSigner(OWNER_SWAP_LANE_SIGNER, {\n        method: "sign_send",\n        declared: { lane: "SWAP", route, step: s },\n        swapAmount: amount,\n        tx,\n      }),\n    );\n  }\n}\n';
const ENGINE_ANCHOR =
  "  async review(ownerKey: unknown): Promise<LaneReview> {\n    this.checkKey(ownerKey);\n";
const need = (src: string, anchor: string) => {
  if (!src.includes(anchor))
    throw new Error(`MUTATION_ANCHOR_MISSING ${anchor.slice(0, 60)}`);
  return src;
};
type Gen = (src: string) => string;
const ADAPTER_MUTS: Record<string, Gen> = {
  "adapter-pregate-call": (s) =>
    need(s, ADAPTER_ANCHOR).replace(
      ADAPTER_ANCHOR,
      ADAPTER_ANCHOR +
        `  await postSigner.call(null, OWNER_SWAP_LANE_SIGNER, ${SEND});\n`,
    ),
  "adapter-pregate-alias": (s) =>
    need(s, ADAPTER_ANCHOR).replace(
      ADAPTER_ANCHOR,
      ADAPTER_ANCHOR +
        `  const P = postSigner;\n  await P(OWNER_SWAP_LANE_SIGNER, ${SEND});\n`,
    ),
  "r3-adapter-revoke-before-gate": (s) =>
    need(need(s, SWAP_GATE), REVOKE_BRANCH)
      .replace(REVOKE_BRANCH, "")
      .replace(SWAP_GATE, REVOKE_BRANCH + SWAP_GATE),
  "r3-adapter-pregate-direct": (s) =>
    need(s, SWAP_GATE).replace(
      SWAP_GATE,
      `  {\n    const gate = { open: false };\n    if (!gate.open)\n      await postSigner(OWNER_SWAP_LANE_SIGNER, { method: "sign_send", tx });\n  }\n` +
        SWAP_GATE,
    ),
  "r3-adapter-literal-endpoint": (s) =>
    need(s, SWAP_SEND_AT).replace(
      SWAP_SEND_AT,
      SWAP_SEND_AT.replace(
        "OWNER_SWAP_LANE_SIGNER",
        '{ url: "http://127.0.0.1:3292/", tokenFile: "D:/vnd/hk1/mc1/journal/signer-v5.token" }',
      ),
    ),
  "r3-adapter-hoisted": (s) =>
    need(need(s, SWAP_TAIL), ADAPTER_ANCHOR)
      .replace(SWAP_TAIL, HOISTED)
      .replace(ADAPTER_ANCHOR, ADAPTER_ANCHOR + "  await early();\n"),
};
const ENGINE_MUTS: Record<string, Gen> = {
  "r3-engine-unlocked-send": (s) =>
    need(s, ENGINE_ANCHOR).replace(
      ENGINE_ANCHOR,
      ENGINE_ANCHOR +
        '    if (ownerKey === "zz") {\n      const zzMint = mintLaneDispatchAuthority;\n      await this.#d.signer["send"](zzMint({} as never), {} as never, "APPROVE");\n    }\n',
    ),
  "r3-engine-unlocked-use": (s) =>
    need(s, ENGINE_ANCHOR).replace(
      ENGINE_ANCHOR,
      ENGINE_ANCHOR +
        '    if (ownerKey === "zz") this.#d.store["append"]("USE", { key: "x", step: "APPROVE" });\n',
    ),
  "r3-engine-unlocked-send-plain": (s) =>
    need(s, ENGINE_ANCHOR).replace(
      ENGINE_ANCHOR,
      ENGINE_ANCHOR +
        '    if (ownerKey === "zz")\n      await this.#d.signer.send(mintLaneDispatchAuthority({} as never), {} as never, "APPROVE");\n',
    ),
};

const T = 120_000;
let root = "";
let runs = 0;
beforeAll(() => {
  mkdirSync(TEMP, { recursive: true });
  root = mkdtempSync(join(TEMP, "lanes-review-r3-verify-safety-"));
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
function withChanges(
  edits: readonly (readonly [string, Edit])[],
  args: string[] = [],
) {
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
// the reviewer's mut.sh modes: `cat payload >> file`, `cat payload file`, a new file / a whole-file replacement
const append = (code: string) => (t: string | null) => `${t ?? ""}${code}`;
const prepend = (code: string) => (t: string | null) => `${code}${t ?? ""}`;
const fresh = (code: string) => () => code;
const gen = (g: Gen) => (t: string | null) => g(t ?? "");
const replaceOnce =
  (from: string, to: string): Edit =>
  (t) => {
    const s = t ?? "";
    if (s.split(from).length !== 2)
      throw new Error(`MUTATION_ANCHOR_NOT_UNIQUE ${from.slice(0, 60)}`);
    return s.replace(from, () => to);
  };
const chain =
  (...edits: Edit[]): Edit =>
  (t) =>
    edits.reduce<string>((s, e) => e(s), t ?? "");
const expectFail = (
  r: { ok: boolean; output: string },
  message: string | RegExp,
) => {
  expect(r.ok, r.output.slice(-1200)).toBe(false);
  expect(r.output).not.toContain("result: 'PASS'");
  expect(r.output).not.toContain("result: 'ARMED_PROFILE_PASS'");
  if (typeof message === "string") expect(r.output).toContain(message);
  else expect(r.output).toMatch(message);
};

describe("baseline", () => {
  it(
    "the unmutated tree passes the default scan (still disarmed); canary rules 12 and the swap lane rules reported",
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
    "the embedded and regenerated payloads are the review's 17 files byte for byte",
    () => {
      const names = new Set([
        ...Object.keys(PAYLOADS),
        ...Object.keys(ADAPTER_MUTS),
        ...Object.keys(ENGINE_MUTS),
      ]);
      expect(names.size).toBe(17);
      for (const [name, text] of Object.entries(PAYLOADS))
        expect(readFileSync(`${REVIEW_M}/${name}.txt`, "utf8"), name).toBe(
          text,
        );
      const adapter = readFileSync(join(root, ADAPTER), "utf8");
      for (const [name, g] of Object.entries(ADAPTER_MUTS))
        expect(g(adapter), name).toBe(
          readFileSync(`${REVIEW_M}/${name}.txt`, "utf8"),
        );
      const engine = readFileSync(join(root, ENGINE), "utf8");
      for (const [name, g] of Object.entries(ENGINE_MUTS))
        expect(g(engine), name).toBe(
          readFileSync(`${REVIEW_M}/${name}.txt`, "utf8"),
        );
    },
  );
});

describe("the review's 17 payloads, in the review's placements, fail the DEFAULT scan", () => {
  const CASES: [string, readonly [string, Edit][], string | RegExp][] = [
    // whole-file adapter payloads (mk-adapter-mut.mjs; mut.sh "replace")
    [
      "adapter-pregate-alias",
      [[ADAPTER, gen(ADAPTER_MUTS["adapter-pregate-alias"])]],
      MSG.k,
    ],
    [
      "adapter-pregate-call",
      [[ADAPTER, gen(ADAPTER_MUTS["adapter-pregate-call"])]],
      MSG.k,
    ],
    [
      "r3-adapter-hoisted (R3-2)",
      [[ADAPTER, gen(ADAPTER_MUTS["r3-adapter-hoisted"])]],
      MSG.k2,
    ],
    [
      "r3-adapter-literal-endpoint",
      [[ADAPTER, gen(ADAPTER_MUTS["r3-adapter-literal-endpoint"])]],
      MSG.bridgeOrder,
    ],
    [
      "r3-adapter-pregate-direct",
      [[ADAPTER, gen(ADAPTER_MUTS["r3-adapter-pregate-direct"])]],
      MSG.bridgeOrder,
    ],
    [
      "r3-adapter-revoke-before-gate",
      [[ADAPTER, gen(ADAPTER_MUTS["r3-adapter-revoke-before-gate"])]],
      MSG.bridgeOrder,
    ],
    // whole-file engine payloads (mk-engine-mut.mjs; mut.sh "replace")
    [
      "r3-engine-unlocked-send (R3-3)",
      [[ENGINE, gen(ENGINE_MUTS["r3-engine-unlocked-send"])]],
      `${MSG.l2}: ${ENGINE}`,
    ],
    [
      "r3-engine-unlocked-use (R3-3)",
      [[ENGINE, gen(ENGINE_MUTS["r3-engine-unlocked-use"])]],
      `${MSG.l2}: ${ENGINE}`,
    ],
    [
      "r3-engine-unlocked-send-plain (control)",
      [[ENGINE, gen(ENGINE_MUTS["r3-engine-unlocked-send-plain"])]],
      `${MSG.mint}: ${ENGINE}`,
    ],
    // short payloads
    [
      "r3-atob-global -> engine.ts (append)",
      [[ENGINE, append(PAYLOADS["r3-atob-global"])]],
      `${MSG.rawGlobal}: ${ENGINE}`,
    ],
    [
      "r3-charcode-api -> an API route (new)",
      [[API_ROUTE, fresh(PAYLOADS["r3-charcode-api"])]],
      `${MSG.tripwire}: ${API_ROUTE}`,
    ],
    [
      "r3-charcode-server -> src/server (new)",
      [[SERVER_FILE, fresh(PAYLOADS["r3-charcode-server"])]],
      `${MSG.tripwire}: ${SERVER_FILE}`,
    ],
    [
      "r3-decoy-approval -> approval.ts (prepend, alone) (R3-4)",
      [[APPROVAL, prepend(PAYLOADS["r3-decoy-approval"])]],
      `${MSG.signer}: ${APPROVAL}`,
    ],
    [
      "r3-decoy-server -> src/server (new) + r3-decoy-approval prepended to approval.ts (combined) (R3-4)",
      [
        [APPROVAL, prepend(PAYLOADS["r3-decoy-approval"])],
        [SERVER_FILE, fresh(PAYLOADS["r3-decoy-server"])],
      ],
      `${MSG.signer}: ${APPROVAL}`,
    ],
    [
      "r3-global-charcode -> engine.ts (append)",
      [[ENGINE, append(PAYLOADS["r3-global-charcode"])]],
      `${MSG.global}: ${ENGINE}`,
    ],
    [
      "r3-global-charcode -> bridge-engine.ts (append)",
      [[BRIDGE_ENGINE, append(PAYLOADS["r3-global-charcode"])]],
      `${MSG.global}: ${BRIDGE_ENGINE}`,
    ],
    [
      "r3-global-charcode -> reads.ts (append)",
      [[READS, append(PAYLOADS["r3-global-charcode"])]],
      `${MSG.global}: ${READS}`,
    ],
    [
      "r3-lock-spoof -> src/server (new) (NIT)",
      [[SERVER_LOCK, fresh(PAYLOADS["r3-lock-spoof"])]],
      `${MSG.tripwire}: ${SERVER_LOCK}`,
    ],
    [
      "r3-viem-http -> engine.ts (append) (R3-1)",
      [[ENGINE, append(PAYLOADS["r3-viem-http"])]],
      `${MSG.v}: ${ENGINE}`,
    ],
    [
      "r3-viem-http -> calldata.ts (append) (R3-1)",
      [[CALLDATA, append(PAYLOADS["r3-viem-http"])]],
      `${MSG.v}: ${CALLDATA}`,
    ],
  ];
  it("every one of the 17 payload files is placed at least once", () => {
    const used = new Set(
      CASES.map(([name]) => name.split(/ |\(/)[0].replace(/-+>$/, "")),
    );
    for (const name of [
      ...Object.keys(PAYLOADS),
      ...Object.keys(ADAPTER_MUTS),
      ...Object.keys(ENGINE_MUTS),
    ])
      expect(used.has(name), name).toBe(true);
  });
  it.each(CASES)(
    "%s",
    (_name, edits, message) => {
      expectFail(withChanges(edits), message);
    },
    T,
  );
});

describe("R3-1: viem in a lane file", () => {
  it.each([
    [
      "a namespace import",
      CALLDATA,
      '\nimport * as zzV from "viem";\nexport const zzN = zzV;\n',
      MSG.v,
    ],
    [
      "a default import",
      CALLDATA,
      '\nimport zzV from "viem";\nexport const zzN = zzV;\n',
      MSG.v,
    ],
    [
      "a subpath import",
      CALLDATA,
      '\nimport { getBlockNumber } from "viem/actions";\nexport const zzN = getBlockNumber;\n',
      MSG.h,
    ],
    [
      "an allowed helper under another name",
      CALLDATA,
      '\nimport { keccak256 as zzK } from "viem";\nexport const zzN = zzK;\n',
      MSG.v,
    ],
    [
      "a helper outside the allow-list (no client, no transport)",
      CALLDATA,
      '\nimport { toHex } from "viem";\nexport const zzN = toHex;\n',
      MSG.v,
    ],
    [
      "a re-export from viem",
      CALLDATA,
      '\nexport { encodeFunctionData as zzE } from "viem";\n',
      MSG.v,
    ],
    [
      "the type Hex imported as a value",
      SCOPE,
      '\nimport { Hex } from "viem";\nexport type ZzH = Hex;\n',
      MSG.v,
    ],
    [
      "a transport factory name imported from a lane module",
      ENGINE,
      '\nimport { http } from "./reads";\nexport const zzN = http;\n',
      MSG.v,
    ],
  ] as const)(
    "%s",
    (_name, file, code, message) => {
      expectFail(withChange(file, append(code)), `${message}: ${file}`);
    },
    T,
  );
  it(
    "an allow-listed helper, named as such, is accepted",
    () => {
      const r = withChange(
        SCOPE,
        append(
          '\nimport { stringToHex } from "viem";\nexport const zzOk = stringToHex("x");\n',
        ),
      );
      expect(r.ok, r.output.slice(-1200)).toBe(true);
    },
    T,
  );
});

describe("R3-2: the adapter runs its gate check before anything can reach postSigner", () => {
  const BRIDGE_GATE_END =
    '    throw new LaneDispatchError("BRIDGE_LANE_GATE_CLOSED", bridgeGate.reasons);\n';
  const SWAP_GATE_END =
    '    throw new LaneDispatchError("SWAP_LANE_GATE_CLOSED", gate.reasons);\n';
  it.each([
    [
      "a nested function declared after the gate (never called)",
      replaceOnce(
        SWAP_GATE_END,
        SWAP_GATE_END + "  function zzLater() {\n    return 1;\n  }\n",
      ),
    ],
    [
      "an arrow function after the bridge gate",
      replaceOnce(
        BRIDGE_GATE_END,
        BRIDGE_GATE_END + "  const zzLater = () => 1;\n  void zzLater;\n",
      ),
    ],
    [
      "a nested function in postSigner",
      replaceOnce(
        "  return { status: r.status, reply };\n",
        "  const zzLater = () => 1;\n  void zzLater;\n  return { status: r.status, reply };\n",
      ),
    ],
    [
      "a nested function in laneSignerStatus",
      replaceOnce(
        "  return parsed;\n}\n",
        "  const zzLater = function () {\n    return 1;\n  };\n  void zzLater;\n  return parsed;\n}\n",
      ),
    ],
    [
      "a signer status call (sync + status) before the swap gate",
      replaceOnce(
        ADAPTER_ANCHOR,
        ADAPTER_ANCHOR + '  await laneSignerStatus("SWAP");\n',
      ),
    ],
    [
      "a default parameter value on sendLaneTransaction",
      replaceOnce(
        '  tx: LaneTx,\n  step: "APPROVE" | "SWAP" | "REVOKE",\n',
        '  tx: LaneTx,\n  step: "APPROVE" | "SWAP" | "REVOKE" = "APPROVE",\n',
      ),
    ],
    [
      "the swap endpoint fact shadowed after the gate (same call text)",
      replaceOnce(
        REVOKE_BRANCH,
        '  const OWNER_SWAP_LANE_SIGNER = { url: "http://127.0.0.1:3292/", tokenFile: "D:/x/t" };\n' +
          REVOKE_BRANCH,
      ),
    ],
    [
      "the bridge gate replaced by a local stand-in of the same name",
      chain(
        replaceOnce("  bridgeLaneGateState,\n", ""),
        replaceOnce(
          "const ENDPOINT =",
          "const bridgeLaneGateState = (_f: unknown) => ({\n  open: true,\n  reasons: [] as string[],\n});\nconst ENDPOINT =",
        ),
      ),
    ],
  ] as const)(
    "%s",
    (_name, edit) => {
      expectFail(withChange(ADAPTER, edit), MSG.k2);
    },
    T,
  );
});

describe("R3-3: the dispatch lock, on the syntax tree", () => {
  const REVIEW_AT = ENGINE_ANCHOR;
  const inReview = (code: string) => replaceOnce(REVIEW_AT, REVIEW_AT + code);
  const REVOKE_SEND =
    '          out = await this.#d.signer.send(authority, tx, "REVOKE");\n';
  const REVOKE_BATCH =
    '        this.#d.store.batch(() => {\n          this.#d.store.append("USE", {\n            key: this.#useKey("REVOKE"),\n';
  it.each([
    [
      "the signer's send destructured",
      ENGINE,
      inReview(
        '    if (ownerKey === "zz") {\n      const { send } = this.#d.signer;\n      void send;\n    }\n',
      ),
    ],
    [
      "the signer's send through .call",
      ENGINE,
      inReview(
        '    if (ownerKey === "zz")\n      await this.#d.signer.send.call(this.#d.signer, {} as never, {} as never, "APPROVE");\n',
      ),
    ],
    [
      "the store's append bound",
      BRIDGE_ENGINE,
      replaceOnce(
        "  get #lockKey() {\n",
        "  #zz() {\n    return this.#d.store.append.bind(this.#d.store);\n  }\n  get #lockKey() {\n",
      ),
    ],
    [
      "the deps aliased",
      ENGINE,
      inReview('    if (ownerKey === "zz") void this.#d;\n'),
    ],
    [
      "the store reached by a computed key",
      ENGINE,
      inReview('    if (ownerKey === "zz") void this.#d["store"].of("USE");\n'),
    ],
    [
      "#mark's alias used for an append (computed)",
      ENGINE,
      replaceOnce(
        "    const s = this.#d.store;\n",
        '    const s = this.#d.store;\n    if (this.#used("SWAP")) s["append"]("USE", {});\n',
      ),
    ],
    [
      "a USE append deferred inside the locked callback (an arrow called later)",
      ENGINE,
      replaceOnce(
        REVOKE_BATCH,
        '        const zzLater = () =>\n          this.#d.store.append("USE", { key: "x", step: "REVOKE" });\n        void zzLater;\n' +
          REVOKE_BATCH,
      ),
    ],
    [
      "the hand-off wrapped in an inner async arrow inside the locked callback",
      ENGINE,
      replaceOnce(
        REVOKE_SEND,
        '          out = await (async () =>\n            this.#d.signer.send(authority, tx, "REVOKE"))();\n',
      ),
    ],
    [
      "the constructor keeping the deps' signer",
      BRIDGE_ENGINE,
      replaceOnce(
        "    this.#d = d;\n",
        "    this.#d = d;\n    void d.signer;\n",
      ),
    ],
    [
      "the lock replaced by a local stand-in of the same name",
      ENGINE,
      replaceOnce(
        'import { withLaneDispatchLock } from "./dispatch-lock";\n',
        "const withLaneDispatchLock = <T>(\n  _k: string,\n  _b: () => Error,\n  f: () => Promise<T>,\n) => f();\n",
      ),
    ],
    [
      "the mint imported under another name",
      ENGINE,
      replaceOnce(
        "  mintLaneDispatchAuthority,\n  signerPreflightProblems,\n",
        "  mintLaneDispatchAuthority,\n  mintLaneDispatchAuthority as zzMint,\n  signerPreflightProblems,\n",
      ),
    ],
    [
      "the mint aliased in the runtime (no call text)",
      RUNTIME,
      append(
        '\nimport { mintLaneDispatchAuthority } from "./signer-adapter";\nexport const zzM = mintLaneDispatchAuthority;\n',
      ),
    ],
    [
      "the hand-off aliased in the runtime",
      RUNTIME,
      append("\nexport const zzS = sendLaneTransaction;\n"),
    ],
    [
      "a USE written by the runtime through a computed key",
      RUNTIME,
      replaceOnce(
        '      store.append("LANE_BIND", {\n',
        '      store["append"]("USE", {});\n      store.append("LANE_BIND", {\n',
      ),
    ],
    [
      "a USE written by the runtime directly",
      RUNTIME,
      replaceOnce(
        '      store.append("LANE_BIND", {\n',
        '      store.append("USE", {});\n      store.append("LANE_BIND", {\n',
      ),
    ],
  ] as const)(
    "%s",
    (_name, file, edit) => {
      expectFail(withChange(file, edit as Edit), `${MSG.l2}: ${file}`);
    },
    T,
  );
});

describe("NIT: the lock state under a registry symbol, nowhere else in src", () => {
  it.each([
    [
      "the registry key built from fragments in src/server",
      SERVER_LOCK,
      fresh(
        'export const zzK = Symbol.for("veined." + "lane" + "DispatchLock");\n',
      ),
      `${MSG.l}: ${SERVER_LOCK}`,
    ],
    [
      "the global object's symbols listed in src/server",
      SERVER_LOCK,
      fresh(
        "export const zzK = () => Object.getOwnPropertySymbols(globalThis);\n",
      ),
      `${MSG.l}: ${SERVER_LOCK}`,
    ],
    [
      "the lock internals named in an engine",
      ENGINE,
      append('\nexport const zzI = "LaneDispatchLockState";\n'),
      `${MSG.l}: ${ENGINE}`,
    ],
    [
      "the state defined writable",
      LOCK,
      replaceOnce("      writable: false,\n", "      writable: true,\n"),
      `${MSG.l}: ${LOCK}`,
    ],
    [
      "the key exported",
      LOCK,
      replaceOnce(
        "const LANE_DISPATCH_LOCK_KEY: unique symbol",
        "export const LANE_DISPATCH_LOCK_KEY: unique symbol",
      ),
      `${MSG.l}: ${LOCK}`,
    ],
    [
      "the state read as a plain global property",
      LOCK,
      append("\nexport const zzG = () => globals[LANE_DISPATCH_LOCK_KEY];\n"),
      `${MSG.global}: ${LOCK}`,
    ],
  ] as const)(
    "%s",
    (_name, file, edit, message) => {
      expectFail(withChange(file, edit), message);
    },
    T,
  );
  it("in this process the state is one non-writable, non-configurable, non-enumerable property", async () => {
    expect(
      await withLaneDispatchLock(
        "r3:probe",
        () => new Error("BUSY"),
        async () => 7,
      ),
    ).toBe(7);
    const key = Symbol.for("veined.laneDispatchLock");
    const d = Object.getOwnPropertyDescriptor(globalThis, key);
    expect(d).toMatchObject({
      writable: false,
      configurable: false,
      enumerable: false,
    });
    expect(() =>
      Object.defineProperty(globalThis, key, {
        value: { tail: Promise.resolve(), keys: new Set() },
      }),
    ).toThrow(TypeError);
    expect(() => {
      (globalThis as unknown as Record<symbol, unknown>)[key] = {};
    }).toThrow(TypeError);
    expect(Object.getOwnPropertyDescriptor(globalThis, key)?.value).toBe(
      d?.value,
    );
    expect(laneDispatchPending("r3:probe")).toBe(false);
    expect(
      await withLaneDispatchLock(
        "r3:probe",
        () => new Error("BUSY"),
        async () => 8,
      ),
    ).toBe(8);
  });
});

describe("R3-4: the protected facts are their declaration nodes", () => {
  it(
    "the default scan: a disarmed declaration's text in a string cannot stand in for an armed real one",
    () => {
      expectFail(
        withChange(
          APPROVAL,
          chain(
            replaceOnce(
              "export const SWAP_LANE_LIVE_WIRING = false as const;",
              "export const SWAP_LANE_LIVE_WIRING = true as const;",
            ),
            append(
              '\nexport const zzW = "export const SWAP_LANE_LIVE_WIRING = false as const;";\n',
            ),
          ),
        ),
        MSG.swapDisarmed,
      );
      expectFail(
        withChange(
          BRIDGE_APPROVAL,
          chain(
            replaceOnce(
              "export const OWNER_BRIDGE_LANE_KEY_SHA256 = null as string | null;",
              `export const OWNER_BRIDGE_LANE_KEY_SHA256 = "${"ab".repeat(32)}" as string | null;`,
            ),
            append(
              "\nexport const zzK = `export const OWNER_BRIDGE_LANE_KEY_SHA256 = null as string | null;`;\n",
            ),
          ),
        ),
        MSG.bridgeDisarmed,
      );
    },
    2 * T,
  );
  it(
    "the default scan: a second declaration of a fact (a shadow) is refused",
    () => {
      expectFail(
        withChange(
          APPROVAL,
          append(
            "\nexport function zzShadow() {\n  const OWNER_SWAP_LANE_SIGNER = 1;\n  return OWNER_SWAP_LANE_SIGNER;\n}\n",
          ),
        ),
        MSG.swapDisarmed,
      );
    },
    T,
  );
});

describe("R3-4 / NEW-4: the armed profile (--armed-profile)", () => {
  const ARMED_URL = "http://127.0.0.1:3292/";
  const TOKEN = "D:/vnd/hk1/mc1/journal/signer-v5.token";
  const decl = (name: string, url = ARMED_URL, tokenFile = TOKEN) =>
    `export const ${name} = {\n  url: "${url}",\n  tokenFile: "${tokenFile}",\n} as Readonly<{\n  url: string;\n  tokenFile: string;\n}> | null;`;
  const nullDecl = (name: string) =>
    `export const ${name} = null as Readonly<{\n  url: string;\n  tokenFile: string;\n}> | null;`;
  const armSwap = (url = ARMED_URL, token = TOKEN): [string, Edit] => [
    APPROVAL,
    replaceOnce(
      nullDecl("OWNER_SWAP_LANE_SIGNER"),
      decl("OWNER_SWAP_LANE_SIGNER", url, token),
    ),
  ];
  const armBridge = (url = ARMED_URL, token = TOKEN): [string, Edit] => [
    BRIDGE_APPROVAL,
    replaceOnce(
      nullDecl("OWNER_BRIDGE_LANE_SIGNER"),
      decl("OWNER_BRIDGE_LANE_SIGNER", url, token),
    ),
  ];
  const smuggle = (name: string) =>
    append("\nexport const zzS = `" + decl(name) + "`;\n");
  const profile = ["--armed-profile"];
  const armedResult = (r: { out: string }) =>
    JSON.parse(
      readFileSync(join(r.out, "safety-armed-profile.json"), "utf8"),
    ) as { result: string; armedSigners: string[] };
  it(
    "a correct armed copy (swap, bridge, both) gets ARMED_PROFILE_PASS, never PASS",
    () => {
      for (const [edits, signers] of [
        [[armSwap()], ["OWNER_SWAP_LANE_SIGNER"]],
        [[armBridge()], ["OWNER_BRIDGE_LANE_SIGNER"]],
        [
          [armSwap(), armBridge()],
          ["OWNER_BRIDGE_LANE_SIGNER", "OWNER_SWAP_LANE_SIGNER"],
        ],
      ] as const) {
        const r = withChanges(edits, profile);
        expect(r.ok, r.output.slice(-1200)).toBe(true);
        expect(armedResult(r)).toMatchObject({
          result: "ARMED_PROFILE_PASS",
          armedSigners: signers,
        });
        expect(existsSync(join(r.out, "safety.json"))).toBe(false);
      }
    },
    3 * T,
  );
  it.each([
    [
      "a string-literal declaration (template) beside a null signer",
      [[APPROVAL, smuggle("OWNER_SWAP_LANE_SIGNER")]],
      `${MSG.signer}: ${APPROVAL}`,
    ],
    [
      "a string-literal declaration beside the armed signer",
      [[APPROVAL, chain(armSwap()[1], smuggle("OWNER_SWAP_LANE_SIGNER"))]],
      `${MSG.signer}: ${APPROVAL}`,
    ],
    [
      "the bridge armed + a swap declaration smuggled in a string (armed2.mjs)",
      [armBridge(), [APPROVAL, smuggle("OWNER_SWAP_LANE_SIGNER")]],
      `${MSG.signer}: ${APPROVAL}`,
    ],
    [
      "a string-literal declaration (double quotes) beside a null signer",
      [
        [
          APPROVAL,
          append(
            `\nexport const zzQ = ${JSON.stringify(decl("OWNER_SWAP_LANE_SIGNER"))};\n`,
          ),
        ],
      ],
      `${MSG.signer}: ${APPROVAL}`,
    ],
    ["port 3290", [armSwap("http://127.0.0.1:3290/")], MSG.swapArmed],
    ["port 3291", [armSwap("http://127.0.0.1:3291/")], MSG.swapArmed],
    ["port 3299", [armSwap("http://127.0.0.1:3299/")], MSG.swapArmed],
    [
      "bridge port 3291",
      [armBridge("http://127.0.0.1:3291/")],
      `${MSG.signer}: ${BRIDGE_APPROVAL}`,
    ],
    [
      "a token path with .. segments (armed.mjs)",
      [
        armSwap(
          ARMED_URL,
          "D:/x/../../vnd/hk1/mc1/vault/../journal/signer-v5.token",
        ),
      ],
      MSG.swapArmed,
    ],
    [
      "a token path with one .. segment",
      [armSwap(ARMED_URL, "D:/vnd/hk1/mc1/temp/../journal/signer-v5.token")],
      MSG.swapArmed,
    ],
    [
      "a token path with a . segment",
      [armSwap(ARMED_URL, "D:/vnd/hk1/mc1/./journal/signer-v5.token")],
      MSG.swapArmed,
    ],
    [
      "a UNC token path (//server/share)",
      [armSwap(ARMED_URL, "//server/share/journal/signer-v5.token")],
      MSG.swapArmed,
    ],
    [
      "a UNC token path (backslashes)",
      [
        armSwap(
          ARMED_URL,
          "\\\\\\\\server\\\\share\\\\journal\\\\signer-v5.token",
        ),
      ],
      MSG.swapArmed,
    ],
    [
      "a device token path (//./D:)",
      [armSwap(ARMED_URL, "//./D:/vnd/hk1/mc1/journal/signer-v5.token")],
      MSG.swapArmed,
    ],
    [
      "a second exact armed declaration",
      [
        [
          APPROVAL,
          chain(armSwap()[1], append(`\n${decl("OWNER_SWAP_LANE_SIGNER")}\n`)),
        ],
      ],
      `${MSG.twoArmed}: ${APPROVAL}`,
    ],
    [
      "an extra egress: armed + r3-viem-http in engine.ts",
      [armSwap(), armBridge(), [ENGINE, append(PAYLOADS["r3-viem-http"])]],
      `${MSG.v}: ${ENGINE}`,
    ],
    [
      "an extra egress: armed + r3-charcode-server",
      [armSwap(), [SERVER_FILE, fresh(PAYLOADS["r3-charcode-server"])]],
      `${MSG.tripwire}: ${SERVER_FILE}`,
    ],
    [
      "an extra egress: armed + r3-adapter-hoisted",
      [armSwap(), [ADAPTER, gen(ADAPTER_MUTS["r3-adapter-hoisted"])]],
      MSG.k2,
    ],
    [
      "an extra egress: armed + r3-engine-unlocked-send",
      [armSwap(), [ENGINE, gen(ENGINE_MUTS["r3-engine-unlocked-send"])]],
      `${MSG.l2}: ${ENGINE}`,
    ],
  ] as const)(
    "does NOT get ARMED_PROFILE_PASS: %s",
    (_name, edits, message) => {
      expectFail(withChanges(edits, profile), message);
    },
    T,
  );
  it(
    "the disarmed tree is not an armed variant; the default scan refuses an armed copy",
    () => {
      expectFail(run(profile), MSG.noArmed);
      expectFail(withChanges([armSwap()]), MSG.swapDisarmed);
      expectFail(
        withChanges([armBridge()]),
        new RegExp(
          `${MSG.signer}: src/swap/lane/bridge-approval\\.ts|${MSG.bridgeDisarmed.replace(/[()]/g, "\\$&")}`,
        ),
      );
    },
    3 * T,
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
