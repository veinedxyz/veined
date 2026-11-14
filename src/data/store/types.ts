import type { ChainRecord } from "../registry/chains";
import type { AdmissionResult } from "../rpc/admission";
import type { ApprovedEndpoint } from "../rpc/pool";
import type { EndpointHealth } from "../rpc/health";
import type { TransferRow } from "../evm/erc20";
import type { PriceEvidence } from "../core/price";
import type { MulticallVerification } from "../evm/multicall";
import type { Tier } from "../core/coverage";
import type { LogWindowWitness } from "../indexer/witness";
export interface StoredChain extends ChainRecord {
  multicall: string | null;
  multicallVerifiedAt: number | null;
}
export interface Checkpoint {
  chainId: string;
  indexedFromBlock: bigint;
  indexedThroughBlock: bigint;
  throughBlockHash: string | null;
  headBlock: bigint | null;
  safeBlock: bigint | null;
  historicalComplete: boolean;
  lastError: string | null;
  updatedAt: number;
  // V1.5: trusted advancement paused (e.g. LOG_CONSENSUS_UNRESOLVED) until an operator resumes.
  haltedReason?: string | null;
  haltedAt?: number | null;
}
export interface WindowRow {
  fromBlock: bigint;
  toBlock: bigint;
  toBlockHash: string;
  logCount: number;
  finalized: boolean;
  witnessConsensus?: WindowConsensus | null;
  logDigest?: string | null;
  lane?: "live" | "backfill";
}
export type WindowConsensus =
  | "MATCH"
  | "TIEBREAK_MATCH_PRIMARY"
  | "TIEBREAK_MATCH_WITNESS"
  | "NO_INDEPENDENT_WITNESS";
