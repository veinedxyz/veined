// V1.7 G7 controlled-pilot PREPARATION (read-only). `pnpm g7:prepare [label]`
// Phase A (stable): dual-RPC route/authority/pause/pair pins, drift-event scans since the V1.6 pins, incremental
//   BSC CROSS ledger reconciliation from the accepted V1.6 ledger pin, in-flight enumeration, spendable reserve.
// Phase B (ephemeral, <= 60 s): fresh re-pin of both chains, fees/minimum, EOA code/balance, positive eth_call and
//   eth_estimateGas, six negative controls on both official ONE endpoints, reserve extension to the new pin,
//   exact unsigned calldata + independent decode, transaction firewall + mutations, gates P1-P20, artifacts.
// It never signs, never sends, never approves, never deploys, never opens a wallet and reads no secrets: every
// request goes through the READ-ONLY allowlisted client (src/g7/rpc.ts). Exit code 0 only for READY.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  pad,
  parseAbi,
  toHex,
  type Abi,
  type Hex,
} from "viem";
import { G5_ROUTE_PINS, evaluateRouteDrift } from "../src/g5/route-pins";
import { G5_STATUS } from "../src/g5/status";
import { deriveSpendableReserve } from "../src/g5/reserve";
import { platformFeePolicy } from "../src/routing/fee-policy";
import { ReadOnlyRpc, type RpcAuditRecord } from "../src/g7/rpc";
import {
  CROSS,
  ENDPOINTS,
  EXTENDED_PINS,
  G7_POLICY_VERSION,
  NATIVE,
  NEGATIVE_CONTROLS,
  ONE_PIN_LAG,
  PILOT_EOA,
  QUOTE_MAX_AGE_MS,
  ROLE_NAMES,
  SLOTS,
  TRUST_ACCEPTANCE_SENTENCE,
  TRUST_ACCOUNTS,
  TRUST_STATEMENT,
  V16,
  WATCHED_EVENTS,
} from "../src/g7/policy";
import {
  LEDGER_EVENT_ABI,
  reconcileLedgerDelta,
  type LedgerDeltaResult,
  type LedgerState,
  type RawLog,
} from "../src/g7/ledger";
import { BRIDGE_TOKEN_SELECTOR, selectorOf } from "../src/g7/decoder";
import {
  canonicalJson,
  encodePilotCalldata,
  evaluateGates,
  expectedFirewallIntent,
  expectedPinsView,
  exposure,
  firewallMutations,
  formatUnits18,
  g7ContractEntry,
  g7Firewall,
  gasPlan,
  hostileReplay,
  intentDigest,
  normalizedOwnerIntent,
  observedRoute,
  pinsDigest,
  productionGateStaysClosed,
  quoteFromFees,
  routePinsView,
  verifyCalldata,
  type DriftScan,
  type G5DecisionCheck,
  type InFlight,
  type NegativeRead,
  type PrepInput,
  type SideRead,
  type SimulationRead,
} from "../src/g7/prep";
import { scanG7Sources } from "./g7-safety-scan";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POINTER = join(REPO, ".otherbridge", "g7-evidence-path.txt");
if (!existsSync(POINTER))
  throw new Error("run `node scripts/g7-preserve.mjs start` first");
const ROOT_REL = readFileSync(POINTER, "utf8").trim();
const LABEL = process.argv[2] ?? "run";
const OUT = join(REPO, ROOT_REL, LABEL);
mkdirSync(OUT, { recursive: true });
const V16_ROOT = join(REPO, V16.evidence);
const sha256 = (b: string | Buffer) =>
  createHash("sha256").update(b).digest("hex");
const json = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 1) +
  "\n";
function write(relPath: string, value: unknown) {
  const p = join(OUT, relPath);
  mkdirSync(dirname(p), { recursive: true });
  const text = json(value);
  writeFileSync(p, text);
  return { path: `${ROOT_REL}/${LABEL}/${relPath}`, sha256: sha256(text) };
}
const log = (...a: unknown[]) =>
  console.log(
    new Date().toISOString(),
    ...a.map((x) => (typeof x === "string" ? x : json(x).trim())),
  );

// ------------------------------------------------------------------ read-only client with full audit trail
const AUDIT = join(REPO, ROOT_REL, "rpc", `rpc-audit-${LABEL}.jsonl`);
mkdirSync(dirname(AUDIT), { recursive: true });
const rpc = new ReadOnlyRpc({
  timeoutMs: 30000,
  audit: (r: RpcAuditRecord) => appendFileSync(AUDIT, JSON.stringify(r) + "\n"),
});
function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}
const limits = new Map<string, ReturnType<typeof limiter>>();
const lim = (url: string) => {
  if (!limits.has(url)) limits.set(url, limiter(6));
  return limits.get(url)!;
};
const call = <T>(url: string, method: string, params: unknown[]) =>
  lim(url)(() => rpc.retry<T>(url, method, params));
const raw = (url: string, method: string, params: unknown[]) =>
  lim(url)(() => rpc.raw(url, method, params));
const hx = (n: number | bigint) => "0x" + n.toString(16);

const VIEW_ABI = parseAbi([
  "function paused() view returns (bool)",
  "function threshold() view returns (uint8)",
  "function bridgeVerifier() view returns (address)",
  "function bridgeExecutor() view returns (address)",
  "function dev() view returns (address)",
  "function maxExtraDataLength() view returns (uint256)",
  "function getTokenPair(uint256,address) view returns ((address localToken,address remoteToken,bool isOrigin,bool paused,uint256 pendingAmount,uint256 deposited,uint256 minted))",
  "function allPendingIndex(uint256) view returns (uint256[])",
  "function getPendingArguments(uint256,uint256) view returns (((uint256 fromChainID,uint256 index,address toToken,address to,uint256 value,bytes extraData) args,uint8 status,uint256 delayExpiration))",
  "function getNextInitiateIndex(uint256) view returns (uint256)",
  "function getNextFinalizeIndex(uint256) view returns (uint256)",
  "function isTokenFinalizePaused(uint256,address) view returns (bool)",
  "function getRoleMembers(bytes32) view returns (address[])",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function getVerificationAmountThreshold() view returns (uint256)",
  "function getPeriodTotalValueThreshold() view returns (uint256)",
  "function priceFeed() view returns (address)",
  "function denominator() pure returns (uint256)",
  "function getTokenConfig(uint256,address) view returns (uint256 minimumValue,uint256 networkFee,uint256 exFeeRate)",
  "function calculateFee(uint256,address,uint256) view returns (uint256 minimumValue,uint256 networkFee,uint256 exFee)",
]) as Abi;
async function view<T>(
  url: string,
  to: string,
  fn: string,
  args: unknown[],
  block: string,
): Promise<T> {
  const data = encodeFunctionData({ abi: VIEW_ABI, functionName: fn, args });
  const out = await call<Hex>(url, "eth_call", [{ to, data }, block]);
  return decodeFunctionResult({
    abi: VIEW_ABI,
    functionName: fn,
    data: out,
  }) as T;
}
const roleId = (r: string) =>
  r === "DEFAULT_ADMIN_ROLE" ? pad("0x00") : keccak256(toHex(r));
const mapSlot = (key: bigint, slot: bigint) =>
  keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }],
      [key, slot],
    ),
  );
const plus = (h: string, n: bigint) => toHex(BigInt(h) + n, { size: 32 });

