import type { ChainRecord } from "../registry/chains";
import type { AdmissionResult } from "../rpc/admission";
import type { EndpointHealth } from "../rpc/health";
import type { MulticallVerification } from "../evm/multicall";
import type { TransferRow } from "../evm/erc20";
import type { LogWindowWitness } from "../indexer/witness";
import { committedDigest } from "../indexer/witness";
import type {
  ActivityCursor,
  ActivityRow,
  ApiClient,
  ApiKeyRecord,
  BackupEvent,
  Checkpoint,
  CommitWindow,
  DataStore,
  DiscoveryRow,
  IndexVerification,
  ScanRunRecord,
  StoredChain,
  TokenRow,
  TokenUpsert,
  UsageEvent,
  WindowRow,
  WitnessSummary,
} from "./types";
const TRUSTED = ["MATCH", "TIEBREAK_MATCH_PRIMARY", "TIEBREAK_MATCH_WITNESS"];
const COMMITTABLE = [...TRUSTED, "NO_INDEPENDENT_WITNESS"];
// Deterministic in-process store mirroring PostgresStore semantics for tests and DB-less development.
export class MemoryStore implements DataStore {
  readonly kind = "memory" as const;
  chains = new Map<string, StoredChain>();
  endpoints = new Map<
    string,
    AdmissionResult & { id: string; priority: number }
  >();
  health = new Map<string, EndpointHealth>();
  leases = new Map<string, { owner: string; expires: number }>();
  checkpoints = new Map<string, Checkpoint>();
  windows = new Map<string, WindowRow[]>();
  transfers = new Map<string, TransferRow>();
  discovery = new Map<
    string,
    DiscoveryRow & { chainId: string; wallet: string }
  >();
  tokens = new Map<string, TokenRow>();
  snapshots = new Map<string, { balance: bigint; block: bigint; at: number }>();
  runs: ScanRunRecord[] = [];
  clients = new Map<string, ApiClient>();
  keys = new Map<string, ApiKeyRecord>();
  usage: UsageEvent[] = [];
  buckets = new Map<string, number>();
  slots = new Map<string, { clientId: string; expires: number }>();
  witnesses: LogWindowWitness[] = [];
  backfillLeases = new Map<string, { owner: string; expires: number }>();
  backupEvents: BackupEvent[] = [];
  constructor(private now: () => number = Date.now) {}
  async ping() {
    return true;
  }
  async close() {}
  async upsertChains(chains: ChainRecord[]) {
    for (const c of chains) {
      const old = this.chains.get(c.chainId);
      this.chains.set(c.chainId, {
        ...c,
        sources: [...c.sources],
        multicall: old?.multicall ?? null,
        multicallVerifiedAt: old?.multicallVerifiedAt ?? null,
      });
    }
    return chains.length;
  }
  async listChains() {
    return [...this.chains.values()].sort(
      (a, b) =>
        (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1) ||
        a.chainId.localeCompare(b.chainId),
    );
  }
  async setMulticall(chainId: string, v: MulticallVerification) {
    const c = this.chains.get(chainId);
    if (c) {
      c.multicall = v.verified ? v.address : null;
      c.multicallVerifiedAt = v.observedAt;
    }
  }
  async upsertEndpoint(r: AdmissionResult, priority: number) {
    if (!r.host) return;
    const id = `${r.chainId}:${r.host}${new URL(r.url).pathname === "/" ? "" : new URL(r.url).pathname}`;
    this.endpoints.set(`${r.chainId}|${r.url}`, { ...r, id, priority });
  }
  async listEndpoints(chainId?: string) {
    return [...this.endpoints.values()]
      .filter(
        (e) => e.status === "APPROVED" && (!chainId || e.chainId === chainId),
      )
      .sort(
        (a, b) =>
          a.chainId.localeCompare(b.chainId) ||
          a.priority - b.priority ||
          a.id.localeCompare(b.id),
      )
      .map((e) => ({
        id: e.id,
        chainId: e.chainId,
        url: e.url,
        allowPort: e.provenance !== "public-registry",
        priority: e.priority,
        supportsLogs: e.supportsLogs,
        maxLogRange: e.maxLogRange,
        supportsBatch: e.supportsBatch,
        supportsFinalized: e.supportsFinalized,
        supportsSafe: e.supportsSafe,
        archive: e.archive,
        status: e.status,
      }));
  }
  async recordHealth(id: string, h: EndpointHealth) {
    this.health.set(id, { ...h });
  }
  async loadHealth() {
    return new Map(this.health);
  }
  async learnLogRange(id: string, range: number) {
    for (const e of this.endpoints.values())
      if (e.id === id) e.maxLogRange = range;
  }
  async acquireLease(
    chainId: string,
    owner: string,
    ttlMs: number,
    _from?: bigint,
    _to?: bigint,
  ) {
    void _from;
    void _to;
    const now = this.now(),
      held = this.leases.get(chainId);
    if (held && held.expires > now && held.owner !== owner) return false;
    this.leases.set(chainId, { owner, expires: now + ttlMs });
    return true;
  }
  async releaseLease(chainId: string, owner: string) {
    const held = this.leases.get(chainId);
    if (held?.owner === owner) held.expires = this.now();
  }
  private hold(chainId: string, owner: string) {
    const held = this.leases.get(chainId);
    if (!held || held.owner !== owner || held.expires <= this.now())
      throw Error("LEASE_LOST");
  }
  async getCheckpoint(chainId: string) {
    const c = this.checkpoints.get(chainId);
    return c ? { ...c } : null;
  }
  async listCheckpoints() {
    return [...this.checkpoints.values()].map((c) => ({ ...c }));
  }
  async initCheckpoint(
    chainId: string,
    owner: string,
    fromBlock: bigint,
    anchorHash: string,
  ) {
    this.hold(chainId, owner);
    if (this.checkpoints.has(chainId)) return;
    this.checkpoints.set(chainId, {
      chainId,
      indexedFromBlock: fromBlock,
      indexedThroughBlock: fromBlock - 1n,
      throughBlockHash: anchorHash.toLowerCase(),
      headBlock: null,
      safeBlock: null,
      historicalComplete: false,
      lastError: null,
      updatedAt: this.now(),
      haltedReason: null,
      haltedAt: null,
    });
  }
  private discover(chainId: string, rows: TransferRow[]) {
    for (const r of rows)
      for (const wallet of new Set([r.from, r.to])) {
        if (/^0x0{40}$/.test(wallet)) continue;
        const key = `${chainId}|${wallet}|${r.token}`,
          d = this.discovery.get(key);
        if (d) {
          d.firstBlock =
            d.firstBlock < r.blockNumber ? d.firstBlock : r.blockNumber;
          d.lastBlock =
            d.lastBlock > r.blockNumber ? d.lastBlock : r.blockNumber;
          d.transferCount++;
        } else
          this.discovery.set(key, {
            chainId,
            wallet,
            token: r.token,
            firstBlock: r.blockNumber,
            lastBlock: r.blockNumber,
            transferCount: 1,
          });
      }
  }
  private checkWitness(input: CommitWindow) {
    const w = input.witness;
    if (
      w &&
      (w.chainId !== input.chainId ||
        w.fromBlock !== input.window.fromBlock ||
        w.toBlock !== input.window.toBlock ||
        !w.committed ||
        !COMMITTABLE.includes(w.consensus))
    )
      throw Error("WITNESS_RECORD_MISMATCH");
  }
  async commitBackfillWindow(input: CommitWindow) {
    const { chainId, owner, window } = input;
    if (!window.finalized) throw Error("BACKFILL_REQUIRES_FINALIZED");
    const lease = this.backfillLeases.get(chainId);
    if (!lease || lease.owner !== owner || lease.expires <= this.now())
      throw Error("LEASE_LOST");
    const cp = this.checkpoints.get(chainId);
    if (!cp || cp.indexedFromBlock !== window.toBlock + 1n)
      throw Error("CHECKPOINT_RACE");
    if (cp.haltedReason) throw Error("CHAIN_HALTED");
    if (window.fromBlock < 0n) throw Error("ROW_OUTSIDE_WINDOW");
    const r = this.insertWindow(input, "backfill");
    cp.indexedFromBlock = window.fromBlock;
    cp.updatedAt = this.now();
    lease.expires = this.now() + 60000;
    return r;
  }
  async commitWindow(input: CommitWindow) {
    const { chainId, owner, window } = input;
    this.hold(chainId, owner);
    const cp = this.checkpoints.get(chainId);
    if (!cp || cp.indexedThroughBlock !== window.fromBlock - 1n)
      throw Error("CHECKPOINT_RACE");
    if (cp.haltedReason) throw Error("CHAIN_HALTED");
    const result = this.insertWindow(input, "live");
    Object.assign(cp, {
      indexedThroughBlock: window.toBlock,
      throughBlockHash: window.toBlockHash.toLowerCase(),
      headBlock: input.headBlock,
      safeBlock: input.safeBlock,
      lastError: null,
      updatedAt: this.now(),
    });
    this.leases.get(chainId)!.expires = this.now() + 60000;
    return result;
  }
  private insertWindow(input: CommitWindow, lane: "live" | "backfill") {
    const { chainId, window } = input;
    if (
      input.rows.some(
        (r) =>
          r.chainId !== chainId ||
          r.blockNumber < window.fromBlock ||
          r.blockNumber > window.toBlock,
      )
    )
      throw Error("ROW_OUTSIDE_WINDOW");
    this.checkWitness(input);
    const inserted: TransferRow[] = [];
    for (const r of input.rows) {
      const key = `${chainId}|${r.txHash}|${r.logIndex}`;
      if (this.transfers.has(key)) continue;
      this.transfers.set(key, { ...r });
      inserted.push(r);
    }
    this.discover(chainId, inserted);
    for (const token of new Set(inserted.map((r) => r.token))) {
      const key = `${chainId}|${token}`,
        old = this.tokens.get(key);
      if (old) {
        if (!old.sources.includes("indexed"))
          old.sources = [...old.sources, "indexed"].sort();
      } else
        this.tokens.set(key, {
          chainId,
          address: token,
          symbol: null,
          name: null,
          decimals: null,
          metadataStatus: "PENDING",
          sources: ["indexed"],
          suspicious: false,
          spam: false,
          price: null,
        });
    }
    const list = this.windows.get(chainId) ?? [];
    const w = input.witness;
    list.push({
      ...window,
      toBlockHash: window.toBlockHash.toLowerCase(),
      witnessConsensus: (w?.consensus as WindowRow["witnessConsensus"]) ?? null,
      logDigest: w ? committedDigest(w) : null,
      lane,
    });
    this.windows.set(chainId, list);
    if (w) this.witnesses.push({ ...w });
    return {
      inserted: inserted.length,
      duplicates: input.rows.length - inserted.length,
    };
  }
  async listWindows(chainId: string, limit: number) {
    return [...(this.windows.get(chainId) ?? [])]
      .sort((a, b) =>
        b.toBlock > a.toBlock ? 1 : b.toBlock < a.toBlock ? -1 : 0,
      )
      .slice(0, limit)
      .map((w) => ({ ...w }));
  }
  async rewind(
    chainId: string,
    owner: string,
    keepThrough: bigint,
    anchorHash: string,
  ) {
    this.hold(chainId, owner);
    const windows = this.windows.get(chainId) ?? [];
    if (
      windows.some(
        (w) =>
          w.toBlock > keepThrough &&
          (w.finalized || w.fromBlock <= keepThrough),
      )
    )
      throw Error("FINALIZED_CONFLICT");
    const affected = new Set<string>();
    let removed = 0;
    for (const [key, r] of this.transfers)
      if (r.chainId === chainId && r.blockNumber > keepThrough) {
        affected.add(`${r.from}|${r.token}`);
        affected.add(`${r.to}|${r.token}`);
        this.transfers.delete(key);
        removed++;
      }
    this.windows.set(
      chainId,
      windows.filter((w) => w.fromBlock <= keepThrough),
    );
    for (const pair of affected) this.discovery.delete(`${chainId}|${pair}`);
    const remaining = [...this.transfers.values()].filter(
      (r) =>
        r.chainId === chainId &&
        (affected.has(`${r.from}|${r.token}`) ||
          affected.has(`${r.to}|${r.token}`)),
    );
    // Rebuild only the affected (wallet, token) pairs from surviving rows.
    for (const r of remaining)
      for (const wallet of new Set([r.from, r.to])) {
        if (!affected.has(`${wallet}|${r.token}`) || /^0x0{40}$/.test(wallet))
          continue;
        const key = `${chainId}|${wallet}|${r.token}`,
          d = this.discovery.get(key);
        if (d) {
          d.firstBlock =
            d.firstBlock < r.blockNumber ? d.firstBlock : r.blockNumber;
          d.lastBlock =
            d.lastBlock > r.blockNumber ? d.lastBlock : r.blockNumber;
          d.transferCount++;
        } else
          this.discovery.set(key, {
            chainId,
            wallet,
            token: r.token,
            firstBlock: r.blockNumber,
            lastBlock: r.blockNumber,
            transferCount: 1,
          });
      }
    const cp = this.checkpoints.get(chainId)!;
    cp.indexedThroughBlock = keepThrough;
    cp.throughBlockHash = anchorHash.toLowerCase();
    cp.lastError = null;
    return removed;
  }
  async promoteFinalized(
    chainId: string,
    finalizedBlock: bigint,
    owner: string,
  ) {
    this.hold(chainId, owner);
    let n = 0;
    for (const w of this.windows.get(chainId) ?? [])
      if (!w.finalized && w.toBlock <= finalizedBlock) {
        w.finalized = true;
        n++;
      }
    return n;
  }
  async setCheckpointError(chainId: string, error: string | null) {
    const cp = this.checkpoints.get(chainId);
    if (cp) cp.lastError = error;
  }
  async upsertTokens(rows: TokenUpsert[]) {
    for (const r of rows) {
      const key = `${r.chainId}|${r.address}`,
        old = this.tokens.get(key);
      this.tokens.set(key, {
        chainId: r.chainId,
        address: r.address,
        symbol: r.symbol ?? old?.symbol ?? null,
        name: r.name ?? old?.name ?? null,
        decimals: r.decimals ?? old?.decimals ?? null,
        metadataStatus:
          !r.metadataStatus || r.metadataStatus === "PENDING"
            ? (old?.metadataStatus ?? "PENDING")
            : r.metadataStatus,
        sources: [...new Set([...(old?.sources ?? []), ...r.sources])].sort(),
        suspicious: (old?.suspicious ?? false) || (r.suspicious ?? false),
        spam: (old?.spam ?? false) || (r.spam ?? false),
        price: r.price?.priceUsd ? r.price : (old?.price ?? null),
      });
    }
    return rows.length;
  }
  async pendingMetadata(chainId: string, limit: number) {
    return [...this.tokens.values()]
      .filter((t) => t.chainId === chainId && t.metadataStatus === "PENDING")
      .slice(0, limit)
      .map((t) => t.address);
  }
  async getTokens(chainId: string, addresses: string[]) {
    return addresses.flatMap((a) => {
      const t = this.tokens.get(`${chainId}|${a}`);
      return t ? [{ ...t, sources: [...t.sources] }] : [];
    });
  }
  async tokenUniverse(chainId: string, limit: number) {
    return [...this.tokens.values()]
      .filter(
        (t) =>
          t.chainId === chainId &&
          /^0x[0-9a-f]{40}$/.test(t.address) &&
          !t.spam,
      )
      .sort(
        (a, b) =>
          Number(b.sources.includes("routing-catalog")) -
            Number(a.sources.includes("routing-catalog")) ||
          Number(!!b.price) - Number(!!a.price) ||
          a.address.localeCompare(b.address),
      )
      .slice(0, limit)
      .map((t) => t.address);
  }
  async tokenCounts() {
    const out = new Map<string, number>();
    for (const t of this.tokens.values())
      out.set(t.chainId, (out.get(t.chainId) ?? 0) + 1);
    return out;
  }
  async routedSymbols(chainId: string, symbols: string[]) {
    const wanted = new Set(symbols.map((x) => x.toUpperCase()));
    return new Set(
      [...this.tokens.values()]
        .filter(
          (t) =>
            t.chainId === chainId &&
            t.sources.includes("routing-catalog") &&
            t.symbol &&
            wanted.has(t.symbol.toUpperCase()),
        )
        .map((t) => t.symbol!.toUpperCase()),
    );
  }
  async discoveredTokens(chainId: string, wallet: string) {
    const w = wallet.toLowerCase();
    return [...this.discovery.values()]
      .filter((d) => d.chainId === chainId && d.wallet === w)
      .sort((a, b) => (b.lastBlock > a.lastBlock ? 1 : -1))
      .slice(0, 2000)
      .map(({ token, firstBlock, lastBlock, transferCount }) => ({
        token,
        firstBlock,
        lastBlock,
        transferCount,
      }));
  }
  async walletChains(wallet: string) {
    const w = wallet.toLowerCase();
    return [
      ...new Set(
        [...this.discovery.values()]
          .filter((d) => d.wallet === w)
          .map((d) => d.chainId),
      ),
    ].sort();
  }
  async walletActivity(
    wallet: string,
    cursor: ActivityCursor | null,
    limit: number,
  ) {
    const w = wallet.toLowerCase();
    const after = (r: TransferRow) =>
      !cursor ||
      r.chainId > cursor.chainId ||
      (r.chainId === cursor.chainId &&
        (r.blockNumber > cursor.blockNumber ||
          (r.blockNumber === cursor.blockNumber &&
            r.logIndex > cursor.logIndex)));
    return [...this.transfers.values()]
      .filter((r) => (r.from === w || r.to === w) && after(r))
      .sort(
        (a, b) =>
          a.chainId.localeCompare(b.chainId) ||
          (a.blockNumber > b.blockNumber
            ? 1
            : a.blockNumber < b.blockNumber
              ? -1
              : 0) ||
          a.logIndex - b.logIndex,
      )
      .slice(0, limit)
      .map((r): ActivityRow => ({
        chainId: r.chainId,
        blockNumber: r.blockNumber,
        logIndex: r.logIndex,
        txHash: r.txHash,
        token: r.token,
        direction:
          r.from === w && r.to === w ? "self" : r.from === w ? "out" : "in",
        value: r.value,
      }));
  }
  async recordBalanceSnapshot(
    walletHash: string,
    chainId: string,
    token: string | null,
    balance: bigint,
    block: bigint,
    at: number,
  ) {
    this.snapshots.set(`${walletHash}|${chainId}|${token ?? "native"}`, {
      balance,
      block,
      at,
    });
  }
  async recordScanRun(run: ScanRunRecord) {
    this.runs.push(run);
  }
  async createClient(c: ApiClient) {
    if (this.clients.has(c.id)) throw Error("DUPLICATE_CLIENT");
    this.clients.set(c.id, { ...c, scopes: [...c.scopes] });
  }
  async getClient(id: string) {
    const c = this.clients.get(id);
    return c ? { ...c, scopes: [...c.scopes] } : null;
  }
  async listClients() {
    return [...this.clients.values()];
  }
  async createKey(k: ApiKeyRecord) {
    if ([...this.keys.values()].some((x) => x.prefix === k.prefix))
      throw Error("DUPLICATE_PREFIX");
    this.keys.set(k.id, { ...k });
  }
  async findKey(prefix: string) {
    const k = [...this.keys.values()].find((x) => x.prefix === prefix);
    return k ? { ...k } : null;
  }
  async revokeKey(idOrPrefix: string, at: number) {
    const k = [...this.keys.values()].find(
      (x) =>
        (x.id === idOrPrefix || x.prefix === idOrPrefix) &&
        x.status === "ACTIVE",
    );
    if (!k) return false;
    k.status = "REVOKED";
    k.revokedAt = at;
    return true;
  }
  async touchKey(id: string, at: number) {
    const k = this.keys.get(id);
    if (k) k.lastUsedAt = at;
  }
  async recordUsage(e: UsageEvent) {
    this.usage.push({ ...e });
  }
  async usageSummary(clientId: string, sinceDay: string) {
    const out = new Map<
      string,
      {
        day: string;
        endpointGroup: string;
        requests: number;
        costUnits: number;
        errors: number;
      }
    >();
    for (const e of this.usage) {
      const day = new Date(e.at).toISOString().slice(0, 10);
      if (e.clientId !== clientId || day < sinceDay) continue;
      const key = `${day}|${e.endpointGroup}`,
        row = out.get(key) ?? {
          day,
          endpointGroup: e.endpointGroup,
          requests: 0,
          costUnits: 0,
          errors: 0,
        };
      row.requests++;
      row.costUnits += e.costUnits;
      row.errors += e.status >= 400 ? 1 : 0;
      out.set(key, row);
    }
    return [...out.values()].sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        a.endpointGroup.localeCompare(b.endpointGroup),
    );
  }
  async consumeBucket(
    key: string,
    windowStart: number,
    _windowSeconds: number,
    cost: number,
  ) {
    const k = `${key}|${windowStart}`,
      next = (this.buckets.get(k) ?? 0) + cost;
    this.buckets.set(k, next);
    return next;
  }
  async acquireSlot(
    clientId: string,
    requestId: string,
    cap: number,
    ttlMs: number,
  ) {
    const now = this.now();
    for (const [id, s] of this.slots)
      if (s.expires < now) this.slots.delete(id);
    if (
      [...this.slots.values()].filter((s) => s.clientId === clientId).length >=
      cap
    )
      return false;
    this.slots.set(requestId, { clientId, expires: now + ttlMs });
    return true;
  }
  async releaseSlot(requestId: string) {
    this.slots.delete(requestId);
  }
  async verifyIndex(chainId: string): Promise<IndexVerification> {
    const cp = this.checkpoints.get(chainId);
    const windows = [...(this.windows.get(chainId) ?? [])].sort((a, b) =>
      a.fromBlock > b.fromBlock ? 1 : -1,
    );
    const missing: { from: string; to: string }[] = [];
    let expected = cp?.indexedFromBlock ?? windows[0]?.fromBlock ?? 0n;
    for (const w of windows) {
      if (w.fromBlock > expected)
        missing.push({
          from: expected.toString(),
          to: (w.fromBlock - 1n).toString(),
        });
      if (w.fromBlock < expected)
        missing.push({ from: w.fromBlock.toString(), to: "OVERLAP" });
      expected = w.toBlock + 1n;
    }
    const rows = [...this.transfers.values()].filter(
      (r) => r.chainId === chainId,
    );
    const orphans = rows.filter(
      (r) =>
        !windows.some(
          (w) => r.blockNumber >= w.fromBlock && r.blockNumber <= w.toBlock,
        ),
    ).length;
    const logSum = windows.reduce((s, w) => s + w.logCount, 0);
    const lastTo = windows.length
      ? windows[windows.length - 1].toBlock
      : cp
        ? cp.indexedFromBlock - 1n
        : null;
    const blockHashes = new Map<bigint, Set<string>>();
    for (const r of rows)
      blockHashes.set(
        r.blockNumber,
        (blockHashes.get(r.blockNumber) ?? new Set()).add(r.blockHash),
      );
    let hashIssues = [...blockHashes.values()].filter((v) => v.size > 1).length;
    for (const w of windows)
      hashIssues += rows.filter(
        (r) => r.blockNumber === w.toBlock && r.blockHash !== w.toBlockHash,
      ).length;
    const records = this.witnesses.filter((x) => x.chainId === chainId);
    const disputed = windows.filter(
      (w) =>
        w.witnessConsensus &&
        !records.some(
          (x) =>
            x.fromBlock === w.fromBlock &&
            x.toBlock === w.toBlock &&
            x.committed &&
            x.consensus === w.witnessConsensus &&
            committedDigest(x) === w.logDigest &&
            x.primaryBlockEndHash === w.toBlockHash,
        ),
    ).length;
    const invalid: string[] = [];
    if (cp?.historicalComplete && cp.indexedFromBlock > 0n)
      invalid.push("HISTORICAL_COMPLETE_WITHOUT_GENESIS");
    return {
      chainId,
      coverageFrom: cp?.indexedFromBlock.toString() ?? null,
      coverageThrough: cp?.indexedThroughBlock.toString() ?? null,
      missingRanges: missing,
      duplicateLogKeys: 0,
      orphanRecords: orphans + (logSum !== rows.length ? 1 : 0),
      checkpointMismatch:
        !!cp && lastTo !== null && lastTo !== cp.indexedThroughBlock,
      transfers: rows.length,
      windows: windows.length,
      blockHashInconsistencies: hashIssues,
      disputedCommittedWindows: disputed,
      invalidCheckpointState: invalid,
      witness: await this.witnessSummary(chainId),
    };
  }
  async recordWitness(w: LogWindowWitness) {
    if (w.committed) throw Error("WITNESS_COMMITTED_ONLY_WITH_WINDOW");
    this.witnesses.push({ ...w });
  }
  async listWitnessRecords(chainId: string, limit: number) {
    return this.witnesses
      .filter((w) => w.chainId === chainId)
      .slice(-Math.max(1, limit))
      .reverse()
      .map((w) => ({ ...w }));
  }
  async witnessSummary(chainId: string): Promise<WitnessSummary> {
    const windows = this.windows.get(chainId) ?? [];
    const records = this.witnesses.filter((w) => w.chainId === chainId);
    const trusted = windows.filter((w) =>
      TRUSTED.includes(w.witnessConsensus ?? ""),
    );
    const by: Record<string, number> = {};
    for (const r of records) by[r.consensus] = (by[r.consensus] ?? 0) + 1;
    const last = records[records.length - 1];
    return {
      chainId,
      windows: windows.length,
      trustedWindows: trusted.length,
      developmentWindows: windows.filter(
        (w) => w.witnessConsensus === "NO_INDEPENDENT_WITNESS",
      ).length,
      unwitnessedWindows: windows.filter((w) => !w.witnessConsensus).length,
      recordsByConsensus: by,
      lastConsensus: last?.consensus ?? null,
      lastObservedAt: last?.observedAt ?? null,
      firstTrustedFrom: trusted.length
        ? trusted
            .map((w) => w.fromBlock)
            .reduce((a, b) => (a < b ? a : b))
            .toString()
        : null,
    };
  }
  async haltChain(chainId: string, reason: string) {
    if (!/^[A-Z0-9_:.-]{1,120}$/.test(reason))
      throw Error("HALT_REASON_INVALID");
    const cp = this.checkpoints.get(chainId);
    if (cp) {
      cp.haltedReason = reason;
      cp.haltedAt = this.now();
      cp.lastError = reason.slice(0, 80);
    }
  }
  async resumeChain(chainId: string) {
    const cp = this.checkpoints.get(chainId);
    if (!cp?.haltedReason) return false;
    cp.haltedReason = null;
    cp.haltedAt = null;
    cp.lastError = null;
    return true;
  }
  async acquireBackfillLease(chainId: string, owner: string, ttlMs: number) {
    const now = this.now(),
      held = this.backfillLeases.get(chainId);
    if (held && held.expires > now && held.owner !== owner) return false;
    this.backfillLeases.set(chainId, { owner, expires: now + ttlMs });
    return true;
  }
  async releaseBackfillLease(chainId: string, owner: string) {
    const held = this.backfillLeases.get(chainId);
    if (held?.owner === owner) held.expires = this.now();
  }
  async markWindowWitnessed(
    chainId: string,
    fromBlock: bigint,
    toBlock: bigint,
    record: LogWindowWitness,
  ) {
    if (
      record.mode !== "REVERIFY" ||
      !record.committed ||
      !TRUSTED.includes(record.consensus) ||
      record.chainId !== chainId ||
      record.fromBlock !== fromBlock ||
      record.toBlock !== toBlock
    )
      throw Error("WITNESS_RECORD_MISMATCH");
    const w = (this.windows.get(chainId) ?? []).find(
      (x) =>
        x.fromBlock === fromBlock &&
        x.toBlock === toBlock &&
        x.toBlockHash === record.primaryBlockEndHash.toLowerCase() &&
        (!x.witnessConsensus ||
          x.witnessConsensus === "NO_INDEPENDENT_WITNESS"),
    );
    if (!w) return false;
    w.witnessConsensus = record.consensus as WindowRow["witnessConsensus"];
    w.logDigest = committedDigest(record);
    this.witnesses.push({ ...record });
    return true;
  }
  async windowRows(chainId: string, fromBlock: bigint, toBlock: bigint) {
    return [...this.transfers.values()]
      .filter(
        (r) =>
          r.chainId === chainId &&
          r.blockNumber >= fromBlock &&
          r.blockNumber <= toBlock,
      )
      .sort((a, b) =>
        a.blockNumber !== b.blockNumber
          ? a.blockNumber < b.blockNumber
            ? -1
            : 1
          : a.logIndex - b.logIndex,
      )
      .map((r) => ({ ...r }));
  }
  async recordBackupEvent(e: BackupEvent) {
    this.backupEvents.push({ ...e });
  }
  async purgeLimiterState(now: number) {
    let n = 0;
    for (const [id, slot] of this.slots)
      if (slot.expires < now) {
        this.slots.delete(id);
        n++;
      }
    for (const key of this.buckets.keys())
      if (Number(key.split("|").pop()) < now - 2 * 86400000) {
        this.buckets.delete(key);
        n++;
      }
    return n;
  }
  async purgeExpired(now: number) {
    let snapshots = 0;
    for (const [k, s] of this.snapshots)
      if (s.at < now - 86400000) {
        this.snapshots.delete(k);
        snapshots++;
      }
    const before = this.usage.length;
    this.usage = this.usage.filter((e) => e.at >= now - 30 * 86400000);
    return { snapshots, usageEvents: before - this.usage.length };
  }
}
