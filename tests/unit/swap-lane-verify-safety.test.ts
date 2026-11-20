// VEINED-FIN-LIVE-20261115-01 (SWAP-LIVE-01): end-to-end regression tests for rule 13 of scripts/verify-safety.mjs
// (the SEPARATE swap lane). Mirrors tests/unit/verify-safety-regression.test.ts: the REAL script runs against a
// temporary copy of the scanned tree (src, services, packages, .env.example, package.json) with exactly the injected
// change(s), and every file is restored exactly afterwards. The unmutated copy passes; every mutation fails with the
// rule's own message. The copy lives under the run's temp directory (D:/vnd/hk1/fl1/temp when tools/env.sh is sourced).
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
const APPROVAL = `${LANE}/approval.ts`;
const ADAPTER = `${LANE}/signer-adapter.ts`;
const ENGINE = `${LANE}/engine.ts`;
const RUNTIME = `${LANE}/runtime.ts`;
const READS = `${LANE}/reads.ts`;
const TRANSPORT = `${LANE}/transport.ts`;
const SCOPE = `${LANE}/scope.ts`;
const ROUTE = "src/app/api/swap-lane/route.ts";
const MSG = {
  disarmed:
    "Swap lane: disarmed (record null, key digest null, wiring false, signer null)",
  mint: "Swap lane dispatch authority minted outside the engine",
  send: "Swap lane signer hand-off outside the runtime",
  runtime: "Swap lane runtime reached outside its route",
  permit:
    "Swap lane: no Permit2, permit, typed data, raw broadcast or key material",
  canary:
    "Swap lane: never reuses the Bridge canary's record, engine, runtime or the browser wallet send path",
  fetch: "Swap lane: chain reads only through the egress-checked transport",
  order:
    "Swap lane: single-use authority, exact tx, gate re-run and loopback-only signer before anything is sent",
  route: "Swap lane API: WRITE_DISABLED before the runtime while not armed",
  scope: "Swap lane: scope bounds and router / selector pins",
  transport:
    'Swap lane transport: pool URL by index only, one fetch, redirect "error", no-store, size cap',
  pool: "Swap lane RPC pool: two exact https sources of two different operators per chain",
  fetchId:
    "Swap lane: the fetch identifier outside the adapter and the lane transport",
  missing: "Swap lane file missing",
};
const T = 120_000;
let root = "";
let runs = 0;

beforeAll(() => {
  mkdirSync(TEMP, { recursive: true });
  root = mkdtempSync(join(TEMP, "swap-lane-verify-safety-"));
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
/** Several files changed (or added / removed) at once, the script run once, every file restored exactly. */
function withChanges(
  changes: [string, (text: string | null) => string | null][],
) {
  const saved = changes.map(([file]) => {
    const p = join(root, file);
    return [p, existsSync(p) ? readFileSync(p, "utf8") : null] as const;
  });
  try {
    for (const [file, edit] of changes) {
      const p = join(root, file);
      const next = edit(existsSync(p) ? readFileSync(p, "utf8") : null);
      if (next === null) rmSync(p);
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, next);
      }
    }
    return run();
  } finally {
    for (const [p, before] of [...saved].reverse()) {
      if (before === null) rmSync(p, { force: true });
      else writeFileSync(p, before);
    }
  }
}
const withChange = (
  file: string,
  edit: (text: string | null) => string | null,
) => withChanges([[file, edit]]);
const addFile = (file: string, text: string) => withChange(file, () => text);
const replaceOnce =
  (from: string | RegExp, to: string) => (t: string | null) => {
    const text = t ?? "";
    const next = text.replace(from, to);
    if (next === text)
      throw new Error(`MUTATION_ANCHOR_MISSING ${String(from)}`);
    return next;
  };
const append = (code: string) => (t: string | null) => `${t ?? ""}\n${code}\n`;
const expectFail = (r: { ok: boolean; output: string }, message: string) => {
  expect(r.ok, r.output.slice(-800)).toBe(false);
  expect(r.output).toContain(message);
};