// ------------------------------------------------------------------ one side of the route at one pinned block
type Pair = SideRead["pair"];
async function readSide(
  chain: "one" | "bsc",
  url: string,
  block: string,
): Promise<SideRead> {
  const side =
    chain === "one" ? G5_ROUTE_PINS.source : G5_ROUTE_PINS.destination;
  const remote = chain === "one" ? 56n : 612055n;
  const token = chain === "one" ? NATIVE : CROSS;
  const v = <T>(to: string, fn: string, args: unknown[] = []) =>
    view<T>(url, to, fn, args, block);
  const code = (a: string) => call<string>(url, "eth_getCode", [a, block]);
  const slot = (s: string) =>
    call<string>(url, "eth_getStorageAt", [side.proxy, s, block]);
  const [head, chainIdHex, implSlot, adminSlot, beaconSlot, proxyCode] =
    await Promise.all([
      call<{ hash: string; timestamp: string; number: string }>(
        url,
        "eth_getBlockByNumber",
        [block, false],
      ),
      call<string>(url, "eth_chainId", []),
      slot(SLOTS.implementation),
      slot(SLOTS.admin),
      slot(SLOTS.beacon),
      code(side.proxy),
    ]);
  const implementation = "0x" + implSlot.slice(-40);
  const [
    implCode,
    paused,
    threshold,
    verifier,
    executor,
    dev,
    maxExtra,
    pair,
    finalizePaused,
    nextInit,
    nextFin,
    pendingIdx,
    chainPausedRaw,
  ] = await Promise.all([
    code(implementation),
    v<boolean>(side.proxy, "paused"),
    v<number>(side.proxy, "threshold"),
    v<string>(side.proxy, "bridgeVerifier"),
    v<string>(side.proxy, "bridgeExecutor"),
    v<string>(side.proxy, "dev"),
    v<bigint>(side.proxy, "maxExtraDataLength"),
    v<Record<string, unknown>>(side.proxy, "getTokenPair", [remote, token]),
    v<boolean>(side.proxy, "isTokenFinalizePaused", [remote, token]),
    v<bigint>(side.proxy, "getNextInitiateIndex", [remote]),
    v<bigint>(side.proxy, "getNextFinalizeIndex", [remote]),
    v<bigint[]>(side.proxy, "allPendingIndex", [remote]),
    // _chainData mapping at slot 4, `paused` at struct offset +3 (V1.6 layout, exact build)
    call<string>(url, "eth_getStorageAt", [
      side.proxy,
      plus(mapSlot(remote, 4n), 3n),
      block,
    ]),
  ]);
  const [verifierCode, bridgeRoles, verifierRoles, vt1, vt2, priceFeed, denom] =
    await Promise.all([
      code(verifier),
      Promise.all(
        ROLE_NAMES.map((r) =>
          v<string[]>(side.proxy, "getRoleMembers", [roleId(r)]),
        ),
      ),
      Promise.all(
        ROLE_NAMES.map((r) =>
          v<string[]>(verifier, "getRoleMembers", [roleId(r)]),
        ),
      ),
      v<bigint>(verifier, "getVerificationAmountThreshold"),
      v<bigint>(verifier, "getPeriodTotalValueThreshold"),
      v<string>(verifier, "priceFeed"),
      v<bigint>(verifier, "denominator"),
    ]);
  const pending = await Promise.all(
    pendingIdx.map(async (i) => {
      const p = await v<{
        args: { toToken: string; to: string; value: bigint };
        status: number;
      }>(side.proxy, "getPendingArguments", [remote, i]);
      return {
        index: i.toString(),
        toToken: p.args.toToken.toLowerCase(),
        to: p.args.to.toLowerCase(),
        value: p.args.value.toString(),
        status: Number(p.status),
      };
    }),
  );
  const trustCodes = await Promise.all(TRUST_ACCOUNTS.map((a) => code(a)));
  const accountCode = await code(PILOT_EOA);
  const lc = (xs: string[]) => xs.map((x) => x.toLowerCase());
  const p = pair as unknown as Record<string, string | boolean | bigint>;
  const out: SideRead = {
    url,
    chainId: Number(BigInt(chainIdHex)),
    block: Number(BigInt(block)),
    blockHash: head.hash,
    blockTimestamp: Number(BigInt(head.timestamp)),
    proxyCodeHash: keccak256(proxyCode as Hex),
    implementationSlot: implSlot.toLowerCase(),
    implementation: implementation.toLowerCase(),
    implementationCodeHash: keccak256(implCode as Hex),
    adminSlot: adminSlot.toLowerCase(),
    beaconSlot: beaconSlot.toLowerCase(),
    paused,
    threshold: Number(threshold),
    verifier: verifier.toLowerCase(),
    verifierCodeHash: keccak256(verifierCode as Hex),
    executor: executor.toLowerCase(),
    dev: dev.toLowerCase(),
    maxExtraDataLength: maxExtra.toString(),
    bridgeRoles: Object.fromEntries(
      ROLE_NAMES.map((r, k) => [r, lc(bridgeRoles[k])]),
    ),
    verifierRoles: Object.fromEntries(
      ROLE_NAMES.map((r, k) => [r, lc(verifierRoles[k])]),
    ),
    verifierThresholds: {
      verificationAmountThreshold: vt1.toString(),
      periodTotalValueThreshold: vt2.toString(),
    },
    priceFeed: priceFeed.toLowerCase(),
    feeDenominator: denom.toString(),
    pair: {
      localToken: String(p.localToken).toLowerCase(),
      remoteToken: String(p.remoteToken).toLowerCase(),
      isOrigin: Boolean(p.isOrigin),
      paused: Boolean(p.paused),
      pendingAmount: String(p.pendingAmount),
      deposited: String(p.deposited),
      minted: String(p.minted),
    } satisfies Pair,
    chainPaused: BigInt(chainPausedRaw) !== 0n,
    finalizePaused,
    nextInitiateIndex: nextInit.toString(),
    nextFinalizeIndex: nextFin.toString(),
    pending,
    trustAccountCodes: Object.fromEntries(
      TRUST_ACCOUNTS.map((a, k) => [a.toLowerCase(), trustCodes[k]]),
    ),
    accountCode,
  };
  // The pinned bridgeToken selector must still be dispatched by the live implementation (PUSH4 <selector>).
  (
    out as SideRead & { dispatcherHasBridgeToken?: boolean }
  ).dispatcherHasBridgeToken =
    chain === "one"
      ? implCode.toLowerCase().includes("63" + BRIDGE_TOKEN_SELECTOR.slice(2))
      : undefined;
  if (chain === "one") {
    const [minimum, networkFee] = await v<[bigint, bigint, bigint]>(
      verifier,
      "calculateFee",
      [56n, NATIVE, 0n],
    );
    const [[m2, n2, exFee], [cfgMin, cfgNf, rate], balance, nonce] =
      await Promise.all([
        v<[bigint, bigint, bigint]>(verifier, "calculateFee", [
          56n,
          NATIVE,
          minimum,
        ]),
        v<[bigint, bigint, bigint]>(verifier, "getTokenConfig", [56n, NATIVE]),
        call<string>(url, "eth_getBalance", [PILOT_EOA, block]),
        call<string>(url, "eth_getTransactionCount", [PILOT_EOA, block]),
      ]);
    out.fees = {
      minimum: minimum.toString(),
      networkFee: networkFee.toString(),
      exFee: exFee.toString(),
      minimumAtAmount: m2.toString(),
      networkFeeAtAmount: n2.toString(),
      configMinimum: cfgMin.toString(),
      configNetworkFee: cfgNf.toString(),
      exFeeRate: rate.toString(),
    };
    out.balance = BigInt(balance).toString();
    out.nonce = BigInt(nonce).toString();
  } else {
    const [tokenCode, decimals, bal, symbol, name] = await Promise.all([
      code(CROSS),
      v<number>(CROSS, "decimals"),
      v<bigint>(CROSS, "balanceOf", [side.proxy]),
      v<string>(CROSS, "symbol"),
      v<string>(CROSS, "name"),
    ]);
    out.token = {
      address: CROSS.toLowerCase(),
      codeHash: keccak256(tokenCode as Hex),
      decimals: Number(decimals),
      balanceOfBridge: bal.toString(),
      symbol,
      name,
    };
  }
  return out;
}

