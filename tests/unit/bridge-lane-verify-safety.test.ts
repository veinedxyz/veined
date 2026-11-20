// VEINED-MC1 (BRIDGE LANE): end-to-end mutation tests for rule 13b of scripts/verify-safety.mjs (the SEPARATE bridge
// lane) and the rule-4 / rule-13 parts the bridge lane extended. Mirrors tests/unit/swap-lane-verify-safety.test.ts:
// the REAL script runs against a temporary copy of the scanned tree with exactly the injected change(s), and every
// file is restored exactly afterwards. The unmutated copy passes; every mutation fails with the rule's own message.
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
const APPROVAL = `${LANE}/bridge-approval.ts`;
const ENGINE = `${LANE}/bridge-engine.ts`;
const RUNTIME = `${LANE}/bridge-runtime.ts`;
const SCOPE = `${LANE}/bridge-scope.ts`;
const PINS = `${LANE}/bridge-pins.ts`;
const CALLDATA = `${LANE}/bridge-calldata.ts`;
const ADAPTER = `${LANE}/signer-adapter.ts`;
const TRANSPORT = `${LANE}/transport.ts`;
const ROUTE = "src/app/api/bridge-lane/route.ts";
const MSG = {
  disarmed:
    "Bridge lane: disarmed (record null, key digest null, wiring false, signer null)",
  scope:
    "Bridge lane: scope bounds (5 USDC in, 4.90 out, 300 bps, 25 bps fee, six chains, BNB BLOCKED, no Avalanche)",
  pins: "Bridge lane: Diamond / selector / facet / fee collector pins",
  oneEngine:
    "Bridge lane: exactly one engine construction (the bridge runtime)",
  engineOutside: "Bridge lane engine constructed outside the bridge runtime",
  mint: "Bridge lane dispatch authority minted outside the bridge engine",
  send: "Bridge lane signer hand-off outside the bridge runtime",
  runtime: "Bridge lane runtime reached outside its route",
  lifi: "Bridge lane: the LI.FI quote URL outside the lane transport",
  quote: "Bridge lane: one LI.FI quote GET with the fixed query",
  order:
    "Bridge lane: single-use authority, exact tx, BRIDGE gate re-run and loopback-only signer before anything is sent",
  route: "Bridge lane API: WRITE_DISABLED before the runtime while not armed",
  logs: "Bridge lane: eth_getLogs outside the bridge read path",
  store: "Bridge lane runtime: its own store directory, no environment",
  missing: "Bridge lane file missing",
  storeOpen: "Canary store or runtime opened outside the runtime",
  transport:
    'Swap lane transport: pool URL by index only, one fetch, redirect "error", no-store, size cap',
  pool: "Swap lane RPC pool: two exact https sources of two different operators per chain",
  permit:
    "Swap lane: no Permit2, permit, typed data, raw broadcast or key material",
  canary:
    "Swap lane: never reuses the Bridge canary's record, engine, runtime or the browser wallet send path",
  fetch: "Swap lane: chain reads only through the egress-checked transport",
  imported: (target: string, file: string) =>
    `Swap lane module ${target} imported outside its allowed importers: ${file}`,
  logPool:
    "Bridge lane LOG pool: two exact https sources of two organisations per chain, evidence-verified, read by laneGetLogs alone",
  logPoolOutside: "Bridge lane LOG pool referenced outside the lane transport",
};
const T = 120_000;
let root = "";
let runs = 0;