describe("verify-safety rule 13 (swap lane) baseline", () => {
  it(
    "the unmutated tree passes",
    () => {
      const r = run();
      expect(r.ok, r.output.slice(-800)).toBe(true);
      expect(r.output).toContain("PASS");
      const out = JSON.parse(
        readFileSync(join(root, `.out-${runs}`, "safety.json"), "utf8"),
      ) as { g14Canary: { rules: number }; swapLane: { rules: number } };
      // The canary keeps its 12 rules (the protected regression test pins that); the lanes report their own rule 13
      // (swap) and 13b (VEINED-MC1 bridge) in the separate swapLane field.
      expect(out.g14Canary.rules).toBe(12);
      expect(out.swapLane.rules).toBe(2);
    },
    T,
  );
  it(
    "the copy is restored exactly after a mutation",
    () => {
      const before = readFileSync(join(root, APPROVAL), "utf8");
      expectFail(
        withChange(
          APPROVAL,
          replaceOnce(
            "export const SWAP_LANE_LIVE_WIRING = false as const;",
            "export const SWAP_LANE_LIVE_WIRING = true as const;",
          ),
        ),
        MSG.disarmed,
      );
      expect(readFileSync(join(root, APPROVAL), "utf8")).toBe(before);
      expect(run().ok).toBe(true);
    },
    2 * T,
  );
});

describe("the four protected facts must stay disarmed", () => {
  it(
    "OWNER_SWAP_LANE_APPROVAL armed (a record instead of null)",
    () => {
      expectFail(
        withChange(
          APPROVAL,
          replaceOnce(
            /export const OWNER_SWAP_LANE_APPROVAL =\s*null as Readonly<OwnerSwapLaneApproval> \| null;/,
            'export const OWNER_SWAP_LANE_APPROVAL = Object.freeze({ version: "veined.swap-lane.approval.v1" }) as unknown as Readonly<OwnerSwapLaneApproval> | null;',
          ),
        ),
        MSG.disarmed,
      );
    },
    T,
  );
  it(
    "OWNER_SWAP_LANE_KEY_SHA256 set",
    () => {
      expectFail(
        withChange(
          APPROVAL,
          replaceOnce(
            "export const OWNER_SWAP_LANE_KEY_SHA256 = null as string | null;",
            `export const OWNER_SWAP_LANE_KEY_SHA256 = "${"d".repeat(64)}" as string | null;`,
          ),
        ),
        MSG.disarmed,
      );
    },
    T,
  );
  it(
    "SWAP_LANE_LIVE_WIRING true",
    () => {
      expectFail(
        withChange(
          APPROVAL,
          replaceOnce(
            "export const SWAP_LANE_LIVE_WIRING = false as const;",
            "export const SWAP_LANE_LIVE_WIRING = true as const;",
          ),
        ),
        MSG.disarmed,
      );
    },
    T,
  );
  it(
    "OWNER_SWAP_LANE_SIGNER set",
    () => {
      expectFail(
        withChange(
          APPROVAL,
          replaceOnce(
            "export const OWNER_SWAP_LANE_SIGNER = null as Readonly<{",
            'export const OWNER_SWAP_LANE_SIGNER = { url: "http://127.0.0.1:8545/", tokenFile: "t" } as Readonly<{',
          ),
        ),
        MSG.disarmed,
      );
    },
    T,
  );
  it(
    "a disarmed literal only in a comment does not count (the armed value is the code)",
    () => {
      expectFail(
        withChange(
          APPROVAL,
          replaceOnce(
            "export const SWAP_LANE_LIVE_WIRING = false as const;",
            "// export const SWAP_LANE_LIVE_WIRING = false as const;\nexport const SWAP_LANE_LIVE_WIRING = true as const;",
          ),
        ),
        MSG.disarmed,
      );
    },
    T,
  );
});