// Pins: ONE = head - lag (load-balanced public backends); BSC = the `finalized` block. Both sources must serve the
// identical block hash. A pruned-state answer re-pins (bounded), it is never ignored.
async function pinOne() {
  const head = Number(
    BigInt(await call<string>(ENDPOINTS.one[0], "eth_blockNumber", [])),
  );
  return hx(head - ONE_PIN_LAG);
}
async function pinBsc() {
  const f = await call<{ number: string }>(
    ENDPOINTS.bsc[0],
    "eth_getBlockByNumber",
    ["finalized", false],
  );
  return f.number;
}
async function readBoth(chain: "one" | "bsc") {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const block = chain === "one" ? await pinOne() : await pinBsc();
    try {
      const urls = chain === "one" ? ENDPOINTS.one : ENDPOINTS.bsc;
      const reads = await Promise.all(
        urls.map((u) => readSide(chain, u, block)),
      );
      let finalizedOk = true;
      if (chain === "bsc")
        for (const u of urls) {
          const f = await call<{ number: string }>(u, "eth_getBlockByNumber", [
            "finalized",
            false,
          ]);
          if (BigInt(f.number) < BigInt(block)) finalizedOk = false;
        }
      return { block, reads, attempts: attempt, finalizedOk };
    } catch (e) {
      lastError = e;
      log(
        `${chain} read attempt ${attempt} failed: ${String((e as Error).message).slice(0, 200)}`,
      );
    }
  }
  throw lastError;
}

