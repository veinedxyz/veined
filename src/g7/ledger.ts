// G7 fresh reserve: incremental event-sourced BSC CROSS ledger from the ACCEPTED V1.6 ledger pin to a fresh
// pinned block, using the V1.6 accounting semantics (BSCBridgeV2 @ 6da2fb2, byte-proven):
// deposit: deposited += value (fee forwarded to dev in-call); finalize: CROSS.transfer(to, value), deposited -= value;
// failed transfer: pending (pendingAmount += value); release: pay, deposited -= value, pendingAmount -= value;
// dead-wallet burn: no bridge balance / deposited effect. Every bridge CROSS movement must be classified and the
// recomputed deposited / pendingAmount / balance / open pending set / index ranges must equal the live state.
import { decodeEventLog, parseAbi, toEventSelector, type Hex } from "viem";
import { WATCHED_EVENTS } from "./policy";

export const LEDGER_EVENT_ABI = parseAbi([
  "event BridgeInitiated(uint256 indexed toChainID,uint256 indexed index,address fromToken,address toToken,address indexed from,address to,uint256 value,uint256 networkFee,uint256 exFee,bytes extraData,uint256 time)",
  "event BridgeFinalized(uint256 indexed fromChainID,uint256 indexed index,address indexed toToken,address to,uint256 value,uint256 time)",
  "event BridgePending(uint256 indexed fromChainID,uint256 indexed index,address indexed toToken,address to,uint256 value,uint256 time,uint8 status)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event ManualReleased(uint256 indexed remoteChainID,uint256 indexed index)",
  "event PendingRemoved(uint256 indexed remoteChainID,uint256 indexed index)",
]);
const WATCHED = Object.fromEntries(
  WATCHED_EVENTS.map((s) => [toEventSelector(s), s]),
) as Record<string, string>;
export const DEAD_WALLETS = new Set([
  "0x000000000000000000000000000000000000dead",
  "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
  "0xdead000000000000000000000000000000000000",
]);

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash?: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
}
export interface LedgerState {
  block: number;
  balance: bigint;
  deposited: bigint;
  pendingAmount: bigint;
  nextFinalize: bigint;
  nextInitiate: bigint;
  pending: { index: bigint; value: bigint }[];
}
export interface LedgerConstants {
  proxy: string;
  cross: string;
  dev: string;
  sourceChainId: bigint;
}
export interface SettlementSample {
  index: string;
  bscBlock: number;
  bscTime: number;
  value: string;
}
export interface LedgerDeltaResult {
  from: number;
  to: number;
  proxyLogs: number;
  transferLogs: number;
  counts: Record<string, number>;
  deposits: { count: number; sum: bigint };
  payouts: { count: number; sum: bigint };
  burns: { count: number; sum: bigint };
  feesForwarded: bigint;
  pendingCreated: bigint;
  pendingReleased: bigint;
  directInbound: { tx: string; value: bigint }[];
  selfPayouts: bigint;
  computed: {
    deposited: bigint;
    pendingAmount: bigint;
    balance: bigint;
    openPending: string[];
  };
  watchedEvents: { event: string; tx: string; block: number }[];
  unknownTopics: string[];
  unclassified: { tx: string; from: string; to: string; value: bigint }[];
  anomalies: { kind: string; tx?: string; index?: string }[];
  settlement: SettlementSample[];
  checks: Record<string, boolean>;
  reconciled: boolean;
}

const lower = (s: string) => s.toLowerCase();
const num = (h: string) => Number(BigInt(h));