describe("the one engine-only dispatch authority and the one runtime-only signer hand-off", () => {
  it(
    "a second mintLaneDispatchAuthority( call in another lane file",
    () => {
      expectFail(
        withChange(
          RUNTIME,
          append(
            'import { mintLaneDispatchAuthority } from "./signer-adapter";\nexport const leak = () => mintLaneDispatchAuthority(null as never);',
          ),
        ),
        `${MSG.mint}: ${RUNTIME}`,
      );
    },
    T,
  );
  it(
    "a mintLaneDispatchAuthority( call in a new file outside the lane",
    () => {
      const file = "src/app/api/swap-lane/mint.ts";
      expectFail(
        addFile(
          file,
          'import { mintLaneDispatchAuthority } from "../../../swap/lane/signer-adapter";\nexport const leak = () => mintLaneDispatchAuthority(null as never);\n',
        ),
        `${MSG.mint}: ${file}`,
      );
    },
    T,
  );
  it(
    "a second mintLaneDispatchAuthority( call inside engine.ts",
    () => {
      expectFail(
        withChange(
          ENGINE,
          append(
            "export const twice = () => mintLaneDispatchAuthority(null as never);",
          ),
        ),
        `${MSG.mint}: ${ENGINE}`,
      );
    },
    T,
  );
  it(
    "sendLaneTransaction( called from engine.ts",
    () => {
      expectFail(
        withChange(
          ENGINE,
          append(
            'import { sendLaneTransaction } from "./signer-adapter";\nexport const direct = () => sendLaneTransaction(null, null as never, "APPROVE");',
          ),
        ),
        `${MSG.send}: ${ENGINE}`,
      );
    },
    T,
  );
  it(
    "sendLaneTransaction( called from the route",
    () => {
      expectFail(
        withChange(
          ROUTE,
          append(
            'import { sendLaneTransaction } from "../../../swap/lane/signer-adapter";\nexport const direct = () => sendLaneTransaction(null, null as never, "SWAP");',
          ),
        ),
        `${MSG.send}: ${ROUTE}`,
      );
    },
    T,
  );
  it(
    "swapLaneRuntime( reached from a file other than its route",
    () => {
      const file = "src/app/api/execution/lane-leak.ts";
      expectFail(
        addFile(
          file,
          'import { swapLaneRuntime } from "../../../swap/lane/runtime";\nexport const leak = () => swapLaneRuntime();\n',
        ),
        `${MSG.runtime}: ${file}`,
      );
    },
    T,
  );
});

describe("the route refuses every write before the runtime", () => {
  it(
    "the route calls swapLaneRuntime() before the WRITE_DISABLED block (moved)",
    () => {
      expectFail(
        withChange(ROUTE, (t) => {
          const moved = replaceOnce(
            "    const lane = swapLaneRuntime();\n",
            "",
          )(t);
          return replaceOnce(
            "    if (!swapLaneArmed().armed) {",
            "    const lane = swapLaneRuntime();\n    if (!swapLaneArmed().armed) {",
          )(moved);
        }),
        MSG.route,
      );
    },
    T,
  );
  it(
    "an extra swapLaneRuntime() call before the WRITE_DISABLED block",
    () => {
      expectFail(
        withChange(
          ROUTE,
          replaceOnce(
            "    if (!swapLaneArmed().armed) {",
            '    void swapLaneRuntime;\n    if (r.action === "swap-lane-track") swapLaneRuntime();\n    if (!swapLaneArmed().armed) {',
          ),
        ),
        MSG.route,
      );
    },
    T,
  );
  it(
    "the WRITE_DISABLED block removed",
    () => {
      expectFail(
        withChange(
          ROUTE,
          replaceOnce(
            /    if \(!swapLaneArmed\(\)\.armed\) \{\n[\s\S]*?\n    \}\n/,
            "",
          ),
        ),
        MSG.route,
      );
    },
    T,
  );
});