beforeAll(() => {
  mkdirSync(TEMP, { recursive: true });
  root = mkdtempSync(join(TEMP, "bridge-lane-verify-safety-"));
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

describe("baseline", () => {
  it(
    "the unmutated tree passes; the canary keeps 12 rules, the lanes report 2 (13 + 13b)",
    () => {
      const r = run();
      expect(r.ok, r.output.slice(-800)).toBe(true);
      const out = JSON.parse(
        readFileSync(join(root, `.out-${runs}`, "safety.json"), "utf8"),
      ) as {
        g14Canary: { rules: number };
        swapLane: { rules: number };
      };
      expect(out.g14Canary.rules).toBe(12);
      expect(out.swapLane.rules).toBe(2);
    },
    T,
  );
});

describe("the four bridge facts stay disarmed", () => {
  it.each([
    [
      /export const OWNER_BRIDGE_LANE_APPROVAL =\s*null as Readonly<OwnerBridgeLaneApproval> \| null;/,
      'export const OWNER_BRIDGE_LANE_APPROVAL = Object.freeze({ version: "x" }) as unknown as Readonly<OwnerBridgeLaneApproval> | null;',
    ],
    [
      "export const OWNER_BRIDGE_LANE_KEY_SHA256 = null as string | null;",
      `export const OWNER_BRIDGE_LANE_KEY_SHA256 = "${"d".repeat(64)}" as string | null;`,
    ],
    [
      "export const BRIDGE_LANE_LIVE_WIRING = false as const;",
      "export const BRIDGE_LANE_LIVE_WIRING = true as const;",
    ],
    [
      // A non-signer port (as in swap-lane-verify-safety.test.ts), so THIS rule is the one that refuses it; the real
      // signer port 329x in an approval file is refused by rule 13 (e) — lanes-review-verify-safety.test.ts.
      "export const OWNER_BRIDGE_LANE_SIGNER = null as Readonly<{",
      'export const OWNER_BRIDGE_LANE_SIGNER = { url: "http://127.0.0.1:8545/", tokenFile: "t" } as Readonly<{',
    ],
    [
      "export const BRIDGE_LANE_LIVE_WIRING = false as const;",
      "// export const BRIDGE_LANE_LIVE_WIRING = false as const;\nexport const BRIDGE_LANE_LIVE_WIRING = true as const;",
    ],
  ] as const)(
    "armed: %s",
    (from, to) => {
      expectFail(withChange(APPROVAL, replaceOnce(from, to)), MSG.disarmed);
    },
    T,
  );
});

describe("one engine, an engine-only mint, a runtime-only send, a route-only runtime", () => {
  it(
    "a second new BridgeLaneEngine( in the bridge runtime",
    () => {
      expectFail(
        withChange(
          RUNTIME,
          append(
            "export const second = () => new BridgeLaneEngine(null as never);",
          ),
        ),
        MSG.oneEngine,
      );
    },
    T,
  );
  it(
    "a new BridgeLaneEngine( in another file",
    () => {
      const file = "src/server/bridge-engine-copy.ts";
      expectFail(
        addFile(
          file,
          "const { BridgeLaneEngine } = globalThis as unknown as { BridgeLaneEngine: new (d: unknown) => unknown };\nexport const e = () => new BridgeLaneEngine({});\n",
        ),
        `${MSG.engineOutside}: ${file}`,
      );
    },
    T,
  );
  it(
    "mintBridgeDispatchAuthority( in the bridge runtime, or twice in the bridge engine",
    () => {
      expectFail(
        withChange(
          RUNTIME,
          append(
            'import { mintBridgeDispatchAuthority } from "./signer-adapter";\nexport const leak = () => mintBridgeDispatchAuthority(null as never);',
          ),
        ),
        `${MSG.mint}: ${RUNTIME}`,
      );
      expectFail(
        withChange(
          ENGINE,
          append(
            "export const twice = () => mintBridgeDispatchAuthority(null as never);",
          ),
        ),
        `${MSG.mint}: ${ENGINE}`,
      );
    },
    2 * T,
  );
  it(
    "sendBridgeLaneTransaction( from the bridge engine or the route",
    () => {
      expectFail(
        withChange(
          ENGINE,
          append(
            'import { sendBridgeLaneTransaction } from "./signer-adapter";\nexport const direct = () => sendBridgeLaneTransaction(null, null as never, "EXECUTE");',
          ),
        ),
        `${MSG.send}: ${ENGINE}`,
      );
      expectFail(
        withChange(
          ROUTE,
          append(
            'import { sendBridgeLaneTransaction } from "../../../swap/lane/signer-adapter";\nexport const direct = () => sendBridgeLaneTransaction(null, null as never, "APPROVE");',
          ),
        ),
        // the module-path rule (rule 13) refuses the adapter import from the route before the call-site rule
        MSG.imported("src/swap/lane/signer-adapter", ROUTE),
      );
      expectFail(
        withChange(
          ROUTE,
          append(
            'const { sendBridgeLaneTransaction } = globalThis as unknown as { sendBridgeLaneTransaction: (...a: unknown[]) => unknown };\nexport const direct = () => sendBridgeLaneTransaction(null, null, "APPROVE");',
          ),
        ),
        `${MSG.send}: ${ROUTE}`,
      );
    },
    3 * T,
  );
  it(
    "bridgeLaneRuntime( reached from another file",
    () => {
      // with an import: the module-path rule refuses it first; without one (a global), the call-site rule does
      const file = "src/app/api/execution/bridge-leak.ts";
      expectFail(
        addFile(
          file,
          'import { bridgeLaneRuntime } from "../../../swap/lane/bridge-runtime";\nexport const leak = () => bridgeLaneRuntime();\n',
        ),
        MSG.imported("src/swap/lane/bridge-runtime", file),
      );
      expectFail(
        addFile(
          file,
          "const { bridgeLaneRuntime } = globalThis as unknown as { bridgeLaneRuntime: () => unknown };\nexport const leak = () => bridgeLaneRuntime();\n",
        ),
        `${MSG.runtime}: ${file}`,
      );
    },
    2 * T,
  );
});

describe("module-path restrictions", () => {
  it(
    "the bridge engine imported by the route (not the bridge runtime)",
    () => {
      expectFail(
        withChange(
          ROUTE,
          append(
            'import { BridgeLaneEngine as E } from "../../../swap/lane/bridge-engine";\nexport const e = E;',
          ),
        ),
        MSG.imported("src/swap/lane/bridge-engine", ROUTE),
      );
    },
    T,
  );
  it(
    "the bridge runtime imported by another file (alias path)",
    () => {
      const file = "src/server/bridge-runtime-leak.ts";
      expectFail(
        addFile(
          file,
          'import { bridgeLaneArmed } from "@/swap/lane/bridge-runtime";\nexport const a = bridgeLaneArmed;\n',
        ),
        MSG.imported("src/swap/lane/bridge-runtime", file),
      );
    },
    T,
  );
  it(
    'a lane-relative dynamic import("./bridge-engine")',
    () => {
      expectFail(
        withChange(
          RUNTIME,
          append('export const later = () => import("./bridge-engine");'),
        ),
        `Swap lane module loaded dynamically: ${RUNTIME}`,
      );
    },
    T,
  );
  it(
    "the transport imported by the bridge engine (reads.ts is its only importer)",
    () => {
      expectFail(
        withChange(
          ENGINE,
          append(
            'import { laneLifiQuote as q } from "./transport";\nexport const raw = q;',
          ),
        ),
        MSG.imported("src/swap/lane/transport", ENGINE),
      );
    },
    T,
  );
});

describe("the route closes before the runtime", () => {
  it(
    "the runtime moved before the WRITE_DISABLED block",
    () => {
      expectFail(
        withChange(ROUTE, (t) =>
          replaceOnce(
            "    if (!bridgeLaneArmed().armed) {",
            "    const lane = bridgeLaneRuntime();\n    if (!bridgeLaneArmed().armed) {",
          )(replaceOnce("    const lane = bridgeLaneRuntime();\n", "")(t)),
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
            /    if \(!bridgeLaneArmed\(\)\.armed\) \{\n[\s\S]*?\n    \}\n/,
            "",
          ),
        ),
        MSG.route,
      );
    },
    T,
  );
  it(
    "the route removed",
    () => {
      expectFail(
        withChange(ROUTE, () => null),
        `${MSG.missing}: ${ROUTE}`,
      );
    },
    T,
  );
});

describe("rule 4: the store is opened once, in the bridge runtime too", () => {
  it(
    "a second CanaryDurableStore.open( in the bridge runtime",
    () => {
      expectFail(
        withChange(
          RUNTIME,
          append(
            "export const again = (d: string) => CanaryDurableStore.open(d);",
          ),
        ),
        `${MSG.storeOpen}: ${RUNTIME}`,
      );
    },
    T,
  );
  it(
    "CanaryDurableStore.open( in the bridge engine",
    () => {
      expectFail(
        withChange(
          ENGINE,
          append(
            'import { CanaryDurableStore as S } from "../../execution/server/canary/durable-store";\nexport const o = (d: string) => S.open(d);\nexport const p = (d: string) => CanaryDurableStore.open(d);',
          ),
        ),
        `${MSG.storeOpen}: ${ENGINE}`,
      );
    },
    T,
  );
  it(
    "the bridge runtime on another lane's store directory",
    () => {
      expectFail(
        withChange(
          RUNTIME,
          replaceOnce(
            '".veined-bridge-lane-store"',
            '".veined-swap-lane-store"',
          ),
        ),
        MSG.store,
      );
    },
    T,
  );
});

describe("the LI.FI quote: one URL, in the transport alone, a GET with the fixed query", () => {
  it(
    "the quote URL in the bridge engine",
    () => {
      expectFail(
        withChange(
          ENGINE,
          append('export const U = "https://li.quest/v1/quote";'),
        ),
        `${MSG.lifi}: ${ENGINE}`,
      );
    },
    T,
  );
  it(
    "the quote URL in a file outside the lane",
    () => {
      const file = "src/server/lifi-quote.ts";
      expectFail(
        addFile(file, 'export const U = "https://li.quest/v1/quote?x=1";\n'),
        `${MSG.lifi}: ${file}`,
      );
    },
    T,
  );
  it(
    "any li.quest URL in another lane file",
    () => {
      expectFail(
        withChange(CALLDATA, append('export const U = "li.quest";')),
        `${MSG.lifi}: ${CALLDATA}`,
      );
    },
    T,
  );
  it.each([
    ['method: "GET",', 'method: "POST",'],
    ['["slippage", "0.005"],', '["slippage", "0.05"],'],
    ['["allowBridges", "across"],', '["allowBridges", "all"],'],
    ['["allowDestinationCall", "false"],', '["allowDestinationCall", "true"],'],
    ['["toAddress", q.account],', '["toAddress", q.fromToken],'],
    ['["order", "CHEAPEST"],', '["order", "FASTEST"],'],
  ] as const)(
    "the quote request changed: %s",
    (from, to) => {
      expectFail(withChange(TRANSPORT, replaceOnce(from, to)), MSG.quote);
    },
    T,
  );
  it(
    "the quote fetch without redirect: error (both fetches must keep it)",
    () => {
      expectFail(
        withChange(TRANSPORT, (t) => {
          const i = (t ?? "").lastIndexOf('redirect: "error",');
          return (
            (t ?? "").slice(0, i) +
            'redirect: "follow",' +
            (t ?? "").slice(i + 'redirect: "error",'.length)
          );
        }),
        MSG.transport,
      );
    },
    T,
  );
  it(
    "a third fetch in the transport",
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
    "eth_getLogs added to the swap transport's method list",
    () => {
      expectFail(
        withChange(
          TRANSPORT,
          replaceOnce(
            '  "eth_simulateV1",\n]);\nexport const LANE_TRANSPORT_LIMITS',
            '  "eth_simulateV1",\n  "eth_getLogs",\n]);\nexport const LANE_TRANSPORT_LIMITS',
          ),
        ),
        MSG.transport,
      );
    },
    T,
  );
  it(
    "eth_getLogs named in a bridge file outside the read path",
    () => {
      expectFail(
        withChange(APPROVAL, append('export const M = "eth_getLogs";')),
        `${MSG.logs}: ${APPROVAL}`,
      );
    },
    T,
  );
});

describe("the LOG pool: pinned, evidence-verified, read by laneGetLogs alone", () => {
  const LOG_DRPC =
    '      operator: "drpc",\n      url: "https://base.drpc.org",';
  it.each([
    [
      "a log URL that is not pinned (not the RPC pool, not the evidence allowlist)",
      LOG_DRPC,
      '      operator: "drpc",\n      url: "https://base.llamarpc.com",',
    ],
    [
      "mainnet.base.org (refuses eth_getLogs) in the Base log pool",
      LOG_DRPC,
      '      operator: "base-coinbase",\n      url: "https://mainnet.base.org",',
    ],
    [
      "one organisation twice in the Base log pool",
      LOG_DRPC,
      '      operator: "allnodes-publicnode",\n      url: "https://base.drpc.org",',
    ],
    [
      "a plain-http log URL",
      LOG_DRPC,
      '      operator: "drpc",\n      url: "http://base.drpc.org",',
    ],
    [
      "laneJsonRpc reading the LOG pool",
      "return poolRpc(lanePool(chainId), operator, method, params, signal);",
      "return poolRpc(laneLogPool(chainId), operator, method, params, signal);",
    ],
    [
      "laneGetLogs reading the RPC pool",
      '    laneLogPool(chainId),\n    operator,\n    "eth_getLogs",',
      '    lanePool(chainId),\n    operator,\n    "eth_getLogs",',
    ],
  ] as const)(
    "%s",
    (_name, from, to) => {
      const r = withChange(TRANSPORT, replaceOnce(from, to));
      expect(r.ok, r.output.slice(-800)).toBe(false);
      expect(r.output).toMatch(
        new RegExp(
          [MSG.logPool, MSG.pool]
            .map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("|"),
        ),
      );
    },
    T,
  );
  it(
    "the LOG pool named in another file (reads.ts)",
    () => {
      expectFail(
        withChange(
          `${LANE}/reads.ts`,
          append(
            'import { LANE_LOG_POOL } from "./transport";\nexport const leak = LANE_LOG_POOL;',
          ),
        ),
        `${MSG.logPoolOutside}: ${LANE}/reads.ts`,
      );
    },
    T,
  );
  it(
    "a log URL constant outside the transport",
    () => {
      const file = "src/server/log-url.ts";
      expectFail(
        addFile(file, 'export const U = "https://base.drpc.org";\n'),
        `${MSG.logPoolOutside}: ${file}`,
      );
    },
    T,
  );
});

describe("the adapter's bridge send", () => {
  it(
    "BRIDGE_GRANTS.delete removed",
    () => {
      expectFail(
        withChange(
          ADAPTER,
          replaceOnce("  BRIDGE_GRANTS.delete(authority as object);\n", ""),
        ),
        MSG.order,
      );
    },
    T,
  );
  it(
    "the BRIDGE gate re-run removed",
    () => {
      expectFail(
        withChange(
          ADAPTER,
          replaceOnce(
            /  const bridgeGate = bridgeLaneGateState\(\{ \.\.\.bg\.facts, now: Date\.now\(\) \}\);\n  if \(!bridgeGate\.open\)\n    throw new LaneDispatchError\("BRIDGE_LANE_GATE_CLOSED", bridgeGate\.reasons\);\n/,
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
            /  if \(!sameLaneTx\(bg\.tx, tx\)\)\n    throw new LaneDispatchError\("TX_NOT_AUTHORIZED_TX"\);\n/,
            "",
          ),
        ),
        MSG.order,
      );
    },
    T,
  );
  it(
    "a swapAmount or another lane in the bridge body",
    () => {
      expectFail(
        withChange(
          ADAPTER,
          replaceOnce(
            'declared: { lane: "BRIDGE", route: bg.facts.route, step: bg.facts.step },',
            'declared: { lane: "SWAP", route: bg.facts.route, step: bg.facts.step },',
          ),
        ),
        MSG.order,
      );
      expectFail(
        withChange(
          ADAPTER,
          replaceOnce(
            'declared: { lane: "BRIDGE", route: bg.facts.route, step: bg.facts.step },\n      tx,',
            'declared: { lane: "BRIDGE", route: bg.facts.route, step: bg.facts.step },\n      swapAmount: "5000000",\n      tx,',
          ),
        ),
        MSG.order,
      );
    },
    2 * T,
  );
  it(
    "the bridge send posting to the swap lane's endpoint",
    () => {
      expectFail(
        withChange(
          ADAPTER,
          replaceOnce(
            "await postSigner(OWNER_BRIDGE_LANE_SIGNER, {",
            "await postSigner(OWNER_SWAP_LANE_SIGNER, {",
          ),
        ),
        MSG.order,
      );
    },
    T,
  );
});

describe("the frozen bridge scope and pins", () => {
  it.each([
    ["exactAmount: 5_000_000n,", "exactAmount: 50_000_000n,"],
    ["minimumOut: 4_900_000n,", "minimumOut: 4_000_000n,"],
    ["maxCostBps: 300,", "maxCostBps: 301,"],
    ["maxFeeBps: 25,", "maxFeeBps: 50,"],
    ["maxExclusivitySec: 300,", "maxExclusivitySec: 3600,"],
    [
      "const BRIDGE_GAS = { APPROVE: 100_000n, EXECUTE: 600_000n };",
      "const BRIDGE_GAS = { APPROVE: 100_000n, EXECUTE: 2_000_000n };",
    ],
    [
      'status: "BLOCKED",\n    blockReason: "NO_CIRCLE_USDC",',
      'status: "ENABLED",\n    blockReason: null,',
    ],
  ] as const)(
    "scope changed: %s",
    (from, to) => {
      expectFail(withChange(SCOPE, replaceOnce(from, to)), MSG.scope);
    },
    T,
  );
  it(
    "an Avalanche chain added to the bridge scope",
    () => {
      expectFail(
        withChange(SCOPE, append('export const AVALANCHE = "43114";')),
        MSG.scope,
      );
    },
    T,
  );
  it.each([
    ['bridge: "0x1794958f",', 'bridge: "0x12345678",'],
    [
      '"0xc06ebbefd94032b85424d51906e2a335efae264b";',
      '"0xc06ebbefd94032b85424d51906e2a335efae2640";',
    ],
  ] as const)(
    "pins changed: %s",
    (from, to) => {
      expectFail(withChange(PINS, replaceOnce(from, to)), MSG.pins);
    },
    T,
  );
  it(
    "a bridge file removed",
    () => {
      expectFail(
        withChange(ENGINE, () => null),
        `${MSG.missing}: bridge-engine.ts`,
      );
    },
    T,
  );
});

describe("every lane ban applies to the bridge files", () => {
  it(
    "Permit2 in bridge-calldata.ts",
    () => {
      expectFail(
        withChange(
          CALLDATA,
          append(
            'export const P2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";',
          ),
        ),
        `${MSG.permit}: ${CALLDATA}`,
      );
    },
    T,
  );
  it(
    "the canary engine imported by the bridge runtime",
    () => {
      expectFail(
        withChange(
          RUNTIME,
          append('import "../../execution/server/canary/engine";'),
        ),
        `${MSG.canary}: ${RUNTIME}`,
      );
    },
    T,
  );
  it(
    "fetch( in the bridge engine",
    () => {
      expectFail(
        withChange(
          ENGINE,
          append("export const leak = (u: string) => fetch(u);"),
        ),
        `${MSG.fetch}: ${ENGINE}`,
      );
    },
    T,
  );
  it(
    "the unmutated tree still passes after all the mutations above",
    () => {
      const r = run();
      expect(r.ok, r.output.slice(-800)).toBe(true);
    },
    T,
  );
});