// ------------------------------------------------------------------ logs
async function getLogs(
  url: string,
  filter: Record<string, unknown>,
  from: number,
  to: number,
  span: number,
): Promise<RawLog[]> {
  const out: RawLog[] = [];
  for (let a = from; a <= to; a += span) {
    const b = Math.min(a + span - 1, to);
    out.push(...(await getRange(url, filter, a, b)));
  }
  return out;
}
async function getRange(
  url: string,
  filter: Record<string, unknown>,
  a: number,
  b: number,
): Promise<RawLog[]> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await raw(url, "eth_getLogs", [
      { ...filter, fromBlock: hx(a), toBlock: hx(b) },
    ]);
    const res = (r.json as { result?: RawLog[] } | null)?.result;
    if (Array.isArray(res)) return res;
    const msg = JSON.stringify(
      (r.json as { error?: unknown } | null)?.error ?? r.error ?? r.status,
    );
    if (
      /block range|too many|response size|more than \d+ results|limit exceeded/i.test(
        msg,
      ) &&
      b > a
    ) {
      const m = Math.floor((a + b) / 2);
      return [
        ...(await getRange(url, filter, a, m)),
        ...(await getRange(url, filter, m + 1, b)),
      ];
    }
    await new Promise((res2) => setTimeout(res2, 1500 * (attempt + 1)));
  }
  throw new Error(`LOGS_UNAVAILABLE ${url} ${a}-${b}`);
}
const WATCHED_TOPICS = WATCHED_EVENTS.map((s) => keccak256(toHex(s)));
const TOPIC_NAME = Object.fromEntries(
  WATCHED_EVENTS.map((s) => [keccak256(toHex(s)), s]),
);
const TRANSFER = keccak256(toHex("Transfer(address,address,uint256)"));
const INITIATED = keccak256(
  toHex(
    "BridgeInitiated(uint256,uint256,address,address,address,address,uint256,uint256,uint256,bytes,uint256)",
  ),
);
function driftScan(
  chain: "one" | "bsc",
  contract: string,
  from: number,
  to: number,
  logs: RawLog[],
): DriftScan {
  return {
    chain,
    contract,
    from,
    to,
    complete: true,
    events: logs
      .filter((l) => TOPIC_NAME[l.topics[0]])
      .map((l) => ({
        event: TOPIC_NAME[l.topics[0]],
        block: Number(BigInt(l.blockNumber)),
        tx: l.transactionHash,
      })),
  };
}
function decodeInitiated(l: RawLog) {
  try {
    const d = decodeEventLog({
      abi: LEDGER_EVENT_ABI,
      data: l.data as Hex,
      topics: l.topics as [Hex, ...Hex[]],
      strict: true,
    });
    return d.eventName === "BridgeInitiated" ? d.args : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ V1.6 accepted baseline (hash-verified)
function g5Check(): {
  check: G5DecisionCheck;
  baseline: LedgerState;
  selectorInLiveDispatcher: boolean;
  liveAbi: Abi;
} {
  const manifest = Object.entries(
    JSON.parse(
      readFileSync(join(V16_ROOT, "manifests", "SHA256_MANIFEST.json"), "utf8"),
    ) as Record<string, string>,
  );
  let verified = 0;
  for (const [f, h] of manifest)
    if (sha256(readFileSync(join(V16_ROOT, "manifests", f))) === h) verified++;
  const decisionText = readFileSync(
    join(V16_ROOT, "manifests", "G5_DECISION.json"),
    "utf8",
  );
  const decision = JSON.parse(decisionText);
  const entry = manifest.find(([f]) => f === "G5_DECISION.json");
  const rec = JSON.parse(
    readFileSync(
      join(V16_ROOT, "manifests", "reserve-reconciliation.json"),
      "utf8",
    ),
  );
  const snap = JSON.parse(
    readFileSync(
      join(V16_ROOT, "manifests", "G5_CURRENT_ROUTE_SNAPSHOT.json"),
      "utf8",
    ),
  );
  if (
    rec.pinnedBlock !== V16.ledgerPin ||
    snap.bsc.block !== V16.ledgerPin ||
    rec.ledgerReconciled !== true
  )
    throw new Error("V16_BASELINE_INCONSISTENT");
  const baseline: LedgerState = {
    block: rec.pinnedBlock,
    balance: BigInt(rec.physicalCrossBaseUnits),
    deposited: BigInt(rec.deposited),
    pendingAmount: BigInt(rec.pendingAmount),
    nextFinalize: BigInt(snap.bsc.nextFinalizeIndex),
    nextInitiate: BigInt(snap.bsc.nextInitiateIndex),
    pending: rec.activePendingRecords.map(
      (p: { index: string; value: string }) => ({
        index: BigInt(p.index),
        value: BigInt(p.value),
      }),
    ),
  };
  const matrix = JSON.parse(
    readFileSync(
      join(V16_ROOT, "security", "abi-selector-matrix.json"),
      "utf8",
    ),
  );
  const row = matrix.chains.one.rows.find(
    (r: { selector: string }) => r.selector === BRIDGE_TOKEN_SELECTOR,
  );
  const built = JSON.parse(
    readFileSync(
      join(V16_ROOT, "build", "one", "standard-json-output-native.json"),
      "utf8",
    ),
  );
  const liveAbi = built.contracts["src/CrossBridge.sol"].CrossBridge.abi as Abi;
  return {
    check: {
      decisionStatus: decision.status,
      decisionFileSha256Matches: !!entry && sha256(decisionText) === entry[1],
      manifestFilesVerified: verified,
      manifestFilesTotal: manifest.length,
      g5StatusConstant: G5_STATUS,
      decisionPinsMatchRoutePins:
        decision.source.implementation ===
          G5_ROUTE_PINS.source.implementation &&
        decision.source.runtimeHash ===
          G5_ROUTE_PINS.source.implementationCodeHash &&
        decision.destination.implementation ===
          G5_ROUTE_PINS.destination.implementation &&
        decision.destination.runtimeHash ===
          G5_ROUTE_PINS.destination.implementationCodeHash,
    },
    baseline,
    selectorInLiveDispatcher:
      row?.inLiveDispatcher === true &&
      row.signature.startsWith("bridgeToken("),
    liveAbi,
  };
}
function expectedErrorSelector(liveAbi: Abi, name: string) {
  const item = liveAbi.find((x) => x.type === "error" && x.name === name) as
    { inputs: { type: string }[] } | undefined;
  if (!item) throw new Error(`ERROR_NOT_IN_EXACT_ABI ${name}`);
  return selectorOf(`${name}(${item.inputs.map((i) => i.type).join(",")})`);
}

// ------------------------------------------------------------------ simulation (exact unsigned tx, pinned block)
async function simulate(
  url: string,
  block: string,
  one: SideRead,
  liveAbi: Abi,
): Promise<SimulationRead> {
  const f = one.fees!;
  const amount = BigInt(f.minimum),
    nf = BigInt(f.networkFee),
    ex = BigInt(f.exFee);
  const value = amount + nf + ex;
  const data = encodePilotCalldata({
    account: PILOT_EOA,
    recipient: PILOT_EOA,
    amount,
    networkFee: nf,
    serviceFee: ex,
  });
  const tx = {
    from: PILOT_EOA,
    to: G5_ROUTE_PINS.source.proxy,
    data,
    value: hx(value),
  };
  const outcome = (r: Awaited<ReturnType<typeof raw>>) => {
    const j = r.json as {
      result?: string;
      error?: { code?: number; message?: string; data?: unknown };
    } | null;
    return j && "result" in j && j.result !== undefined
      ? { ok: true, result: j.result }
      : { ok: false, error: j?.error ?? r.error ?? `HTTP ${r.status}` };
  };
  const [ethCall, estimate, gasPrice, prio, header] = await Promise.all([
    raw(url, "eth_call", [tx, block]),
    raw(url, "eth_estimateGas", [tx, block]),
    call<string>(url, "eth_gasPrice", []),
    call<string>(url, "eth_maxPriorityFeePerGas", []),
    call<{ baseFeePerGas?: string; hash: string }>(
      url,
      "eth_getBlockByNumber",
      [block, false],
    ),
  ]);
  const enc = (args: {
    chain?: bigint;
    token?: string;
    to?: string;
    amount?: bigint;
    nf?: bigint;
  }) =>
    encodePilotCalldataRaw(
      args.chain ?? 56n,
      args.token ?? NATIVE,
      args.to ?? PILOT_EOA,
      args.amount ?? amount,
      args.nf ?? nf,
      ex,
    );
  const controls: Record<string, { data: string; value: bigint }> = {
    belowMinimumByOneWei: {
      data: enc({ amount: amount - 1n }),
      value: value - 1n,
    },
    msgValueMinusOneWei: { data, value: value - 1n },
    networkFeeBelowRequiredByOneWei: {
      data: enc({ nf: nf - 1n }),
      value: value - 1n,
    },
    zeroRecipient: {
      data: enc({ to: "0x0000000000000000000000000000000000000000" }),
      value,
    },
    unsupportedTokenCrossOnOne: { data: enc({ token: CROSS }), value },
    unsupportedDestinationChain97: { data: enc({ chain: 97n }), value },
  };
  const negatives: NegativeRead[] = await Promise.all(
    NEGATIVE_CONTROLS.map(async (c) => {
      const r = await raw(url, "eth_call", [
        {
          from: PILOT_EOA,
          to: G5_ROUTE_PINS.source.proxy,
          data: controls[c.name].data,
          value: hx(controls[c.name].value),
        },
        block,
      ]);
      const err = (r.json as { error?: { data?: unknown } } | null)?.error;
      const errData = typeof err?.data === "string" ? err.data : null;
      let errorName: string | null = null,
        decoded: string | null = null;
      if (errData)
        try {
          const e = decodeErrorResult({ abi: liveAbi, data: errData as Hex });
          errorName = e.errorName;
          decoded = `${e.errorName}(${(e.args ?? []).map(String).join(",")})`;
        } catch {
          decoded = "UNDECODED";
        }
      return {
        name: c.name,
        rejected: Boolean(err),
        selector: errData ? errData.slice(0, 10) : null,
        errorName,
        decoded,
        expectedError: c.error,
        expectedSelector: expectedErrorSelector(liveAbi, c.error),
      };
    }),
  );
  // exact-argument check for the msg.value control: BaseBridgeInvalidValue(expected, provided)
  const mv = negatives.find((n) => n.name === "msgValueMinusOneWei");
  if (mv && mv.decoded !== `BaseBridgeInvalidValue(${value},${value - 1n})`)
    mv.errorName = `UNEXPECTED_ARGS:${mv.decoded}`;
  const after = await call<{ hash: string }>(url, "eth_getBlockByNumber", [
    block,
    false,
  ]);
  return {
    url,
    block: Number(BigInt(block)),
    blockHash: header.hash,
    blockHashAfter: after.hash,
    ethCall: outcome(ethCall),
    estimateGas: outcome(estimate),
    negatives,
    gasPrice: BigInt(gasPrice).toString(),
    maxPriorityFeePerGas: BigInt(prio).toString(),
    baseFeePerGas: BigInt(header.baseFeePerGas ?? "0x0").toString(),
  };
}
function encodePilotCalldataRaw(
  chain: bigint,
  token: string,
  to: string,
  amount: bigint,
  nf: bigint,
  ex: bigint,
) {
  return encodeFunctionData({
    abi: parseAbi([
      "function bridgeToken(uint256,address,address,uint256,uint256,uint256,bytes) payable returns (bool)",
    ]),
    functionName: "bridgeToken",
    args: [chain, token as Hex, to as Hex, amount, nf, ex, "0x"],
  });
}

// ------------------------------------------------------------------ in-flight (ONE initiated, not BSC finalized)
async function inFlight(
  oneLogs: RawLog[],
  bscNextFinalize: bigint,
  oneNextInitiate: bigint,
  oneBlock: number,
): Promise<InFlight> {
  const items: InFlight["items"] = [];
  let enumerated = true;
  for (let i = bscNextFinalize; i < oneNextInitiate; i++) {
    let found = oneLogs.filter(
      (l) =>
        l.topics[0] === INITIATED &&
        BigInt(l.topics[1]) === 56n &&
        BigInt(l.topics[2]) === i,
    );
    if (found.length === 0)
      found = await getLogs(
        ENDPOINTS.one[0],
        {
          address: G5_ROUTE_PINS.source.proxy,
          topics: [INITIATED, pad(toHex(56n)), pad(toHex(i))],
        },
        Math.max(0, oneBlock - 200000),
        oneBlock,
        300000,
      );
    const a = found.length === 1 ? decodeInitiated(found[0]) : null;
    if (!a) {
      enumerated = false;
      items.push({ index: i.toString(), found: found.length });
      continue;
    }
    items.push({
      index: i.toString(),
      found: 1,
      value: a.value.toString(),
      toToken: a.toToken.toLowerCase(),
      tx: found[0].transactionHash,
    });
  }
  return {
    enumerated,
    bscNextFinalize: bscNextFinalize.toString(),
    oneNextInitiate: oneNextInitiate.toString(),
    items,
  };
}

// ------------------------------------------------------------------ main
const started = Date.now();
// A previous run's root artifacts must never survive as if they were current: they are removed only when a
// byte-identical copy is preserved in an evidence package of this run root; otherwise the run refuses to start.
const ROOT_ARTIFACTS = [
  "G7_PREP_DECISION.json",
  "G7_UNSIGNED_TRANSACTION.json",
  "G7_INTENT_DIGEST.json",
];
for (const name of ROOT_ARTIFACTS) {
  const p = join(REPO, name);
  if (!existsSync(p)) continue;
  const h = sha256(readFileSync(p));
  const preserved = readdirSync(join(REPO, ROOT_REL), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .some((d) => {
      const copy = join(REPO, ROOT_REL, d.name, "package", name);
      return existsSync(copy) && sha256(readFileSync(copy)) === h;
    });
  if (!preserved)
    throw new Error(`UNPRESERVED_ROOT_ARTIFACT ${name}: refusing to overwrite`);
  rmSync(p);
}
const g5 = g5Check();
log("P1 inputs", g5.check);
const priorRuns = existsSync(join(OUT, "attempts.json"))
  ? JSON.parse(readFileSync(join(OUT, "attempts.json"), "utf8"))
  : [];

// Phase A — stable evidence
log("phase A: BSC pin (finalized) + dual-source state");
const bscA = await readBoth("bsc");
log("phase A: ONE pin (head-3) + dual-source state");
const oneA = await readBoth("one");
const Fa = Number(BigInt(bscA.block)),
  Aa = Number(BigInt(oneA.block));
write("phase-a/bsc-sides.json", bscA);
write("phase-a/one-sides.json", oneA);
const noderealHashA = (
  await call<{ hash: string }>(ENDPOINTS.bscLogs[0], "eth_getBlockByNumber", [
    bscA.block,
    false,
  ])
).hash;
log(
  "phase A: logs (BSC proxy + CROSS transfers since V1.6 ledger pin; ONE proxy since V1.6 drift pin; verifiers)",
);
const bscProxyLogs = await getLogs(
  ENDPOINTS.bscLogs[0],
  { address: G5_ROUTE_PINS.destination.proxy },
  V16.ledgerPin + 1,
  Fa,
  50000,
);
const PAD_PROXY = pad(G5_ROUTE_PINS.destination.proxy as Hex);
const crossIn = await getLogs(
  ENDPOINTS.bscLogs[0],
  { address: CROSS, topics: [TRANSFER, null, PAD_PROXY] },
  V16.ledgerPin + 1,
  Fa,
  50000,
);
const crossOut = await getLogs(
  ENDPOINTS.bscLogs[0],
  { address: CROSS, topics: [TRANSFER, PAD_PROXY] },
  V16.ledgerPin + 1,
  Fa,
  50000,
);
const bscVerifierLogs = await getLogs(
  ENDPOINTS.bscLogs[0],
  { address: G5_ROUTE_PINS.destination.verifier, topics: [WATCHED_TOPICS] },
  V16.snapshotPin.bsc + 1,
  Fa,
  50000,
);
const oneProxyLogs = await getLogs(
  ENDPOINTS.one[0],
  { address: G5_ROUTE_PINS.source.proxy },
  V16.snapshotPin.one + 1,
  Aa,
  300000,
);
const oneVerifierLogs = await getLogs(
  ENDPOINTS.one[0],
  { address: G5_ROUTE_PINS.source.verifier, topics: [WATCHED_TOPICS] },
  V16.snapshotPin.one + 1,
  Aa,
  300000,
);
write("phase-a/logs-raw.json", {
  noderealBlockHashAtPin: noderealHashA,
  bscPinHash: bscA.reads[0].blockHash,
  bscProxyLogs,
  crossIn,
  crossOut,
  bscVerifierLogs,
  oneProxyLogs,
  oneVerifierLogs,
});
const liveState = (s: SideRead, block: number): LedgerState => ({
  block,
  balance: BigInt(s.token!.balanceOfBridge),
  deposited: BigInt(s.pair.deposited),
  pendingAmount: BigInt(s.pair.pendingAmount),
  nextFinalize: BigInt(s.nextFinalizeIndex),
  nextInitiate: BigInt(s.nextInitiateIndex),
  pending: s.pending
    .filter((p) => p.toToken === CROSS.toLowerCase())
    .map((p) => ({ index: BigInt(p.index), value: BigInt(p.value) })),
});
const consts = {
  proxy: G5_ROUTE_PINS.destination.proxy,
  cross: CROSS,
  dev: EXTENDED_PINS.bsc.dev,
  sourceChainId: 612055n,
};
const ledgerA = reconcileLedgerDelta(
  g5.baseline,
  liveState(bscA.reads[0], Fa),
  bscProxyLogs,
  [...crossIn, ...crossOut],
  consts,
);
const inFlightA = await inFlight(
  oneProxyLogs,
  BigInt(bscA.reads[0].nextFinalizeIndex),
  BigInt(oneA.reads[0].nextInitiateIndex),
  Aa,
);
write("phase-a/ledger-delta.json", ledgerA);
write("phase-a/in-flight.json", inFlightA);
log("phase A ledger", {
  reconciled: ledgerA.reconciled,
  checks: ledgerA.checks,
  inFlight: inFlightA.items.length,
  enumerated: inFlightA.enumerated,
});

// Historical settlement-time observation (ONE BridgeInitiated time -> BSC BridgeFinalized time, same index).
const oneInit = new Map<string, number>();
for (const l of oneProxyLogs) {
  const a = l.topics[0] === INITIATED ? decodeInitiated(l) : null;
  if (a && a.toChainID === 56n) oneInit.set(a.index.toString(), Number(a.time));
}
const latencies = ledgerA.settlement
  .filter((s) => oneInit.has(s.index))
  .map((s) => ({ index: s.index, seconds: s.bscTime - oneInit.get(s.index)! }))
  .sort((x, y) => x.seconds - y.seconds);
const q = (p: number) =>
  latencies.length
    ? latencies[
        Math.min(latencies.length - 1, Math.floor(p * latencies.length))
      ].seconds
    : null;
const settlementBaseline = {
  label: "historical observation, not guarantee",
  source:
    "ONE BridgeInitiated(toChainID=56).time vs BSC BridgeFinalized(fromChainID=612055, same index).time in the scanned windows",
  windows: { one: [V16.snapshotPin.one + 1, Aa], bsc: [V16.ledgerPin + 1, Fa] },
  samples: latencies.length,
  minSeconds: latencies[0]?.seconds ?? null,
  medianSeconds: q(0.5),
  p90Seconds: q(0.9),
  p99Seconds: q(0.99),
  maxSeconds: latencies.at(-1)?.seconds ?? null,
  acceptedProofs: [
    { index: "98483", seconds: 20 },
    { index: "98728", seconds: 17 },
    { index: "98727", seconds: 14 },
  ],
  latencies,
};
write("phase-a/settlement-baseline.json", settlementBaseline);

// Phase B — ephemeral, fresh, final observation set (refreshed when the 60 s window is missed)
const attempts: unknown[] = [...priorRuns];
let final: Record<string, unknown> | null = null;
for (let attempt = 1; attempt <= 3 && !final; attempt++) {
  const quoteObservedAt = Date.now();
  log(`phase B attempt ${attempt}: fresh re-pin, fees, simulation`);
  const bscB = await readBoth("bsc");
  const oneB = await readBoth("one");
  const Fb = Number(BigInt(bscB.block)),
    Ab = Number(BigInt(oneB.block));
  const one = oneB.reads[0],
    bsc = bscB.reads[0];
  const sims = await Promise.all(
    ENDPOINTS.one.map((u) => simulate(u, oneB.block, one, g5.liveAbi)),
  );
  // reserve extension: phase-A live state -> phase-B pin (same semantics), and drift events in the extension
  const extFrom = Fa + 1;
  const [pB, inB, outB, vB, oB, ovB] = await Promise.all([
    Fb >= extFrom
      ? getLogs(
          ENDPOINTS.bscLogs[0],
          { address: G5_ROUTE_PINS.destination.proxy },
          extFrom,
          Fb,
          50000,
        )
      : [],
    Fb >= extFrom
      ? getLogs(
          ENDPOINTS.bscLogs[0],
          { address: CROSS, topics: [TRANSFER, null, PAD_PROXY] },
          extFrom,
          Fb,
          50000,
        )
      : [],
    Fb >= extFrom
      ? getLogs(
          ENDPOINTS.bscLogs[0],
          { address: CROSS, topics: [TRANSFER, PAD_PROXY] },
          extFrom,
          Fb,
          50000,
        )
      : [],
    Fb >= extFrom
      ? getLogs(
          ENDPOINTS.bscLogs[0],
          {
            address: G5_ROUTE_PINS.destination.verifier,
            topics: [WATCHED_TOPICS],
          },
          extFrom,
          Fb,
          50000,
        )
      : [],
    Ab > Aa
      ? getLogs(
          ENDPOINTS.one[0],
          { address: G5_ROUTE_PINS.source.proxy },
          Aa + 1,
          Ab,
          300000,
        )
      : [],
    Ab > Aa
      ? getLogs(
          ENDPOINTS.one[0],
          { address: G5_ROUTE_PINS.source.verifier, topics: [WATCHED_TOPICS] },
          Aa + 1,
          Ab,
          300000,
        )
      : [],
  ]);
  const noderealHashB = (
    await call<{ hash: string }>(ENDPOINTS.bscLogs[0], "eth_getBlockByNumber", [
      bscB.block,
      false,
    ])
  ).hash;
  const ledgerB = reconcileLedgerDelta(
    liveState(bscA.reads[0], Fa),
    liveState(bsc, Fb),
    pB,
    [...inB, ...outB],
    consts,
  );
  // The phase-B ledger is valid only when the phase-A ledger (from the accepted V1.6 pin) also reconciled.
  const ledger: LedgerDeltaResult = {
    ...ledgerB,
    from: ledgerA.from,
    checks: {
      ...ledgerB.checks,
      PHASE_A_FROM_V16_PIN_RECONCILED: ledgerA.reconciled,
      LOG_SOURCE_BLOCK_HASH_MATCHES_PIN:
        noderealHashA === bscA.reads[0].blockHash &&
        noderealHashB === bsc.blockHash,
    },
  };
  ledger.reconciled = Object.values(ledger.checks).every(Boolean);
  const inFlightB = await inFlight(
    [...oneProxyLogs, ...oB],
    BigInt(bsc.nextFinalizeIndex),
    BigInt(one.nextInitiateIndex),
    Ab,
  );
  const driftScans: DriftScan[] = [
    driftScan("one", G5_ROUTE_PINS.source.proxy, V16.snapshotPin.one + 1, Ab, [
      ...oneProxyLogs,
      ...oB,
    ]),
    driftScan(
      "one",
      G5_ROUTE_PINS.source.verifier,
      V16.snapshotPin.one + 1,
      Ab,
      [...oneVerifierLogs, ...ovB],
    ),
    driftScan(
      "bsc",
      G5_ROUTE_PINS.destination.proxy,
      V16.snapshotPin.bsc + 1,
      Fb,
      [...bscProxyLogs, ...pB],
    ),
    driftScan(
      "bsc",
      G5_ROUTE_PINS.destination.verifier,
      V16.snapshotPin.bsc + 1,
      Fb,
      [...bscVerifierLogs, ...vB],
    ),
  ];
  const reserve = deriveSpendableReserve({
    token: CROSS,
    balance: BigInt(bsc.token!.balanceOfBridge),
    deposited: BigInt(bsc.pair.deposited),
    pendingAmount: BigInt(bsc.pair.pendingAmount),
    pending: bsc.pending.map((p) => ({
      index: BigInt(p.index),
      toToken: p.toToken,
      value: BigInt(p.value),
    })),
    pendingComplete: bscB.reads.every(
      (s) => canonicalJson(s.pending) === canonicalJson(bsc.pending),
    ),
    inFlight: {
      enumerated: inFlightB.enumerated,
      expectedCount: inFlightB.items.length,
      values: inFlightB.items
        .filter(
          (x) => x.value !== undefined && x.toToken === CROSS.toLowerCase(),
        )
        .map((x) => BigInt(x.value!)),
    },
    sourceMinted: BigInt(one.pair.minted),
    minimum: BigInt(one.fees!.minimum),
    driftState: evaluateRouteDrift(observedRoute(one, bsc)).state,
  });
  // ---- unsigned transaction from the fresh quote
  const quote = quoteFromFees(one.fees!, quoteObservedAt, one);
  const intent = {
    account: PILOT_EOA,
    recipient: PILOT_EOA,
    amount: quote.amount,
    networkFee: quote.networkFee,
    serviceFee: quote.serviceFee,
  };
  const data = encodePilotCalldata(intent);
  const calldata = verifyCalldata(data, intent);
  const estimate = sims[0].estimateGas.ok
    ? BigInt(sims[0].estimateGas.result!)
    : 0n;
  let gas;
  try {
    gas = gasPlan(
      estimate,
      sims.map((s) => BigInt(s.gasPrice)),
      sims.map((s) => BigInt(s.maxPriorityFeePerGas)),
      BigInt(sims[0].baseFeePerGas),
    );
  } catch {
    gas = gasPlan(21001n, [0n], [0n], 0n); // placeholder only; P15 fails closed on the missing estimate
  }
  const tx = {
    chainId: "612055",
    from: PILOT_EOA,
    to: G5_ROUTE_PINS.source.proxy,
    value: quote.value.toString(),
    data,
  };
  const quoteId = `g7-prep-${ROOT_REL.split("/").pop()}-${LABEL}-${Ab}`;
  const expected = expectedFirewallIntent(quote, quoteId);
  const entry = g7ContractEntry(one, quoteObservedAt);
  const expectedPins = expectedPinsView();
  const observedPins = routePinsView(one, bsc);
  const ctx = {
    entry,
    quote,
    expectedCalldata: data,
    pinsDigestExpected: pinsDigest(expectedPins),
    pinsDigestObserved: pinsDigest(observedPins),
    implementationHashObserved: one.implementationCodeHash,
    platformFeeBps: platformFeePolicy.bps,
    approval: { spender: null, amount: "0" },
  };
  const now = Date.now();
  const positive = g7Firewall(tx, expected, ctx, now);
  const mutations = firewallMutations(tx, expected, ctx, intent, now);
  const gate = productionGateStaysClosed(tx, expected, entry, now);
  const scan = scanG7Sources();
  const methodsUsed = Object.fromEntries(rpc.counts);
  const auditLines = readFileSync(AUDIT, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as RpcAuditRecord);
  const writeSafety = {
    execution: rpc.execution.snapshot(),
    rpcMethodsUsed: methodsUsed,
    forbiddenMethodCalls: auditLines.filter(
      (r) =>
        !/^(eth_(chainId|blockNumber|getBlockByNumber|getBlockByHash|getCode|getStorageAt|call|estimateGas|getLogs|getBalance|getTransactionCount|getTransactionByHash|getTransactionReceipt|gasPrice|maxPriorityFeePerGas|feeHistory))$/.test(
          r.method,
        ),
    ).length,
    stateOverrideCalls: auditLines.filter(
      (r) =>
        (r.method === "eth_call" || r.method === "eth_estimateGas") &&
        r.params.length > 2,
    ).length,
    staticScanPass: scan.contentPass,
    protectedBaselinePass: scan.protectedBaselinePass,
    gate,
    feePolicyEnabled: platformFeePolicy.enabled,
    feePolicyBps: platformFeePolicy.bps,
  };
  const decisionAt = Date.now();
  const prepInput: PrepInput = {
    g5: g5.check,
    one: oneB.reads,
    bsc: bscB.reads,
    driftScans,
    ledger,
    inFlight: inFlightB,
    reserve,
    bscBlockFinalized: bscB.finalizedOk,
    simulations: sims,
    quote,
    gas,
    intent,
    calldata,
    selectorInLiveDispatcher:
      g5.selectorInLiveDispatcher &&
      oneB.reads.every(
        (s) =>
          (s as SideRead & { dispatcherHasBridgeToken?: boolean })
            .dispatcherHasBridgeToken === true,
      ),
    firewall: { positive, mutations },
    writeSafety,
    decisionAt,
  };
  const evaluation = evaluateGates(prepInput);
  // Self-test on the real final data: every hostile mutation must leave READY, otherwise the run is BLOCKED.
  const hostile = hostileReplay(prepInput);
  if (!hostile.allFailClosed) {
    const p17 = evaluation.gates.find((g) => g.id === "P17")!;
    p17.status = "FAIL";
    p17.reasons.push(
      ...hostile.results
        .filter((r) => !r.failClosed)
        .map((r) => `HOSTILE_REPLAY_NOT_FAIL_CLOSED:${r.name}`),
    );
    evaluation.status = "BLOCKED";
    evaluation.blockedReasons.push(
      `BLOCKED_TRANSACTION_FIREWALL_PASS (P17: ${p17.reasons.join("; ")})`,
    );
  }
  const attemptRecord = {
    attempt,
    label: LABEL,
    quoteObservedAt: new Date(quoteObservedAt).toISOString(),
    decisionAt: new Date(decisionAt).toISOString(),
    quoteAgeMs: decisionAt - quoteObservedAt,
    status: evaluation.status,
    failed: evaluation.gates
      .filter((g) => g.status !== "PASS")
      .map((g) => `${g.id}:${g.reasons.join("|")}`),
  };
  attempts.push(attemptRecord);
  const dir = `phase-b/attempt-${attempt}`;
  write(`${dir}/bsc-sides.json`, bscB);
  write(`${dir}/one-sides.json`, oneB);
  write(`${dir}/simulations.json`, sims);
  write(`${dir}/ledger-extension.json`, {
    ledger,
    logs: {
      proxy: pB,
      crossIn: inB,
      crossOut: outB,
      bscVerifier: vB,
      oneProxy: oB,
      oneVerifier: ovB,
    },
    noderealHashB,
  });
  write(`${dir}/in-flight.json`, inFlightB);
  write(`${dir}/reserve.json`, reserve);
  write(`${dir}/drift-scans.json`, driftScans);
  write(`${dir}/quote.json`, quote);
  write(`${dir}/gas.json`, gas);
  write(`${dir}/calldata.json`, calldata);
  write(`${dir}/firewall.json`, {
    tx,
    expected,
    entry,
    ctx: { ...ctx, entry: undefined },
    positive,
    mutations,
    productionGate: gate,
    pins: { expected: expectedPins, observed: observedPins },
  });
  write(`${dir}/safety-scan.json`, scan);
  write(`${dir}/write-safety.json`, writeSafety);
  write(`${dir}/gates.json`, evaluation);
  write(`${dir}/hostile-replay.json`, hostile);
  log(`attempt ${attempt}`, attemptRecord);
  const staleOnly =
    evaluation.status === "BLOCKED" &&
    evaluation.gates
      .filter((g) => g.status === "FAIL")
      .every((g) => g.id === "P19");
  if (staleOnly && attempt < 3) continue; // refresh the ephemeral layer; older attempt kept as diagnostics
  final = {
    attempt,
    quote,
    gas,
    intent,
    calldata,
    tx,
    expected,
    entry,
    positive,
    mutations,
    gate,
    scan,
    writeSafety,
    evaluation,
    hostile,
    sims,
    one,
    bsc,
    oneB,
    bscB,
    ledger,
    inFlightB,
    reserve,
    driftScans,
    observedPins,
    ctx,
    decisionAt,
  };
}
write("attempts.json", attempts);
if (!final) throw new Error("NO_FINAL_ATTEMPT");

// ------------------------------------------------------------------ artifacts
type Final = {
  attempt: number;
  hostile: ReturnType<typeof hostileReplay>;
  quote: ReturnType<typeof quoteFromFees>;
  gas: ReturnType<typeof gasPlan>;
  intent: Parameters<typeof verifyCalldata>[1];
  calldata: ReturnType<typeof verifyCalldata>;
  tx: {
    chainId: string;
    from: string;
    to: string;
    value: string;
    data: string;
  };
  expected: ReturnType<typeof expectedFirewallIntent>;
  positive: ReturnType<typeof g7Firewall>;
  mutations: ReturnType<typeof firewallMutations>;
  gate: ReturnType<typeof productionGateStaysClosed>;
  scan: ReturnType<typeof scanG7Sources>;
  writeSafety: unknown;
  evaluation: ReturnType<typeof evaluateGates>;
  sims: SimulationRead[];
  one: SideRead;
  bsc: SideRead;
  oneB: { block: string };
  bscB: { block: string; finalizedOk: boolean };
  ledger: LedgerDeltaResult;
  inFlightB: InFlight;
  reserve: ReturnType<typeof deriveSpendableReserve>;
  observedPins: ReturnType<typeof routePinsView>;
  decisionAt: number;
};
const F = final as unknown as Final;
const status = F.evaluation.status;
const ready = status === "READY_FOR_OWNER_SIGNATURE";
const x = exposure(F.quote, F.gas);
const gateOf = (id: string) =>
  F.evaluation.gates.find((g) => g.id === id)!.status;
const passAll = (...ids: string[]) =>
  ids.every((id) => gateOf(id) === "PASS") ? "PASS" : "FAIL";
const iso = (ms: number) => new Date(ms).toISOString();
const counters = {
  realSignatures: 0,
  approvals: 0,
  permits: 0,
  broadcasts: 0,
  deploys: 0,
  feeCollection: 0,
  walletPrompts: 0,
  executionGateChanges: 0,
};
const trustModel = {
  statement: TRUST_STATEMENT,
  admin: {
    addresses: F.one.bridgeRoles.ADMIN_ROLE,
    defaultAdmin: F.one.bridgeRoles.DEFAULT_ADMIN_ROLE,
    kind: "single EOA (empty code at the pinned blocks on both chains), instant UUPS upgrade authority",
  },
  validators: F.one.bridgeRoles.VALIDATOR_ROLE,
  threshold: F.one.threshold,
  verifierRole: F.one.bridgeRoles.VERIFIER_ROLE,
  sameSetsOnBothChains:
    canonicalJson([
      F.one.bridgeRoles.VALIDATOR_ROLE,
      F.one.bridgeRoles.ADMIN_ROLE,
      F.one.threshold,
    ]) ===
    canonicalJson([
      F.bsc.bridgeRoles.VALIDATOR_ROLE,
      F.bsc.bridgeRoles.ADMIN_ROLE,
      F.bsc.threshold,
    ]),
  ownerAcceptanceRequired: TRUST_ACCEPTANCE_SENTENCE,
  trustModelAccepted: false,
};
const routePins = {
  policyVersion: G7_POLICY_VERSION,
  digestSha256: pinsDigest(F.observedPins),
  expectedDigestSha256: pinsDigest(expectedPinsView()),
  source: {
    chainId: 612055,
    proxy: G5_ROUTE_PINS.source.proxy,
    proxyCodeHash: F.one.proxyCodeHash,
    implementation: F.one.implementation,
    implementationCodeHash: F.one.implementationCodeHash,
    verifier: F.one.verifier,
    verifierCodeHash: F.one.verifierCodeHash,
    build: G5_ROUTE_PINS.source.build.commit,
  },
  destination: {
    chainId: 56,
    proxy: G5_ROUTE_PINS.destination.proxy,
    proxyCodeHash: F.bsc.proxyCodeHash,
    implementation: F.bsc.implementation,
    implementationCodeHash: F.bsc.implementationCodeHash,
    verifier: F.bsc.verifier,
    verifierCodeHash: F.bsc.verifierCodeHash,
    token: CROSS,
    tokenCodeHash: F.bsc.token!.codeHash,
    tokenDecimals: F.bsc.token!.decimals,
    build: G5_ROUTE_PINS.destination.build.commit,
  },
  pairs: { one: F.one.pair, bsc: { ...F.bsc.pair } },
  authority: F.observedPins,
};
const reserveView = {
  verified: F.reserve.verified,
  pinnedBlock: F.bsc.block,
  pinnedBlockHash: F.bsc.blockHash,
  finalized: F.bscB.finalizedOk,
  physicalCross: F.bsc.token!.balanceOfBridge,
  deposited: F.bsc.pair.deposited,
  pendingAmount: F.bsc.pair.pendingAmount,
  activePending: F.bsc.pending,
  activeValuedPendingCross: F.bsc.pending.filter(
    (p) => p.toToken === CROSS.toLowerCase() && BigInt(p.value) > 0n,
  ).length,
  inFlight: {
    count: F.inFlightB.items.length,
    enumerated: F.inFlightB.enumerated,
    sum: F.inFlightB.items
      .reduce((s, i) => s + BigInt(i.value ?? "0"), 0n)
      .toString(),
  },
  spendable: F.reserve.spendable.toString(),
  effectiveMaximum: F.reserve.effectiveMaximum.toString(),
  ledger: {
    reconciledFromV16Pin: F.ledger.reconciled,
    from: F.ledger.from,
    to: F.ledger.to,
    checks: F.ledger.checks,
  },
  method:
    "V1.6 model: spendable = min(balanceOf(bridge), deposited) - pendingAmount - sum(in-flight); incremental event-sourced ledger from the accepted V1.6 pin 125745332",
};
const unsigned = {
  status: ready ? "READY_FOR_OWNER_SIGNATURE" : status,
  doNotSign: !ready,
  note: "UNSIGNED preparation package. NOT SIGNED. NOT BROADCAST. G7 is NOT PASS. Ephemeral values MUST_REFRESH_BEFORE_SIGNING.",
  chainId: 612055,
  from: PILOT_EOA,
  to: G5_ROUTE_PINS.source.proxy,
  value: F.quote.value.toString(),
  valueHex: hx(F.quote.value),
  data: F.calldata.calldata,
  calldataKeccak256: F.calldata.calldataKeccak256,
  decodedIntent: {
    ...F.calldata.decoded,
    decoder: "independent (src/g7/decoder.ts) + viem cross-check",
    outputToken: CROSS,
    recipientIsSourceEoa: true,
  },
  gasEstimate: F.gas.estimate.toString(),
  recommendedGasLimit: F.gas.recommendedGasLimit.toString(),
  gasPrice: F.gas.legacyGasPrice.toString(),
  feeModel: {
    type: "EIP-1559 (baseFeePerGas present on ONEchain)",
    baseFeePerGas: F.gas.baseFeePerGas.toString(),
    maxPriorityFeePerGas: F.gas.maxPriorityFeePerGas.toString(),
    maxFeePerGas: F.gas.maxFeePerGas.toString(),
    legacyGasPrice: F.gas.legacyGasPrice.toString(),
    priceCapUsedForExposure: F.gas.priceCap.toString(),
    gasMarginPercent: F.gas.marginPercent,
  },
  maximumExposure: x.maximumExpectedWalletDebit.toString(),
  exposure: Object.fromEntries(
    Object.entries(x).map(([k, v]) => [
      k,
      { wei: v.toString(), one: formatUnits18(v) },
    ]),
  ),
  expectedDestination: {
    chainId: 56,
    token: CROSS,
    amount: x.expectedDestinationPrincipal.toString(),
    amountHuman: `${formatUnits18(x.expectedDestinationPrincipal)} CROSS`,
    semantics:
      "BSC finalize pays exactly `value` (G5-proven); fees are paid separately on ONEchain",
  },
  quoteObservedAt: iso(F.quote.observedAt),
  quoteExpiresAt: iso(F.quote.expiresAt),
  quoteAgeAtReadyMs: F.decisionAt - F.quote.observedAt,
  sourceBlock: {
    number: F.one.block,
    hash: F.one.blockHash,
    timestamp: iso(F.one.blockTimestamp * 1000),
  },
  destinationBlock: {
    number: F.bsc.block,
    hash: F.bsc.blockHash,
    timestamp: iso(F.bsc.blockTimestamp * 1000),
    finalizedTag: true,
  },
  routePins,
  reserve: reserveView,
  approval: {
    required: false,
    spender: null,
    amount: "0",
    permit: null,
    allowance: null,
  },
  otherbridgeFee: { bps: 0, amount: "0" },
  nonceObservedInformational: {
    value: F.one.nonce,
    note: "read-only preview; NOT reserved, NOT signed; the signing phase must fetch the current nonce",
  },
  layers: {
    stable: [
      "routePins",
      "reserve.method",
      "trustModel",
      "transaction structure (to, selector, argument layout, recipient=from, extraData=0x, approval none)",
    ],
    ephemeral: [
      "minimum",
      "networkFee",
      "serviceFee",
      "value",
      "gasEstimate",
      "gasPrice/feeModel",
      "quote block/time",
      "reserve snapshot",
    ],
    ephemeralStatus: "MUST_REFRESH_BEFORE_SIGNING",
  },
  noAutomaticRetry:
    "If the source transaction reverts, is rejected, replaced or uncertain: do NOT resend; explicit reconciliation first.",
  trustModel,
  trustModelAccepted: false,
  signature: null,
  txHash: null,
  broadcast: false,
};
const normalized = normalizedOwnerIntent(unsigned);
const digest = intentDigest(normalized);
const decision = {
  status,
  g7: "NOT_RUN — this is preparation only; G7 is NOT PASS",
  observedAt: iso(F.decisionAt),
  evidenceRoot: ROOT_REL,
  label: LABEL,
  attempt: F.attempt,
  pilotAmount: F.quote.amount.toString(),
  networkFee: F.quote.networkFee.toString(),
  serviceFee: F.quote.serviceFee.toString(),
  exactMsgValue: F.quote.value.toString(),
  maximumExposure: x.maximumExpectedWalletDebit.toString(),
  routeDrift: passAll("P2", "P3", "P4", "P5", "P6"),
  reserve: passAll("P8", "P9"),
  simulation: passAll("P14", "P15", "P16"),
  firewall: passAll("P17"),
  dualRpc: passAll("P18"),
  quoteFresh: gateOf("P19") === "PASS",
  quoteAgeAtReadyMs: F.decisionAt - F.quote.observedAt,
  mustRefreshBeforeSigning: true,
  trustModelAccepted: false,
  signature: null,
  txHash: null,
  broadcast: false,
  counters,
  hostileReplay: {
    cases: F.hostile.cases,
    allFailClosed: F.hostile.allFailClosed,
  },
  firewallMutations: {
    cases: F.mutations.length,
    rejected: F.mutations.filter((m) => m.rejected).length,
  },
  gates: F.evaluation.gates,
  blockedReasons: F.evaluation.blockedReasons,
  intentDigestSha256: digest.sha256,
  unsignedTransactionSha256: null as string | null,
  nextAction: ready
    ? "OWNER_REVIEW_AND_EXPLICIT_APPROVAL"
    : status === "OWNER_REAPPROVAL_REQUIRED"
      ? "OWNER_REAPPROVAL_OF_NEW_EXPOSURE"
      : "RESOLVE_BLOCKERS_AND_RERUN_PREPARATION",
};
const digestDoc = {
  digest: { sha256: digest.sha256, keccak256: digest.keccak256 },
  algorithm: digest.algorithm,
  normalizedIntent: normalized,
  canonicalJson: digest.canonicalJson,
  note: "Recompute from G7_UNSIGNED_TRANSACTION.json with normalizedOwnerIntent() before any signature; any difference = mutation = abort.",
  signature: null,
};
// The 60 s window is re-checked at the moment the artifacts are written; missing it fails closed.
const writtenAt = Date.now();
const quoteAgeAtArtifactWriteMs = writtenAt - F.quote.observedAt;
if (
  quoteAgeAtArtifactWriteMs > QUOTE_MAX_AGE_MS &&
  decision.status !== "BLOCKED"
) {
  decision.status = "BLOCKED";
  unsigned.status = "BLOCKED";
  unsigned.doNotSign = true;
  decision.quoteFresh = false;
  decision.blockedReasons.push(
    `BLOCKED_STALE_QUOTE_AT_ARTIFACT_WRITE (${quoteAgeAtArtifactWriteMs} ms)`,
  );
  decision.nextAction = "RESOLVE_BLOCKERS_AND_RERUN_PREPARATION";
}
Object.assign(decision, {
  artifactWrittenAt: iso(writtenAt),
  quoteAgeAtArtifactWriteMs,
});
const unsignedText = json(unsigned);
decision.unsignedTransactionSha256 = sha256(unsignedText);
mkdirSync(join(OUT, "package"), { recursive: true });
for (const [name, text] of [
  ["G7_UNSIGNED_TRANSACTION.json", unsignedText],
  ["G7_INTENT_DIGEST.json", json(digestDoc)],
  ["G7_PREP_DECISION.json", json(decision)],
] as const) {
  writeFileSync(join(OUT, "package", name), text);
  writeFileSync(join(REPO, name), text);
}
write("summary.json", {
  status,
  gates: F.evaluation.gates.map((g) => `${g.id} ${g.name} ${g.status}`),
  quoteAgeAtReadyMs: decision.quoteAgeAtReadyMs,
  exposure: unsigned.exposure,
  settlementBaseline: {
    samples: settlementBaseline.samples,
    median: settlementBaseline.medianSeconds,
    p90: settlementBaseline.p90Seconds,
    max: settlementBaseline.maxSeconds,
  },
  elapsedMs: Date.now() - started,
  rpcCalls: Object.fromEntries(rpc.counts),
});
log("DECISION", {
  status: decision.status,
  blockedReasons: decision.blockedReasons,
  quoteAgeAtReadyMs: decision.quoteAgeAtReadyMs,
  quoteAgeAtArtifactWriteMs,
  QUOTE_MAX_AGE_MS,
});
process.exit(decision.status === "READY_FOR_OWNER_SIGNATURE" ? 0 : 1);