describe("lane files: no Permit2 / signatures / key material, no canary reuse, no direct fetch", () => {
  it(
    "a lane file mentioning Permit2 (new file)",
    () => {
      const file = `${LANE}/permit.ts`;
      expectFail(
        addFile(file, 'export const SPENDER = "Permit2";\n'),
        `${MSG.permit}: ${file}`,
      );
    },
    T,
  );
  it(
    "the Permit2 address in calldata.ts",
    () => {
      expectFail(
        withChange(
          `${LANE}/calldata.ts`,
          append(
            'export const P2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";',
          ),
        ),
        `${MSG.permit}: ${LANE}/calldata.ts`,
      );
    },
    T,
  );
  it(
    "signTypedData / a private key in a lane file",
    () => {
      expectFail(
        withChange(
          `${LANE}/scope.ts`,
          append(
            "export const sig = (w: { signTypedData: () => void }) => w.signTypedData();",
          ),
        ),
        `${MSG.permit}: ${LANE}/scope.ts`,
      );
      expectFail(
        withChange(`${LANE}/scope.ts`, append('export const privateKey = "";')),
        `${MSG.permit}: ${LANE}/scope.ts`,
      );
    },
    2 * T,
  );
  it(
    "a lane file importing the canary-approval module",
    () => {
      expectFail(
        withChange(
          `${LANE}/scope.ts`,
          append(
            'export { OWNER_CANARY_APPROVAL } from "../../security/canary-approval";',
          ),
        ),
        `${MSG.canary}: ${LANE}/scope.ts`,
      );
    },
    T,
  );
  it(
    "a lane file importing the canary engine or the browser wallet adapter",
    () => {
      expectFail(
        withChange(
          RUNTIME,
          append('import "../../execution/server/canary/engine";'),
        ),
        `${MSG.canary}: ${RUNTIME}`,
      );
      expectFail(
        withChange(
          `${LANE}/pins.ts`,
          append('import "../../features/wallet/adapter";'),
        ),
        `${MSG.canary}: ${LANE}/pins.ts`,
      );
    },
    2 * T,
  );
  // FIXED in fl1 rc1 (was a SOURCE BUG found by this suite) (scripts/verify-safety.mjs:1413, rule 13): the guard is written `/<0x08>fetch\s*\(/` — a LITERAL
  // backspace byte where `\b` (word boundary) was meant (the same class of bug the header of
  // verify-safety-regression.test.ts describes). The regex can never match source text, so `fetch(` in ANY lane file
  // passes the scanner. Was expected to fail until the byte is replaced by `\b`.
  it(
    "fetch( in reads.ts",
    () => {
      expectFail(
        withChange(
          READS,
          append("export const leak = (u: string) => fetch(u);"),
        ),
        `${MSG.fetch}: ${READS}`,
      );
    },
    T,
  );
  it("the scanner source holds no literal control byte inside a regex (the 0x08 above)", () => {
    const text = readFileSync(SCRIPT, "utf8");
    expect(text.match(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g) ?? []).toEqual([]);
  });
  it(
    "a second fetch( in the signer adapter",
    () => {
      expectFail(
        withChange(
          ADAPTER,
          append('export const probe = () => fetch("http://127.0.0.1:8545/");'),
        ),
        MSG.order,
      );
    },
    T,
  );
});

