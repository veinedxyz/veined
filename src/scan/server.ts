// Local, read-only index over accepted durable wallet journals. No new provider or broadcast surface.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CanaryDurableStore,
  readJournal,
  type StoreEntry,
} from "../execution/server/canary/durable-store";
import { verifyTransaction, verifyHash } from "../activity/verify";
import { matchingBridge, type VerifiedTransaction } from "../activity/model";
import { lifecycle, type ScanRecord } from "./model";
import history from "./imported-history.json" with { type: "json" };

const A = /^0x[0-9a-f]{40}$/;
const H = /^0x[0-9a-f]{64}$/;
function journal(file: string) {
  if (!existsSync(file)) return [];
  const parsed = readJournal(readFileSync(file));
  if (parsed.status !== "READY") throw Error("SCAN_LEDGER_NEEDS_ATTENTION");
  return parsed.entries;
}
export function projectAccount(
  account: string,
  entries: StoreEntry[],
  now = Date.now(),
): ScanRecord[] {
  if (!A.test(account)) throw Error("SCAN_ADDRESS_INVALID");
  const bind = entries.find((e) => e.type === "ACCOUNT_BIND")?.data as
    { account?: string } | undefined;
  if (bind?.account !== account) throw Error("SCAN_ACCOUNT_BINDING");
  return entries
    .filter((e) => e.type === "REQUESTED")
    .map((e) => {
      const request = e.data as {
        id: string;
        lane: string;
        step: string;
        requestedAt?: number;
      };
      if (
        !/^[0-9a-f]{64}$/.test(request.id) ||
        !["SWAP", "BRIDGE"].includes(request.lane) ||
        !["APPROVE", "SWAP", "EXECUTE"].includes(request.step)
      )
        throw Error("SCAN_EVENT_INVALID");
      const result = entries.find(
        (x) =>
          x.type === "RESULT" && (x.data as { id: string }).id === request.id,
      )?.data as
        | { outcome: string; hash: string | null; submittedAt?: number }
        | undefined;
      const hash = result?.hash?.toLowerCase() ?? null;
      if (hash && !H.test(hash)) throw Error("SCAN_HASH_INVALID");
      return {
        id: `manual:${account}:${request.id}`,
        account,
        chainId: "8453",
        hash,
        kind:
          request.step === "APPROVE"
            ? "Approval"
            : request.lane === "SWAP"
              ? "Swap"
              : "Bridge",
        provenance: "VEINED_SUBMISSION",
        status:
          result?.outcome === "SENT" && hash
            ? "SUBMITTED"
            : result?.outcome === "REFUSED"
              ? "REFUSED"
              : "UNKNOWN",
        observedAt: request.requestedAt ?? result?.submittedAt ?? now,
        updatedAt: now,
        route: request.lane,
        provider: request.lane === "SWAP" ? "Uniswap V3" : "LI.FI / Across",
        recipient: account,
      };
    });
}
export class ScanIndex {
  readonly store: CanaryDurableStore;
  readonly records = new Map<string, ScanRecord>();
  constructor(readonly directory = join(process.cwd(), ".scan")) {
    this.store = CanaryDurableStore.open(directory);
    if (!this.store.writable) throw Error("SCAN_LEDGER_NEEDS_ATTENTION");
    for (const e of this.store.of("SCAN_RECORD")) {
      const r = e.data as ScanRecord;
      this.records.set(r.id, r);
    }
    for (const item of history.results) {
      if (!item.verified) continue;
      const tx = item.transaction as VerifiedTransaction;
      if (this.records.has(`history:${tx.chainId}:${tx.hash}`)) continue;
      this.put({
        id: `history:${tx.chainId}:${tx.hash}`,
        account: tx.address,
        chainId: tx.chainId,
        hash: tx.hash,
        kind: tx.kind,
        provenance: "HISTORICAL_IMPORT",
        status: tx.status,
        observedAt: tx.timestamp,
        updatedAt: tx.verifiedAt,
        transaction: tx,
      });
    }
    // Correlate only receipts whose complete Across relay identity matches.
    for (const source of this.records.values()) {
      if (
        source.provenance !== "HISTORICAL_IMPORT" ||
        source.kind !== "Bridge" ||
        !source.transaction
      )
        continue;
      const fill = [...this.records.values()].find(
        (r) =>
          r.transaction && matchingBridge(source.transaction!, r.transaction),
      );
      if (fill) {
        this.put({
          ...source,
          destinationHash: fill.hash!,
          sourceStatus: "SOURCE_CONFIRMED",
          status: "SETTLED_VERIFIED",
        });
        this.put({ ...fill, sourceHash: source.hash! });
      }
    }
  }
  put(r: ScanRecord) {
    const prior = this.records.get(r.id);
    const stable = (v: ScanRecord) => JSON.stringify({ ...v, updatedAt: 0 });
    if (prior && stable(prior) === stable(r)) return;
    // Commit before publishing the projection. Failed fsync leaves the index unavailable.
    this.store.append("SCAN_RECORD", r as unknown as Record<string, unknown>);
    this.records.set(r.id, r);
  }
  ingest(root = join(process.cwd(), ".manual-wallet")) {
    const errors: string[] = [];
    if (!existsSync(root)) return errors;
    for (const name of readdirSync(root).filter((n) => A.test(n))) {
      try {
        for (const r of projectAccount(
          name,
          journal(join(root, name, "journal.ndjson")),
        )) {
          const prior = this.records.get(r.id);
          // Submission reconciliation cannot downgrade an existing chain observation.
          this.put(
            prior
              ? {
                  ...prior,
                  hash: r.hash ?? prior.hash,
                  status:
                    prior.tracking || prior.transaction
                      ? prior.status
                      : r.status,
                }
              : r,
          );
        }
      } catch {
        errors.push("SCAN_LEDGER_NEEDS_ATTENTION");
      }
    }
    return errors;
  }
  list(address?: string, chain?: string, hash?: string) {
    return [...this.records.values()]
      .filter(
        (r) =>
          (!address || r.account === address.toLowerCase()) &&
          (!chain || r.chainId === chain) &&
          (!hash || r.hash === hash.toLowerCase()),
      )
      .sort((a, b) => b.observedAt - a.observedAt);
  }
  async lookup(chainId: "8453" | "42161", hash: string) {
    const tx = await verifyHash(chainId, hash);
    const existing = this.list(undefined, chainId, hash);
    const r: ScanRecord = existing.find((r) => r.account === tx.address) ?? {
      id: `lookup:${chainId}:${hash}`,
      account: tx.address,
      chainId,
      hash,
      kind: tx.kind,
      provenance: "PUBLIC_HASH_LOOKUP",
      status: tx.status,
      observedAt: tx.timestamp,
      updatedAt: tx.verifiedAt,
    };
    const next = {
      ...r,
      transaction: tx,
      updatedAt: tx.verifiedAt,
      status:
        r.provenance === "VEINED_SUBMISSION" && tx.status !== "FAILED"
          ? r.status
          : tx.status,
    };
    this.put(next);
    return next;
  }
  async reconcile(
    record: ScanRecord,
    track: (
      account: string,
      lane: string,
      requestId?: string,
    ) => Promise<Record<string, unknown>>,
  ) {
    try {
      const tracking = await track(
        record.account,
        record.route!,
        record.id.startsWith("manual:")
          ? record.id.split(":").at(-1)
          : undefined,
      );
      const step =
        record.kind === "Approval"
          ? "APPROVE"
          : record.kind === "Swap"
            ? "SWAP"
            : "EXECUTE";
      const status = lifecycle(step, tracking);
      let transaction = record.transaction;
      if (
        record.hash &&
        [
          "CONFIRMED",
          "SOURCE_CONFIRMED",
          "FILL_PENDING",
          "SETTLED_VERIFIED",
          "REFUND_PENDING",
          "FAILED",
        ].includes(status)
      ) {
        transaction = await verifyTransaction({
          address: record.account,
          chainId: record.chainId,
          hash: record.hash,
          consent: true,
        });
      }
      const settlement = tracking.settlement as { fillHash?: string } | null;
      const destination = tracking.destination as {
        fill?: { hash?: string };
      } | null;
      const destinationHash = settlement?.fillHash ?? destination?.fill?.hash;
      this.put({
        ...record,
        status,
        tracking,
        transaction,
        updatedAt: Date.now(),
        error: undefined,
        sourceStatus:
          record.kind === "Bridge" &&
          [
            "FILL_PENDING",
            "SETTLED_VERIFIED",
            "REFUND_PENDING",
            "SOURCE_CONFIRMED",
          ].includes(status)
            ? "SOURCE_CONFIRMED"
            : undefined,
        ...(destinationHash && H.test(destinationHash)
          ? { destinationHash }
          : {}),
      });
      if (
        destinationHash &&
        H.test(destinationHash) &&
        record.kind === "Bridge"
      ) {
        const fill = await verifyTransaction({
          address: record.account,
          chainId: "42161",
          hash: destinationHash,
          consent: true,
        });
        if (transaction && matchingBridge(transaction, fill))
          this.put({
            id: `fill:${destinationHash}`,
            account: record.account,
            chainId: "42161",
            hash: destinationHash,
            sourceHash: record.hash!,
            kind: fill.kind,
            provenance: "VEINED_SUBMISSION",
            status: "SETTLED_VERIFIED",
            transaction: fill,
            observedAt: fill.timestamp,
            updatedAt: Date.now(),
          });
      }
    } catch {
      this.put({
        ...record,
        error: "VERIFICATION_UNAVAILABLE",
        updatedAt: Date.now(),
      });
    }
  }
}
const g = globalThis as typeof globalThis & {
  __scanIndex?: ScanIndex;
  __scanTimer?: ReturnType<typeof setInterval>;
  __scanRunning?: boolean;
  __scanNext?: Map<string, number>;
};
export const scanIndex = () => (g.__scanIndex ??= new ScanIndex());
export function startScanWorker() {
  if (
    process.cwd().replace(/\\/g, "/").toLowerCase() !==
    "d:/vnd/post-hackathon-20261117-01/candidate"
  )
    return;
  if (g.__scanTimer) return;
  const tick = async () => {
    if (g.__scanRunning) return;
    g.__scanRunning = true;
    try {
      const index = scanIndex();
      index.ingest();
      const next = (g.__scanNext ??= new Map());
      const candidates = index
        .list()
        .filter(
          (r) =>
            r.provenance === "VEINED_SUBMISSION" &&
            r.hash &&
            r.route &&
            !["CONFIRMED", "FAILED", "REFUSED", "SETTLED_VERIFIED"].includes(
              r.status,
            ) &&
            (next.get(r.account + r.route) ?? 0) <= Date.now(),
        );
      const unique = [
        ...new Map(candidates.map((r) => [r.account + r.route, r])).values(),
      ].slice(0, 2);
      await Promise.allSettled(
        unique.map(async (r) => {
          next.set(r.account + r.route, Date.now() + 10000);
          const { trackSavedAccount } =
            await import("../manual-wallet/server/runtime");
          const observations = new Map<
            string,
            Promise<Record<string, unknown>>
          >();
          const track = (account: string, lane: string, requestId?: string) => {
            const key = requestId ?? lane;
            let observation = observations.get(key);
            if (!observation) {
              observation = trackSavedAccount(account, lane, requestId);
              observations.set(key, observation);
            }
            return observation;
          };
          // One read-only tracker observation per lane; terminal approvals are not polled again.
          for (const item of index
            .list(r.account)
            .filter(
              (x) =>
                x.route === r.route &&
                x.hash &&
                ![
                  "CONFIRMED",
                  "FAILED",
                  "REFUSED",
                  "SETTLED_VERIFIED",
                ].includes(x.status),
            ))
            await index.reconcile(item, track);
          next.set(
            r.account + r.route,
            Date.now() + (index.records.get(r.id)?.error ? 30000 : 3000),
          );
        }),
      );
    } catch {
      /* Store errors are surfaced by the read API. Never reset a journal or send again. */
    } finally {
      g.__scanRunning = false;
    }
  };
  g.__scanTimer = setInterval(() => void tick(), 3000);
  g.__scanTimer.unref?.();
  void tick();
}