export function reconcileLedgerDelta(
  base: LedgerState,
  live: LedgerState,
  proxyLogsRaw: RawLog[],
  transfersRaw: RawLog[],
  c: LedgerConstants,
): LedgerDeltaResult {
  const proxy = lower(c.proxy),
    cross = lower(c.cross),
    dev = lower(c.dev);
  const anomalies: LedgerDeltaResult["anomalies"] = [];
  const inRange = (l: RawLog) =>
    num(l.blockNumber) > base.block &&
    num(l.blockNumber) <= live.block &&
    l.removed !== true;
  const order = (a: RawLog, b: RawLog) =>
    num(a.blockNumber) - num(b.blockNumber) ||
    num(a.logIndex) - num(b.logIndex);
  const proxyLogs = [...proxyLogsRaw].sort(order);
  const seen = new Set<string>();
  const transfers = [...transfersRaw].sort(order).filter((l) => {
    const k = `${lower(l.transactionHash)}:${num(l.logIndex)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const logsInRange =
    proxyLogs.every((l) => inRange(l) && lower(l.address) === proxy) &&
    transfers.every((l) => inRange(l) && lower(l.address) === cross);

  interface Movement {
    tx: string;
    from: string;
    to: string;
    value: bigint;
    cls: string | null;
  }
  const byTx = new Map<string, Movement[]>();
  for (const t of transfers) {
    let d;
    try {
      d = decodeEventLog({
        abi: LEDGER_EVENT_ABI,
        data: t.data as Hex,
        topics: t.topics as [Hex, ...Hex[]],
        strict: true,
      });
    } catch {
      anomalies.push({ kind: "UNDECODABLE_TRANSFER", tx: t.transactionHash });
      continue;
    }
    if (d.eventName !== "Transfer") {
      anomalies.push({ kind: "NON_TRANSFER_LOG", tx: t.transactionHash });
      continue;
    }
    const m: Movement = {
      tx: lower(t.transactionHash),
      from: lower(d.args.from),
      to: lower(d.args.to),
      value: d.args.value,
      cls: null,
    };
    if (m.from !== proxy && m.to !== proxy) {
      anomalies.push({ kind: "TRANSFER_NOT_TOUCHING_BRIDGE", tx: m.tx });
      continue;
    }
    if (!byTx.has(m.tx)) byTx.set(m.tx, []);
    byTx.get(m.tx)!.push(m);
  }
  const take = (tx: string, pred: (m: Movement) => boolean, cls: string) => {
    const m = (byTx.get(lower(tx)) ?? []).find((x) => !x.cls && pred(x));
    if (m) m.cls = cls;
    return m;
  };

  let deposited = base.deposited,
    pendingAmount = base.pendingAmount;
  const open = new Map(base.pending.map((p) => [p.index, p.value]));
  const finalized = new Set<bigint>(),
    initiated = new Set<bigint>();
  const counts: Record<string, number> = {};
  const watchedEvents: LedgerDeltaResult["watchedEvents"] = [];
  const unknownTopics: string[] = [];
  const settlement: SettlementSample[] = [];
  const r = {
    deposits: { count: 0, sum: 0n },
    payouts: { count: 0, sum: 0n },
    burns: { count: 0, sum: 0n },
    feesForwarded: 0n,
    pendingCreated: 0n,
    pendingReleased: 0n,
    selfPayouts: 0n,
  };
  const proxyTxs = new Set(proxyLogs.map((l) => lower(l.transactionHash)));
  for (const l of proxyLogs) {
    const tx = lower(l.transactionHash),
      block = num(l.blockNumber);
    if (WATCHED[l.topics[0]]) {
      watchedEvents.push({ event: WATCHED[l.topics[0]], tx, block });
      counts[WATCHED[l.topics[0]]] = (counts[WATCHED[l.topics[0]]] ?? 0) + 1;
    }
    let d;
    try {
      d = decodeEventLog({
        abi: LEDGER_EVENT_ABI,
        data: l.data as Hex,
        topics: l.topics as [Hex, ...Hex[]],
        strict: true,
      });
    } catch {
      if (!WATCHED[l.topics[0]]) unknownTopics.push(l.topics[0]);
      continue;
    }
    if (!WATCHED[l.topics[0]])
      counts[d.eventName] = (counts[d.eventName] ?? 0) + 1;
    if (d.eventName === "BridgeInitiated") {
      const a = d.args;
      if (a.toChainID !== c.sourceChainId) {
        anomalies.push({ kind: "INITIATE_OTHER_CHAIN", tx });
        continue;
      }
      if (initiated.has(a.index))
        anomalies.push({
          kind: "DUPLICATE_INITIATE_INDEX",
          tx,
          index: a.index.toString(),
        });
      initiated.add(a.index);
      if (lower(a.fromToken) !== cross) continue; // other pair (e.g. USDT): no CROSS reserve effect
      const fee = a.networkFee + a.exFee;
      const inbound = take(
        tx,
        (m) => m.to === proxy && m.from !== proxy && m.value === a.value + fee,
        "DEPOSIT",
      );
      if (inbound) {
        deposited += a.value;
        r.deposits.count++;
        r.deposits.sum += a.value;
        if (fee > 0n) {
          if (
            take(
              tx,
              (m) => m.from === proxy && m.to === dev && m.value === fee,
              "FEE_FORWARD",
            )
          )
            r.feesForwarded += fee;
          else anomalies.push({ kind: "FEE_NOT_FORWARDED", tx });
        }
      } else if (DEAD_WALLETS.has(lower(a.to)) && fee === 0n) {
        r.burns.count++;
        r.burns.sum += a.value;
      } else
        anomalies.push({
          kind: "INITIATE_WITHOUT_DEPOSIT",
          tx,
          index: a.index.toString(),
        });
    } else if (d.eventName === "BridgePending") {
      const a = d.args;
      if (a.fromChainID !== c.sourceChainId) {
        anomalies.push({ kind: "PENDING_OTHER_CHAIN", tx });
        continue;
      }
      if (finalized.has(a.index) || open.has(a.index))
        anomalies.push({
          kind: "DUPLICATE_PENDING",
          tx,
          index: a.index.toString(),
        });
      finalized.add(a.index);
      if (lower(a.toToken) === cross) {
        open.set(a.index, a.value);
        pendingAmount += a.value;
        r.pendingCreated += a.value;
      }
    } else if (d.eventName === "BridgeFinalized") {
      const a = d.args;
      if (a.fromChainID !== c.sourceChainId) {
        anomalies.push({ kind: "FINALIZE_OTHER_CHAIN", tx });
        continue;
      }
      const wasPending = open.has(a.index);
      if (!wasPending && finalized.has(a.index))
        anomalies.push({
          kind: "DUPLICATE_FINALIZE",
          tx,
          index: a.index.toString(),
        });
      if (!wasPending && a.index < base.nextFinalize)
        anomalies.push({
          kind: "FINALIZE_BEHIND_BASELINE",
          tx,
          index: a.index.toString(),
        });
      finalized.add(a.index);
      if (lower(a.toToken) !== cross) continue;
      if (wasPending) {
        pendingAmount -= open.get(a.index)!;
        r.pendingReleased += open.get(a.index)!;
        open.delete(a.index);
      }
      deposited -= a.value;
      r.payouts.count++;
      r.payouts.sum += a.value;
      if (!wasPending)
        settlement.push({
          index: a.index.toString(),
          bscBlock: block,
          bscTime: Number(a.time),
          value: a.value.toString(),
        });
      if (lower(a.to) === proxy) {
        r.selfPayouts += a.value;
        take(
          tx,
          (m) => m.from === proxy && m.to === proxy && m.value === a.value,
          "SELF_PAYOUT_CBU09",
        );
      } else if (a.value > 0n) {
        if (
          !take(
            tx,
            (m) =>
              m.from === proxy && m.to === lower(a.to) && m.value === a.value,
            "PAYOUT",
          )
        )
          anomalies.push({
            kind: "PAYOUT_WITHOUT_TRANSFER",
            tx,
            index: a.index.toString(),
          });
      }
    } else if (d.eventName === "PendingRemoved") {
      const v = open.get(d.args.index);
      if (v === undefined)
        anomalies.push({
          kind: "REMOVE_UNKNOWN_PENDING",
          tx,
          index: d.args.index.toString(),
        });
      else {
        pendingAmount -= v;
        open.delete(d.args.index);
      }
    }
  }
  let balance = base.balance;
  const directInbound: LedgerDeltaResult["directInbound"] = [];
  const unclassified: LedgerDeltaResult["unclassified"] = [];
  for (const list of byTx.values())
    for (const m of list) {
      if (m.to === proxy) balance += m.value;
      if (m.from === proxy) balance -= m.value;
      if (m.cls) continue;
      if (m.to === proxy && !proxyTxs.has(m.tx)) {
        m.cls = "DIRECT_INBOUND_NO_BRIDGE_EVENT";
        directInbound.push({ tx: m.tx, value: m.value });
      } else unclassified.push({ ...m });
    }
  const range = (fromI: bigint, toI: bigint) => {
    const out: string[] = [];
    for (let i = fromI; i < toI; i++) out.push(i.toString());
    return out.join(",");
  };
  const sortedSet = (s: Set<bigint>) =>
    [...s]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map(String)
      .join(",");
  const openPending = [...open.keys()]
    .sort((a, b) => (a < b ? -1 : 1))
    .map(String);
  const livePending = live.pending
    .map((p) => p.index)
    .sort((a, b) => (a < b ? -1 : 1))
    .map(String);
  const directSum = directInbound.reduce((s, d) => s + d.value, 0n);
  const checks = {
    LOGS_IN_RANGE_AND_FROM_EXPECTED_CONTRACTS: logsInRange,
    DEPOSITED_EXACT: deposited === live.deposited,
    PENDING_EXACT: pendingAmount === live.pendingAmount,
    OPEN_PENDING_SET_EXACT: openPending.join(",") === livePending.join(","),
    BALANCE_EXACT: balance === live.balance,
    SURPLUS_EXPLAINED:
      live.balance - live.deposited ===
      base.balance - base.deposited + directSum + r.selfPayouts,
    FINALIZE_INDEX_CONTIGUOUS:
      sortedSet(finalized) === range(base.nextFinalize, live.nextFinalize),
    INITIATE_INDEX_CONTIGUOUS:
      sortedSet(initiated) === range(base.nextInitiate, live.nextInitiate),
    NO_UNCLASSIFIED_TRANSFERS: unclassified.length === 0,
    NO_UNKNOWN_EVENT_TOPICS: unknownTopics.length === 0,
    NO_WATCHED_CONFIG_OR_PRIVILEGED_EVENTS: watchedEvents.length === 0,
    NO_ANOMALIES: anomalies.length === 0,
  };
  return {
    from: base.block + 1,
    to: live.block,
    proxyLogs: proxyLogs.length,
    transferLogs: transfers.length,
    counts,
    ...r,
    directInbound,
    computed: { deposited, pendingAmount, balance, openPending },
    watchedEvents,
    unknownTopics,
    unclassified,
    anomalies,
    settlement,
    checks,
    reconciled: Object.values(checks).every(Boolean),
  };
}