describe("the adapter's single-use / compare / gate order", () => {
  it(
    "removing GRANTS.delete in the adapter",
    () => {
      expectFail(
        withChange(
          ADAPTER,
          replaceOnce("  GRANTS.delete(authority as object);\n", ""),
        ),
        MSG.order,
      );
    },
    T,
  );
  it(
    "GRANTS.delete kept only as a comment",
    () => {
      expectFail(
        withChange(
          ADAPTER,
          replaceOnce(
            "  GRANTS.delete(authority as object);\n",
            "  // GRANTS.delete(authority as object);\n",
          ),
        ),
        MSG.order,
      );
    },
    T,
  );
  it(
    "the gate re-run removed",
    () => {
      expectFail(
        withChange(
          ADAPTER,
          replaceOnce(
            /  const gate = swapLaneGateState\(\{ \.\.\.g\.facts, now: Date\.now\(\) \}\);\n  if \(!gate\.open\)\n    throw new LaneDispatchError\("SWAP_LANE_GATE_CLOSED", gate\.reasons\);\n/,
            "",
          ),
        ),
        MSG.order,
      );
    },
    T,
  );
  it(
    "the exact-transaction compare removed",
    () => {
      expectFail(
        withChange(
          ADAPTER,
          replaceOnce(
            /  if \(!sameLaneTx\(g\.tx, tx\)\)\n    throw new LaneDispatchError\("TX_NOT_AUTHORIZED_TX"\);\n/,
            "",
          ),
        ),
        MSG.order,
      );
    },
    T,
  );
  it(
    "the loopback-only endpoint loosened",
    () => {
      expectFail(
        withChange(
          ADAPTER,
          replaceOnce(
            String.raw`const ENDPOINT = /^http:\/\/127\.0\.0\.1:(\d{4,5})\/$/;`,
            String.raw`const ENDPOINT = /^https?:\/\/[^/]+\/$/;`,
          ),
        ),
        MSG.order,
      );
    },
    T,
  );
});

describe("scope bounds and file set", () => {
  it(
    "a raised maximum amount",
    () => {
      expectFail(
        withChange(
          `${LANE}/scope.ts`,
          replaceOnce("maxAmount: 1_000_000n,", "maxAmount: 5_000_000n,"),
        ),
        MSG.scope,
      );
    },
    T,
  );
  it(
    "a re-pointed router pin",
    () => {
      expectFail(
        withChange(
          `${LANE}/pins.ts`,
          replaceOnce(
            'address: "0x2626664c2603336E57B271c5C0b26F421741e481",',
            'address: "0xE592427A0AEce92De3Edee1F18E0157C05861564",',
          ),
        ),
        MSG.scope,
      );
    },
    T,
  );
  it(
    "a lane file removed",
    () => {
      expectFail(
        withChange(READS, () => null),
        `${MSG.missing}: reads.ts`,
      );
    },
    T,
  );
});