export interface CommitWindow {
  chainId: string;
  owner: string;
  window: WindowRow;
  rows: TransferRow[];
  headBlock: bigint;
  safeBlock: bigint;
  // V1.5: the witness record is stored in the same transaction as the window.
  witness?: LogWindowWitness;
}
export interface WitnessSummary {
  chainId: string;
  windows: number;
  trustedWindows: number;
  developmentWindows: number;
  unwitnessedWindows: number;
  recordsByConsensus: Record<string, number>;
  lastConsensus: string | null;
  lastObservedAt: number | null;
  firstTrustedFrom: string | null;
}
export interface BackupEvent {
  kind: "BACKUP" | "VERIFY" | "RESTORE_DRILL";
  ok: boolean;
  at: number;
  backupId: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  durationMs: number | null;
  detail: string | null;
}
export interface TokenRow {
  chainId: string;
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  metadataStatus: "OK" | "PARTIAL" | "FAILED" | "PENDING";
  sources: string[];
  suspicious: boolean;
  spam: boolean;
  price: PriceEvidence | null;
}
export type TokenUpsert = Partial<TokenRow> & {
  chainId: string;
  address: string;
  sources: string[];
};
export interface DiscoveryRow {
  token: string;
  firstBlock: bigint;
  lastBlock: bigint;
  transferCount: number;
}
export interface ActivityRow {
  chainId: string;
  blockNumber: bigint;
  logIndex: number;
  txHash: string;
  token: string;
  direction: "in" | "out" | "self";
  value: bigint;
}
export interface ActivityCursor {
  chainId: string;
  blockNumber: bigint;
  logIndex: number;
}
export interface ApiClient {
  id: string;
  displayName: string;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  planId: string;
  scopes: string[];
  createdAt: number;
}
export interface ApiKeyRecord {
  id: string;
  clientId: string;
  prefix: string;
  verifier: string;
  status: "ACTIVE" | "REVOKED";
  createdAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
}
export interface UsageEvent {
  clientId: string;
  keyId: string | null;
  at: number;
  endpointGroup: string;
  status: number;
  costUnits: number;
  latencyBucket: string;
  requestId: string;
}
export interface ScanRunRecord {
  id: string;
  walletHash: string;
  origin: "app" | "api";
  clientId: string | null;
  startedAt: number;
  finishedAt: number;
  state: string;
  planned: number;
  checked: number;
  pending: number;
  failed: number;
  coverage: {
    chainId: string;
    state: string;
    tier: Tier;
    observedBlock: string | null;
  }[];
}
export interface IndexVerification {
  chainId: string;
  coverageFrom: string | null;
  coverageThrough: string | null;
  missingRanges: { from: string; to: string }[];
  duplicateLogKeys: number;
  orphanRecords: number;
  checkpointMismatch: boolean;
  transfers: number;
  windows: number;
  // V1.5 extended integrity checks (verify-index fails when any is non-zero / true).
  blockHashInconsistencies?: number;
  disputedCommittedWindows?: number;
  invalidCheckpointState?: string[];
  witness?: WitnessSummary;
}
// One storage contract with two implementations: PostgreSQL (production-capable) and memory (tests/dev).
export interface DataStore {
  readonly kind: "postgres" | "memory";
  ping(): Promise<boolean>;
  close(): Promise<void>;
  upsertChains(chains: ChainRecord[]): Promise<number>;
  listChains(): Promise<StoredChain[]>;
  setMulticall(chainId: string, v: MulticallVerification): Promise<void>;
  upsertEndpoint(result: AdmissionResult, priority: number): Promise<void>;
  listEndpoints(
    chainId?: string,
  ): Promise<(ApprovedEndpoint & { status: string })[]>;
  recordHealth(endpointId: string, health: EndpointHealth): Promise<void>;
  loadHealth(): Promise<Map<string, EndpointHealth>>;
  learnLogRange(endpointId: string, range: number): Promise<void>;
  acquireLease(
    chainId: string,
    owner: string,
    ttlMs: number,
    from: bigint,
    to: bigint,
  ): Promise<boolean>;
  releaseLease(chainId: string, owner: string): Promise<void>;
  getCheckpoint(chainId: string): Promise<Checkpoint | null>;
  listCheckpoints(): Promise<Checkpoint[]>;
  initCheckpoint(
    chainId: string,
    owner: string,
    fromBlock: bigint,
    anchorHash: string,
  ): Promise<void>;
  commitWindow(
    input: CommitWindow,
  ): Promise<{ inserted: number; duplicates: number }>;
  listWindows(chainId: string, limit: number): Promise<WindowRow[]>;
  rewind(
    chainId: string,
    owner: string,
    keepThrough: bigint,
    anchorHash: string,
  ): Promise<number>;
  promoteFinalized(
    chainId: string,
    finalizedBlock: bigint,
    owner: string,
  ): Promise<number>;
  setCheckpointError(chainId: string, error: string | null): Promise<void>;
  upsertTokens(rows: TokenUpsert[]): Promise<number>;
  pendingMetadata(chainId: string, limit: number): Promise<string[]>;
  getTokens(chainId: string, addresses: string[]): Promise<TokenRow[]>;
  tokenUniverse(chainId: string, limit: number): Promise<string[]>;
  tokenCounts(): Promise<Map<string, number>>;
  routedSymbols(chainId: string, symbols: string[]): Promise<Set<string>>;
  discoveredTokens(chainId: string, wallet: string): Promise<DiscoveryRow[]>;
  walletChains(wallet: string): Promise<string[]>;
  walletActivity(
    wallet: string,
    cursor: ActivityCursor | null,
    limit: number,
  ): Promise<ActivityRow[]>;
  recordBalanceSnapshot(
    walletHash: string,
    chainId: string,
    token: string | null,
    balance: bigint,
    block: bigint,
    at: number,
  ): Promise<void>;
  recordScanRun(run: ScanRunRecord): Promise<void>;
  createClient(client: ApiClient): Promise<void>;
  getClient(id: string): Promise<ApiClient | null>;
  listClients(): Promise<ApiClient[]>;
  createKey(key: ApiKeyRecord): Promise<void>;
  findKey(prefix: string): Promise<ApiKeyRecord | null>;
  revokeKey(idOrPrefix: string, at: number): Promise<boolean>;
  touchKey(id: string, at: number): Promise<void>;
  recordUsage(event: UsageEvent): Promise<void>;
  usageSummary(
    clientId: string,
    sinceDay: string,
  ): Promise<
    {
      day: string;
      endpointGroup: string;
      requests: number;
      costUnits: number;
      errors: number;
    }[]
  >;
  consumeBucket(
    key: string,
    windowStart: number,
    windowSeconds: number,
    cost: number,
  ): Promise<number>;
  acquireSlot(
    clientId: string,
    requestId: string,
    cap: number,
    ttlMs: number,
  ): Promise<boolean>;
  releaseSlot(requestId: string): Promise<void>;
  verifyIndex(chainId: string): Promise<IndexVerification>;
  // V1.5 witness / halt / backfill / ops
  recordWitness(record: LogWindowWitness): Promise<void>;
  witnessSummary(chainId: string): Promise<WitnessSummary>;
  listWitnessRecords(
    chainId: string,
    limit: number,
  ): Promise<LogWindowWitness[]>;
  haltChain(chainId: string, reason: string): Promise<void>;
  resumeChain(chainId: string): Promise<boolean>;
  acquireBackfillLease(
    chainId: string,
    owner: string,
    ttlMs: number,
  ): Promise<boolean>;
  releaseBackfillLease(chainId: string, owner: string): Promise<void>;
  commitBackfillWindow(
    input: CommitWindow,
  ): Promise<{ inserted: number; duplicates: number }>;
  markWindowWitnessed(
    chainId: string,
    fromBlock: bigint,
    toBlock: bigint,
    record: LogWindowWitness,
  ): Promise<boolean>;
  windowRows(
    chainId: string,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<TransferRow[]>;
  recordBackupEvent(event: BackupEvent): Promise<void>;
  purgeExpired(now: number): Promise<Record<string, number>>;
  purgeLimiterState(now: number): Promise<number>;
}
