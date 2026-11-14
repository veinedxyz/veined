// Self-hosted local data-plane adapter for public G7 observations. This performance cache is NOT an RPC vote.
// The caller must validate every saved anchor against fresh external canonical sources before using any delta.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
// Structural data type only: the data plane cannot import the pilot runtime.
export interface CheckpointLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash?: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
}

export interface G7Checkpoint {
  schema: "otherbridge.g7.checkpoint.v1";
  routeDigest: string;
  acceptedThroughBlock: number;
  acceptedThroughBlockHash: string;
  oneThroughBlock: number;
  oneThroughBlockHash: string;
  deposited: string;
  pendingAmount: string;
  reserveBalance: string;
  openPending: { index: string; value: string }[];
  nextIndexes: { finalize: string; initiate: string };
  eventDigest: string;
  sourceEvidence: {
    stateOperators: string[];
    witnessOperator: string;
    observedAt: number;
  };
  logs: {
    bscProxyLogs: CheckpointLog[];
    crossIn: CheckpointLog[];
    crossOut: CheckpointLog[];
    bscVerifierLogs: CheckpointLog[];
    oneProxyLogs: CheckpointLog[];
    oneVerifierLogs: CheckpointLog[];
  };
}
export const cacheDigest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export interface G7CacheStore {
  load(): G7Checkpoint | null;
  save(value: G7Checkpoint): void;
}
export class FileG7Cache implements G7CacheStore {
  constructor(private readonly path: string) {}
  load(): G7Checkpoint | null {
    if (!existsSync(this.path)) return null;
    try {
      if (statSync(this.path).size > 64_000_000) return null;
      const text = readFileSync(this.path, "utf8");
      if (text.length > 64_000_000) return null;
      const envelope = JSON.parse(text) as {
        payload: G7Checkpoint;
        sha256: string;
      };
      const p = envelope.payload;
      if (
        !p ||
        p.schema !== "otherbridge.g7.checkpoint.v1" ||
        envelope.sha256 !== cacheDigest(p) ||
        p.eventDigest !== cacheDigest(p.logs) ||
        !Number.isSafeInteger(p.acceptedThroughBlock) ||
        !Number.isSafeInteger(p.oneThroughBlock) ||
        !/^0x[0-9a-f]{64}$/i.test(p.acceptedThroughBlockHash) ||
        !/^0x[0-9a-f]{64}$/i.test(p.oneThroughBlockHash) ||
        ![
          p.deposited,
          p.pendingAmount,
          p.reserveBalance,
          p.nextIndexes.finalize,
          p.nextIndexes.initiate,
          ...p.openPending.flatMap((v) => [v.index, v.value]),
        ].every((v) => /^\d{1,78}$/.test(v)) ||
        !Object.values(p.logs).every(Array.isArray) ||
        new Set(p.sourceEvidence.stateOperators).size !== 2 ||
        p.sourceEvidence.stateOperators.includes(
          p.sourceEvidence.witnessOperator,
        )
      )
        return null;
      return p;
    } catch {
      return null;
    }
  }
  save(payload: G7Checkpoint) {
    const previous = this.load();
    // A slower session never overwrites a newer contiguous checkpoint.
    if (
      previous &&
      (previous.acceptedThroughBlock > payload.acceptedThroughBlock ||
        previous.oneThroughBlock > payload.oneThroughBlock)
    )
      return;
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(
      temp,
      JSON.stringify({ payload, sha256: cacheDigest(payload) }) + "\n",
    );
    renameSync(temp, this.path);
  }
}