describe("module-path restrictions (aliases and dynamic imports)", () => {
  const imported = (target: string, file: string) =>
    `Swap lane module ${target} imported outside its allowed importers: ${file}`;
  it(
    "an aliased import of the lane signer adapter from a non-lane file",
    () => {
      const file = "src/server/lane-alias.ts";
      expectFail(
        addFile(
          file,
          'import { sendLaneTransaction as s } from "../swap/lane/signer-adapter";\nexport const x = s;\n',
        ),
        imported("src/swap/lane/signer-adapter", file),
      );
    },
    T,
  );
  it(
    "an aliased import of the mint from a lane file other than the engine",
    () => {
      expectFail(
        withChange(
          READS,
          append(
            'import { mintLaneDispatchAuthority as m } from "./signer-adapter";\nexport const x = m;',
          ),
        ),
        imported("src/swap/lane/signer-adapter", READS),
      );
    },
    T,
  );
  it(
    "importing the lane engine from route.ts",
    () => {
      expectFail(
        withChange(
          ROUTE,
          append(
            'import { SwapLaneEngine as E } from "../../../swap/lane/engine";\nexport const e = E;',
          ),
        ),
        imported("src/swap/lane/engine", ROUTE),
      );
    },
    T,
  );
  it(
    "importing the lane runtime from another src file",
    () => {
      const file = "src/server/lane-runtime-leak.ts";
      expectFail(
        addFile(
          file,
          'import { swapLaneArmed } from "../swap/lane/runtime";\nexport const a = swapLaneArmed;\n',
        ),
        imported("src/swap/lane/runtime", file),
      );
    },
    T,
  );
  it(
    'a dynamic import("../../swap/lane/runtime") in another src file',
    () => {
      const file = "src/app/api/lane-dyn.ts";
      const r = addFile(
        file,
        'export const load = () => import("../../swap/lane/runtime");\n',
      );
      expect(r.ok, r.output.slice(-800)).toBe(false);
      expect(r.output).toMatch(
        new RegExp(
          `(imported outside its allowed importers|loaded dynamically): ${file}`,
        ),
      );
    },
    T,
  );
  it(
    "a dynamic import of the runtime even from its own route",
    () => {
      expectFail(
        withChange(
          ROUTE,
          append(
            'export const later = () => import("../../../swap/lane/runtime");',
          ),
        ),
        `Swap lane module loaded dynamically: ${ROUTE}`,
      );
    },
    T,
  );
  it(
    'a lane-relative dynamic import("./engine") from the runtime',
    () => {
      expectFail(
        withChange(
          RUNTIME,
          append('export const later = () => import("./engine");'),
        ),
        `Swap lane module loaded dynamically: ${RUNTIME}`,
      );
    },
    T,
  );
  // SUSPECTED SCANNER GAPS (scripts/verify-safety.mjs rule 13, lines ~1452-1471): the module-path check only sees
  // string-literal specifiers after `from` / `import(`, and the dynamic-import check needs the literal text
  // `swap/lane` (or "./engine" etc.) inside the parentheses. A specifier built at runtime, or a `require(...)`, is
  // invisible to both, although the rule's own comment states "aliases and dynamic imports cannot bypass the
  // literal-name checks ... no dynamic import of a lane module anywhere in src". Each case below PASSES the scanner
  // today (verified by hand); expected to fail until the rule refuses them (e.g. any non-literal import( / require( in
  // src, or any `swap/lane` text outside the allowed importers).
  it(
    "GAP: a dynamic import with a variable specifier",
    () => {
      const file = "src/server/lane-probe.ts";
      const r = addFile(
        file,
        'const spec = "../swap/lane/" + "runtime";\nexport const load = () => import(spec);\n',
      );
      expect(r.ok, r.output.slice(-800)).toBe(false);
    },
    T,
  );
  it(
    "GAP: a dynamic import with a concatenated literal",
    () => {
      const file = "src/server/lane-probe.ts";
      const r = addFile(
        file,
        'export const load = () => import("../swap/" + "lane/runtime");\n',
      );
      expect(r.ok, r.output.slice(-800)).toBe(false);
    },
    T,
  );
  it(
    "GAP: require() of the signer adapter with a destructured alias",
    () => {
      const file = "src/server/lane-probe.ts";
      const r = addFile(
        file,
        'const { sendLaneTransaction: s } = require("../swap/lane/signer-adapter");\nexport const go = (a: unknown, t: never) => s(a, t, "SWAP");\n',
      );
      expect(r.ok, r.output.slice(-800)).toBe(false);
    },
    T,
  );
});

describe("one engine, one credential header, no fetch identifier in the lane", () => {
  it(
    "a second new SwapLaneEngine( in the runtime",
    () => {
      expectFail(
        withChange(
          RUNTIME,
          append(
            "export const second = () => new SwapLaneEngine(null as never);",
          ),
        ),
        "Swap lane: exactly one engine construction (the runtime)",
      );
    },
    T,
  );
  it(
    "a new SwapLaneEngine( in another file (without an import of the engine)",
    () => {
      const file = "src/server/lane-engine-copy.ts";
      expectFail(
        addFile(
          file,
          "const { SwapLaneEngine } = globalThis as unknown as { SwapLaneEngine: new (d: unknown) => unknown };\nexport const e = () => new SwapLaneEngine({});\n",
        ),
        `Swap lane engine constructed outside the runtime: ${file}`,
      );
    },
    T,
  );
  it(
    "the string x-fl1-signer-token in another file",
    () => {
      const file = "src/server/signer-header.ts";
      expectFail(
        addFile(file, 'export const HEADER = "x-fl1-signer-token";\n'),
        `Signer credential header outside the lane adapter: ${file}`,
      );
      expectFail(
        withChange(
          ENGINE,
          append('export const HEADER = "x-fl1-signer-token";'),
        ),
        `Signer credential header outside the lane adapter: ${ENGINE}`,
      );
    },
    2 * T,
  );
  it(
    "const f = fetch; in reads.ts",
    () => {
      expectFail(
        withChange(READS, append("export const f = fetch;")),
        `${MSG.fetchId}: ${READS}`,
      );
    },
    T,
  );
  it(
    "globalThis.fetch in another lane file",
    () => {
      expectFail(
        withChange(
          `${LANE}/calldata.ts`,
          append("export const f = globalThis.fetch;"),
        ),
        // The raw-network / globalThis rule (re-verification hardening) now rejects it first.
        `Swap lane: no raw network module, child process or globalThis indexing: ${LANE}/calldata.ts`,
      );
    },
    T,
  );
  it(
    "the fetch identifier in calldata.ts (neither the adapter nor the transport)",
    () => {
      expectFail(
        withChange(`${LANE}/calldata.ts`, append("export const f = fetch;")),
        `${MSG.fetchId}: ${LANE}/calldata.ts`,
      );
    },
    T,
  );
});

describe("the lane transport: imported by reads.ts alone, pool URLs by index, redirect error, no-store", () => {
  const imported = (target: string, file: string) =>
    `Swap lane module ${target} imported outside its allowed importers: ${file}`;
  it(
    "fetch( in reads.ts (reads go through the transport, never their own egress)",
    () => {
      expectFail(
        withChange(
          READS,
          append(
            'export const direct = () => fetch("https://mainnet.base.org", { method: "POST" });',
          ),
        ),
        `${MSG.fetch}: ${READS}`,
      );
    },
    T,
  );
  it(
    "the transport imported by the engine (a lane file other than reads.ts)",
    () => {
      expectFail(
        withChange(
          ENGINE,
          append(
            'import { laneJsonRpc as j } from "./transport";\nexport const raw = j;',
          ),
        ),
        imported("src/swap/lane/transport", ENGINE),
      );
    },
    T,
  );
  it(
    "the transport imported from outside the lane (alias path)",
    () => {
      const file = "src/server/lane-transport-leak.ts";
      expectFail(
        addFile(
          file,
          'import { laneJsonRpc } from "@/swap/lane/transport";\nexport const raw = laneJsonRpc;\n',
        ),
        imported("src/swap/lane/transport", file),
      );
    },
    T,
  );
  it(
    'a dynamic import("./transport") from the approval module',
    () => {
      const r = withChange(
        APPROVAL,
        append('export const later = () => import("./transport");'),
      );
      expect(r.ok, r.output.slice(-800)).toBe(false);
      expect(r.output).toMatch(
        new RegExp(
          `(imported outside its allowed importers|loaded dynamically): ${APPROVAL}`,
        ),
      );
    },
    T,
  );
  it(
    'a dynamic import("./transport") even from reads.ts (its one static importer)',
    () => {
      expectFail(
        withChange(
          READS,
          append('export const later = () => import("./transport");'),
        ),
        `Swap lane module loaded dynamically: ${READS}`,
      );
    },
    T,
  );
  it(
    'the transport without redirect: "error"',
    () => {
      expectFail(
        withChange(
          TRANSPORT,
          replaceOnce('redirect: "error",', 'redirect: "follow",'),
        ),
        MSG.transport,
      );
    },
    T,
  );
  it(
    'the transport without cache: "no-store"',
    () => {
      expectFail(
        withChange(
          TRANSPORT,
          replaceOnce('cache: "no-store",', 'cache: "default",'),
        ),
        MSG.transport,
      );
    },
    T,
  );
  it(
    "the transport fetching a URL that is not the pool entry by index",
    () => {
      expectFail(
        withChange(
          TRANSPORT,
          replaceOnce(
            "r = await fetch(source.url, {",
            "r = await fetch(String(params[0] ?? source.url), {",
          ),
        ),
        MSG.transport,
      );
    },
    T,
  );
  it(
    "a second fetch( in the transport",
    () => {
      expectFail(
        withChange(
          TRANSPORT,
          append("export const probe = (u: string) => fetch(u);"),
        ),
        MSG.transport,
      );
    },
    T,
  );
  it(
    "the transport's size cap removed",
    () => {
      expectFail(
        withChange(
          TRANSPORT,
          replaceOnce(
            "if (size > LANE_TRANSPORT_LIMITS.maxResponseBytes) {",
            "if (size < 0) {",
          ),
        ),
        MSG.transport,
      );
    },
    T,
  );
  it(
    "a URL outside the pool in the transport",
    () => {
      expectFail(
        withChange(
          TRANSPORT,
          append('export const EXTRA = "https://rpc.example.org";'),
        ),
        MSG.pool,
      );
    },
    T,
  );
  it(
    "one operator twice for a chain (two URLs of one organisation)",
    () => {
      expectFail(
        withChange(
          TRANSPORT,
          replaceOnce(
            'operator: "arbitrum-offchain-labs",',
            'operator: "drpc",',
          ),
        ),
        MSG.pool,
      );
    },
    T,
  );
  it(
    "the Base pair re-pointed (another second operator)",
    () => {
      expectFail(
        withChange(
          TRANSPORT,
          replaceOnce(
            'url: "https://mainnet.base.org",',
            'url: "https://base.drpc.org",',
          ),
        ),
        MSG.pool,
      );
    },
    T,
  );
  it(
    "a plain-http pool URL",
    () => {
      expectFail(
        withChange(
          TRANSPORT,
          replaceOnce(
            'url: "https://rpc-bsc.48.club",',
            'url: "http://rpc-bsc.48.club",',
          ),
        ),
        MSG.pool,
      );
    },
    T,
  );
  it(
    "the transport removed",
    () => {
      expectFail(
        withChange(TRANSPORT, () => null),
        `${MSG.missing}: transport.ts`,
      );
    },
    T,
  );
});

describe("the route table keeps the reviewed Base route and a one-unit maximum everywhere", () => {
  it(
    "the Base router re-pointed in the route table",
    () => {
      expectFail(
        withChange(
          SCOPE,
          replaceOnce(
            'router: "0x2626664c2603336E57B271c5C0b26F421741e481",',
            'router: "0xE592427A0AEce92De3Edee1F18E0157C05861564",',
          ),
        ),
        MSG.scope,
      );
    },
    T,
  );
  it(
    "the Base chain id changed in its route entry",
    () => {
      expectFail(
        withChange(
          SCOPE,
          replaceOnce('    chainId: "8453",', '    chainId: "84530",'),
        ),
        MSG.scope,
      );
    },
    T,
  );
  it(
    "another route's maximum raised above one unit",
    () => {
      expectFail(
        withChange(
          SCOPE,
          replaceOnce(
            "maxAmount: 1_000_000_000_000_000_000n,",
            "maxAmount: 5_000_000_000_000_000_000n,",
          ),
        ),
        MSG.scope,
      );
    },
    T,
  );
  it(
    "the Base pin-set id changed",
    () => {
      expectFail(
        withChange(
          `${LANE}/pins.ts`,
          replaceOnce(
            'set: "fl1-swap-lane-pins.2026-11-15.1",',
            'set: "fl1-swap-lane-pins.2026-11-16.1",',
          ),
        ),
        MSG.scope,
      );
    },
    T,
  );
  it(
    "the unmutated tree still passes after all the mutations above",
    () => {
      const r = run();
      expect(r.ok, r.output.slice(-800)).toBe(true);
      expect(r.output).toContain("PASS");
    },
    T,
  );
});
