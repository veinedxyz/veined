// Otherbridge data-plane operations CLI (local/self-hosted). Read-only toward chains; never signs.
import { hostname } from "node:os";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdir, writeFile, appendFile, readFile } from "node:fs/promises";
import { connect, PostgresStore } from "../src/data/store/postgres";
import {
  loadMigrations,
  migrate,
  schemaVersion,
} from "../src/data/store/migrate";
import {
  DataPlane,
  fallbackRegistry,
  registrySnapshotSchema,
} from "../src/data/plane";
import {
  admit,
  toApproved,
  type AdmissionResult,
  type Candidate,
} from "../src/data/rpc/admission";
import {
  fetchPublicRegistry,
  registryCandidates,
} from "../src/data/rpc/registry-source";
import { httpsTransport, rpcCall, RpcError } from "../src/data/rpc/transport";
import {
  recordFailure,
  recordSuccess,
  freshHealth,
} from "../src/data/rpc/health";
import { RpcPool } from "../src/data/rpc/pool";
import { verifyMulticall } from "../src/data/evm/multicall";
import { TRANSFER_TOPIC } from "../src/data/evm/erc20";
import { indexOnce, resolveMetadata } from "../src/data/indexer/worker";
import { backfillOnce, reverifyOnce } from "../src/data/indexer/backfill";
import { parseWitnessPolicy } from "../src/data/indexer/witness";
import { indexEligibility } from "../src/data/indexer/eligibility";
import {
  provenanceForUrl,
  provenanceInventory,
  profileAllows,
  registryProfile,
} from "../src/data/registry/rpc-provenance";
import { fetchRoutingTokens } from "../src/data/registry/routing-tokens";
import { upstreamRead } from "../src/adapters/routing-core";
import { generateKey, randomId } from "../src/data/api/keys";
import { planOf, validScopes } from "../src/data/api/plans";
import { indexCoverage } from "../src/data/api/router";
import { readNative } from "../src/data/balances/evm";
import { metrics } from "../src/data/observability/log";
import curated from "../src/data/registry/rpc-candidates.json" with { type: "json" };
const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);
const evidence = process.env.OTHERBRIDGE_EVIDENCE_ROOT;
const replacer = (_k: string, v: unknown) =>
  typeof v === "bigint" ? v.toString() : v;
async function report(name: string, data: unknown) {
  if (!evidence) return;
  await mkdir(`${evidence}/data`, { recursive: true });
  await writeFile(
    `${evidence}/data/${name}`,
    JSON.stringify(data, replacer, 2),
  );
}
async function logLine(name: string, data: unknown) {
  if (!evidence) return;
  await mkdir(`${evidence}/data`, { recursive: true });
  await appendFile(
    `${evidence}/data/${name}`,
    JSON.stringify(data, replacer) + "\n",
  );
}
function dbUrl(kind: "MIGRATOR" | "INDEXER" | "DATABASE") {
  const value = process.env[`OTHERBRIDGE_DATA_${kind}_URL`];
  if (!value)
    throw Error(
      `OTHERBRIDGE_DATA_${kind}_URL missing: run pnpm data:db:init && pnpm data:db:up`,
    );
  return value;
}
const store = (
  kind: "MIGRATOR" | "INDEXER" | "DATABASE",
  application: string,
) => new PostgresStore(connect(dbUrl(kind), { max: 8, application }));
const owner = `${hostname()
  .replace(/[^a-zA-Z0-9-]/g, "")
  .slice(0, 32)}:${process.pid}:${randomBytes(4).toString("hex")}`;
async function pool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}
const password = (name: string) => {
  const v = process.env[name] ?? "";
  if (!/^[A-Za-z0-9_-]{24,64}$/.test(v))
    throw Error(`${name} missing or malformed`);
  return v;
};
// SCRAM-SHA-256 verifier computed client-side so the plaintext password never reaches server logs.
function scramVerifier(password: string) {
  const salt = randomBytes(16),
    iterations = 4096;
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const stored = createHash("sha256")
    .update(createHmac("sha256", salted).update("Client Key").digest())
    .digest();
  const server = createHmac("sha256", salted).update("Server Key").digest();
  const verifier = `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${stored.toString("base64")}:${server.toString("base64")}`;
  if (
    !/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(
      verifier,
    )
  )
    throw Error("SCRAM_VERIFIER_INVALID");
  return verifier;
}
async function ensureRoles(s: PostgresStore) {
  const sql = s.sql;
  // V1.5 monitor/backup roles are created only when their (git-ignored) secrets exist.
  const optional = [
    ["otherbridge_monitor", "OTHERBRIDGE_PG_MONITOR_PASSWORD"],
    ["otherbridge_backup", "OTHERBRIDGE_PG_BACKUP_PASSWORD"],
  ].filter(([, env]) => process.env[env]);
  for (const [role, env] of [
    ["otherbridge_api", "OTHERBRIDGE_PG_API_PASSWORD"],
    ["otherbridge_indexer", "OTHERBRIDGE_PG_INDEXER_PASSWORD"],
    ...optional,
  ] as const) {
    const pw = scramVerifier(password(env)); // base64 verifier only: no quotes, no plaintext in logs
    const [exists] =
      await sql`SELECT 1 AS x FROM pg_roles WHERE rolname = ${role}`;
    await sql.unsafe(
      `${exists ? "ALTER" : "CREATE"} ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${pw}'`,
    );
    await sql.unsafe(`GRANT CONNECT ON DATABASE otherbridge_data TO ${role}`);
    await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
  }
}
const commands: Record<string, () => Promise<number>> = {
  async "db:migrate"() {
    const s = store("MIGRATOR", "otherbridge-migrator");
    try {
      await ensureRoles(s);
      const files = await loadMigrations();
      const result = await migrate(s.sql, files);
      await s.sql.unsafe(await readFile("src/data/store/grants.sql", "utf8"));
      const tables = await s.sql`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`;
      const indexes = await s.sql`
        SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname`;
      const out = {
        at: new Date().toISOString(),
        ...result,
        files: files.map((f) => ({ name: f.name, checksum: f.checksum })),
        tables: tables.map((t) => t.table_name),
        indexes,
      };
      await report(`migrate-${Date.now()}.json`, out);
      console.log(
        JSON.stringify({
          applied: result.applied,
          alreadyApplied: result.alreadyApplied,
          schemaVersion: result.schemaVersion,
          tables: out.tables.length,
          indexes: indexes.length,
        }),
      );
      return 0;
    } finally {
      await s.close();
    }
  },
  async "db:status"() {
    const s = store("MIGRATOR", "otherbridge-status");
    try {
      const version = await schemaVersion(s.sql);
      const counts: Record<string, number> = {};
      for (const t of [
        "chains",
        "rpc_endpoints",
        "rpc_health",
        "tokens",
        "erc20_transfers",
        "wallet_token_discovery",
        "indexed_block_windows",
        "indexer_checkpoints",
        "api_clients",
        "api_keys",
        "api_usage_events",
        "rate_limit_buckets",
        "portfolio_scan_runs",
      ]) {
        const [r] = await s.sql`SELECT count(*)::int AS n FROM ${s.sql(t)}`;
        counts[t] = Number(r.n);
      }
      const out = {
        at: new Date().toISOString(),
        schemaVersion: version,
        counts,
      };
      await report("db-status.json", out);
      console.log(JSON.stringify(out));
      return 0;
    } finally {
      await s.close();
    }
  },
  async "chains:sync"() {
    const s = store("INDEXER", "otherbridge-chains-sync");
    try {
      const registry = fallbackRegistry();
      const n = await s.upsertChains(registry.chains);
      const tiers = registry.chains.reduce<Record<string, number>>(
        (m, c) => ((m[c.configuredTier] = (m[c.configuredTier] ?? 0) + 1), m),
        {},
      );
      await report("chains-sync.json", {
        at: new Date().toISOString(),
        chains: n,
        configuredTiers: tiers,
      });
      console.log(JSON.stringify({ chains: n, configuredTiers: tiers }));
      return 0;
    } finally {
      await s.close();
    }
  },
  async "rpc:sync"() {
    const s = store("INDEXER", "otherbridge-rpc-sync");
    try {
      const registry = fallbackRegistry();
      await s.upsertChains(registry.chains);
      const evm = registry.chains.filter(
        (c) =>
          c.ecosystem === "EVM" &&
          c.eip155 &&
          c.enabled &&
          c.configuredTier !== "CATALOG_ONLY",
      );
      const onlyChains = flag("chains")?.split(",").filter(Boolean);
      const wanted = new Set(
        evm
          .map((c) => c.chainId)
          .filter((id) => !onlyChains || onlyChains.includes(id)),
      );
      const candidates = new Map<string, Candidate[]>();
      const add = (c: Candidate) => {
        const list = candidates.get(c.chainId) ?? [];
        if (
          !list.some(
            (x) => x.url.replace(/\/+$/, "") === c.url.replace(/\/+$/, ""),
          )
        )
          list.push(c);
        candidates.set(c.chainId, list);
      };
      for (const [id, urls] of Object.entries(curated.evm))
        if (wanted.has(id))
          for (const url of urls)
            add({
              chainId: id,
              ecosystem: "EVM",
              url,
              provenance: "curated",
              priority: 10,
            });
      for (const [id, urls] of Object.entries(curated.svm))
        if (!onlyChains || onlyChains.includes(id))
          for (const url of urls)
            add({
              chainId: id,
              ecosystem: "SVM",
              url,
              provenance: "curated",
              priority: 10,
            });
      let registryError: string | null = null;
      if (!has("no-public-registry"))
        try {
          for (const c of registryCandidates(
            await fetchPublicRegistry(),
            wanted,
            Number(flag("per-chain-candidates") ?? 5),
          ))
            add(c);
        } catch (e) {
          registryError = e instanceof Error ? e.message : "REGISTRY_FAILED";
        }
      const target = Number(flag("approve-per-chain") ?? 2);
      const results: AdmissionResult[] = [];
      const started = Date.now();
      await pool(
        [...candidates.entries()],
        Number(flag("concurrency") ?? 16),
        async ([chainId, list]) => {
          let approved = 0;
          for (const candidate of list.slice(
            0,
            Number(flag("max-probes") ?? 6),
          )) {
            if (approved >= target) break;
            const r = await admit(candidate, httpsTransport, {
              logProbe: true,
            });
            results.push(r);
            await s.upsertEndpoint(r, candidate.priority ?? 100);
            if (r.status === "APPROVED") approved++;
          }
          void chainId;
        },
      );
      const plane = new DataPlane(s, httpsTransport, 0);
      const state = await plane.state();
      const multicall: Record<string, string> = {};
      await pool(
        state.chains.filter(
          (c) =>
            c.ecosystem === "EVM" &&
            (!onlyChains || onlyChains.includes(c.chainId)) &&
            (state.endpoints.get(c.chainId)?.length ?? 0) > 0,
        ),
        16,
        async (c) => {
          const p = plane.pool(state, c.chainId);
          if (!p) return;
          const v = await verifyMulticall(p);
          await s.setMulticall(c.chainId, v);
          if (v.verified && v.address) multicall[c.chainId] = v.address;
        },
      );
      const approved = results.filter((r) => r.status === "APPROVED");
      const snapshot = registrySnapshotSchema.parse({
        version: 1,
        generatedAt: new Date().toISOString(),
        note: "Generated by pnpm data:rpc:sync from the admission pipeline. Public RPC URLs only; secret-bearing templates are rejected before this file is written.",
        endpoints: approved
          .sort(
            (a, b) =>
              a.chainId.localeCompare(b.chainId) || a.url.localeCompare(b.url),
          )
          .map((r) => toApproved(r, r.provenance === "curated" ? 10 : 100)),
        multicall: Object.fromEntries(Object.entries(multicall).sort()),
      });
      if (has("write-snapshot"))
        await writeFile(
          "src/data/registry/rpc-registry.snapshot.json",
          JSON.stringify(snapshot, null, 2) + "\n",
        );
      const summary = {
        at: new Date().toISOString(),
        durationMs: Date.now() - started,
        registryChains: registry.chains.length,
        evmCandidateChains: wanted.size,
        candidateChainsProbed: candidates.size,
        probes: results.length,
        approved: approved.length,
        approvedChains: new Set(approved.map((r) => r.chainId)).size,
        rejected: results.length - approved.length,
        rejectReasons: results
          .filter((r) => r.status === "REJECTED")
          .reduce<Record<string, number>>(
            (m, r) => ((m[r.reason ?? "?"] = (m[r.reason ?? "?"] ?? 0) + 1), m),
            {},
          ),
        multicallVerifiedChains: Object.keys(multicall).length,
        publicRegistryError: registryError,
      };
      await report("rpc-registry.json", { summary, results });
      console.log(JSON.stringify(summary));
      return 0;
    } finally {
      await s.close();
    }
  },
  // V1.5 staging seed: imports the committed, previously admitted registry snapshot (no probing).
  // Live health/capability is then re-measured for the chains that matter by rpc:health / rpc:sync.
  async "rpc:seed-snapshot"() {
    // Never in a release-profile deployment: seeding marks endpoints approved without probing them.
    if (registryProfile().profile === "release")
      throw Error("SEED_SNAPSHOT_REFUSED_RELEASE_PROFILE");
    const s = store("INDEXER", "otherbridge-rpc-seed");
    try {
      const f = fallbackRegistry();
      await s.upsertChains(f.chains);
      for (const e of f.endpoints) {
        const host = new URL(e.url).hostname;
        await s.upsertEndpoint(
          {
            chainId: e.chainId,
            url: e.url,
            host,
            provenance: e.allowPort ? "curated" : "public-registry",
            status: "APPROVED",
            reason: null,
            latencyMs: null,
            latestBlock: null,
            supportsLogs: e.supportsLogs,
            maxLogRange: e.maxLogRange,
            supportsBatch: e.supportsBatch,
            supportsFinalized: e.supportsFinalized,
            supportsSafe: e.supportsSafe,
            archive: e.archive,
            logsPerBlock: null,
            checkedAt: Date.now(),
          },
          e.priority,
        );
      }
      for (const [chainId, address] of Object.entries(f.multicall))
        await s.setMulticall(chainId, {
          address,
          codeHash: null,
          verified: true,
          observedAt: Date.now(),
        });
      const out = {
        at: new Date().toISOString(),
        chains: f.chains.length,
        endpoints: f.endpoints.length,
        multicall: Object.keys(f.multicall).length,
      };
      await report("rpc-seed-snapshot.json", out);
      console.log(JSON.stringify(out));
      return 0;
    } finally {
      await s.close();
    }
  },
  async "rpc:health"() {
    const s = store("INDEXER", "otherbridge-rpc-health");
    try {
      const plane = new DataPlane(s, httpsTransport, 0);
      const state = await plane.state();
      const healthChains = flag("chains")?.split(",").filter(Boolean);
      const endpoints = [...state.endpoints.values()]
        .flat()
        .filter((e) => !healthChains || healthChains.includes(e.chainId));
      const rows: Record<string, unknown>[] = [];
      await pool(endpoints, Number(flag("concurrency") ?? 16), async (e) => {
        const chain = state.chains.find((c) => c.chainId === e.chainId);
        if (!chain) return;
        const eco = chain.ecosystem === "SVM" ? "SVM" : "EVM";
        const started = Date.now();
        let h = plane.health.get(e.id) ?? freshHealth();
        try {
          if (eco === "SVM") {
            await rpcCall(
              httpsTransport,
              e,
              { method: "getGenesisHash", params: [] },
              { ecosystem: "SVM" },
              { timeoutMs: 6000 },
            );
            const slot = await rpcCall(
              httpsTransport,
              e,
              { method: "getSlot", params: [{ commitment: "finalized" }] },
              { ecosystem: "SVM" },
              { timeoutMs: 6000 },
            );
            h = recordSuccess(
              h,
              Date.now() - started,
              Date.now(),
              BigInt(Number(slot)),
            );
            rows.push({
              endpoint: e.id,
              chainId: e.chainId,
              ok: true,
              latencyMs: h.latencyMs,
              head: String(slot),
              logsPerBlock: null,
              supportsLogs: false,
              maxLogRange: 0,
            });
          } else {
            const id = await rpcCall(
              httpsTransport,
              e,
              { method: "eth_chainId", params: [] },
              { ecosystem: "EVM" },
              { timeoutMs: 6000 },
            );
            if (BigInt(String(id)) !== BigInt(e.chainId))
              throw new RpcError("INVALID_RESPONSE", "CHAIN_MISMATCH");
            const block = await rpcCall(
              httpsTransport,
              e,
              { method: "eth_blockNumber", params: [] },
              { ecosystem: "EVM" },
              { timeoutMs: 6000 },
            );
            const head = BigInt(String(block));
            h = recordSuccess(h, Date.now() - started, Date.now(), head);
            let logsPerBlock: number | null = null;
            if (e.supportsLogs && has("measure-logs")) {
              try {
                const logs = (await rpcCall(
                  httpsTransport,
                  e,
                  {
                    method: "eth_getLogs",
                    params: [
                      {
                        fromBlock: `0x${(head - 19n).toString(16)}`,
                        toBlock: `0x${head.toString(16)}`,
                        topics: [TRANSFER_TOPIC],
                      },
                    ],
                  },
                  { ecosystem: "EVM", maxLogRange: 21 },
                  { timeoutMs: 10000, maxBytes: 16000000 },
                )) as unknown[];
                logsPerBlock = Math.round((logs.length / 20) * 100) / 100;
              } catch {
                logsPerBlock = null;
              }
            }
            rows.push({
              endpoint: e.id,
              chainId: e.chainId,
              ok: true,
              latencyMs: h.latencyMs,
              head: head.toString(),
              logsPerBlock,
              supportsLogs: e.supportsLogs,
              maxLogRange: e.maxLogRange,
            });
          }
        } catch (error) {
          const code =
            error instanceof RpcError
              ? error.detail === "CHAIN_MISMATCH"
                ? "CHAIN_MISMATCH"
                : error.code
              : "PROBE_FAILED";
          h = recordFailure(h, code, Date.now());
          rows.push({
            endpoint: e.id,
            chainId: e.chainId,
            ok: false,
            error: code,
            quarantinedUntil: h.quarantinedUntil,
          });
        }
        plane.health.set(e.id, h);
        await s.recordHealth(e.id, h);
        metrics.inc("rpc_health_checks_total", {
          chain: e.chainId,
          ok: String(h.consecutiveFailures === 0),
        });
      });
      const out = {
        at: new Date().toISOString(),
        endpoints: endpoints.length,
        healthy: rows.filter((r) => r.ok).length,
        unhealthy: rows.filter((r) => !r.ok).length,
        chainsHealthy: new Set(rows.filter((r) => r.ok).map((r) => r.chainId))
          .size,
        rows: rows.sort((a, b) =>
          String(a.chainId).localeCompare(String(b.chainId)),
        ),
      };
      await report(
        has("measure-logs") ? "rpc-measurement.json" : "rpc-health.json",
        out,
      );
      console.log(
        JSON.stringify({
          endpoints: out.endpoints,
          healthy: out.healthy,
          unhealthy: out.unhealthy,
          chainsHealthy: out.chainsHealthy,
        }),
      );
      return 0;
    } finally {
      await s.close();
    }
  },
  async "tokens:sync"() {
    const s = store("INDEXER", "otherbridge-token-sync");
    try {
      const chains = (await s.listChains()).filter(
        (c) => c.routable && (c.ecosystem === "EVM" || c.ecosystem === "SVM"),
      );
      const counts: Record<string, number> = {};
      const errors: Record<string, string> = {};
      for (const c of chains) {
        try {
          const tokens =
            (await fetchRoutingTokens(upstreamRead, [c.chainId])).get(
              c.chainId,
            ) ?? [];
          await s.upsertTokens(
            tokens.map((t) => ({
              chainId: c.chainId,
              address: t.address,
              symbol: t.symbol,
              name: t.name,
              decimals: t.decimals,
              suspicious: t.suspicious,
              metadataStatus: "OK",
              sources: ["routing-catalog"],
              price: t.price.priceUsd ? t.price : null,
            })),
          );
          counts[c.chainId] = tokens.length;
        } catch (e) {
          errors[c.chainId] =
            e instanceof Error ? e.message.slice(0, 60) : "FAILED";
        }
      }
      const out = {
        at: new Date().toISOString(),
        chains: chains.length,
        tokens: Object.values(counts).reduce((a, b) => a + b, 0),
        counts,
        errors,
      };
      await report("tokens-sync.json", out);
      console.log(
        JSON.stringify({
          chains: out.chains,
          tokens: out.tokens,
          errors: Object.keys(errors).length,
        }),
      );
      return 0;
    } finally {
      await s.close();
    }
  },
  async "indexer:once"() {
    return runIndexer(1);
  },
  async "indexer:run"() {
    return runIndexer(flag("cycles") ? Number(flag("cycles")) : Infinity);
  },
  async coverage() {
    const s = store("INDEXER", "otherbridge-coverage");
    try {
      const plane = new DataPlane(s, httpsTransport, 0);
      const state = await plane.state();
      const now = Date.now();
      const { effectiveTier } = await import("../src/data/registry/chains");
      const chains = state.chains.map((c) => {
        const endpoints = state.endpoints.get(c.chainId) ?? [];
        const cp = state.checkpoints.get(c.chainId);
        return {
          chainId: c.chainId,
          name: c.name,
          ecosystem: c.ecosystem,
          configuredTier: c.configuredTier,
          tier: effectiveTier(c, {
            healthyRpc: endpoints.length > 0,
            logs: endpoints.some((e) => e.supportsLogs),
            tokenUniverse: (state.tokenCounts.get(c.chainId) ?? 0) > 0,
            indexStarted: !!cp && cp.indexedThroughBlock >= cp.indexedFromBlock,
          }),
          endpoints: endpoints.length,
          multicall: !!c.multicall,
          tokens: state.tokenCounts.get(c.chainId) ?? 0,
          index: indexCoverage(state, c, now),
        };
      });
      const byTier = chains.reduce<Record<string, number>>(
        (m, c) => ((m[c.tier] = (m[c.tier] ?? 0) + 1), m),
        {},
      );
      const out = {
        at: new Date().toISOString(),
        status: state.status,
        chains: chains.length,
        byTier,
        indexed: chains.filter((c) => c.index),
        detail: chains,
      };
      await report(`coverage-${flag("label") ?? "latest"}.json`, out);
      console.log(
        JSON.stringify({
          status: out.status,
          chains: out.chains,
          byTier,
          indexedChains: out.indexed.length,
        }),
      );
      return 0;
    } finally {
      await s.close();
    }
  },
  async "verify-index"() {
    const s = store("INDEXER", "otherbridge-verify-index");
    try {
      const plane = new DataPlane(s, httpsTransport, 0);
      const state = await plane.state();
      const rows = [];
      let failed = false;
      for (const cp of state.checkpoints.values()) {
        const chain = state.chains.find((c) => c.chainId === cp.chainId)!;
        const v = await s.verifyIndex(cp.chainId);
        const p = plane.pool(state, cp.chainId);
        let head: string | null = null,
          resolver = "UNAVAILABLE";
        if (p)
          try {
            const n = await readNative(
              p,
              "0x0000000000000000000000000000000000000001",
            );
            head = n.block.toString();
            resolver = "OK";
          } catch {
            resolver = "FAILED";
          }
        const consistent =
          !v.missingRanges.length &&
          !v.duplicateLogKeys &&
          !v.orphanRecords &&
          !v.checkpointMismatch &&
          !v.blockHashInconsistencies &&
          !v.disputedCommittedWindows &&
          !v.invalidCheckpointState?.length;
        if (!consistent) failed = true;
        const lag = head ? BigInt(head) - cp.indexedThroughBlock : null;
        const tolerance = BigInt(Math.max(64, chain.finality.depth * 2 + 16));
        const eligibility = indexEligibility({
          chainId: cp.chainId,
          endpoints: state.endpoints.get(cp.chainId) ?? [],
          checkpoint: cp,
          witness: v.witness,
          verification: v,
          resolverOk: resolver === "OK",
          indexCurrent: lag !== null && lag <= tolerance && !cp.haltedReason,
          releaseAllowed: (e) => e.reviewStatus === "APPROVED_FOR_RELEASE",
        });
        rows.push({
          ...v,
          chain: chain?.name,
          headBlock: head,
          finalityLag: lag?.toString() ?? null,
          resolver,
          consistent,
          halted: cp.haltedReason ?? null,
          lastError: cp.lastError,
          eligibility,
        });
      }
      const out = {
        at: new Date().toISOString(),
        chains: rows.length,
        result: failed ? "FAIL" : "PASS",
        rows,
      };
      await report(
        `verify-index${flag("label") ? `-${flag("label")}` : ""}.json`,
        out,
      );
      console.log(JSON.stringify({ chains: rows.length, result: out.result }));
      return failed ? 1 : 0;
    } finally {
      await s.close();
    }
  },
  async "client:create"() {
    const name = flag("name"),
      plan = flag("plan") ?? "developer",
      scopes = (flag("scopes") ?? "chains:read").split(",");
    if (!name || !/^[\w .-]{1,80}$/.test(name))
      throw Error("--name required (1-80 safe chars)");
    planOf(plan);
    const s = store("MIGRATOR", "otherbridge-admin");
    try {
      const id = randomId("cli");
      await s.createClient({
        id,
        displayName: name,
        status: "ACTIVE",
        planId: plan,
        scopes: validScopes(scopes),
        createdAt: Date.now(),
      });
      console.log(JSON.stringify({ clientId: id, plan, scopes }));
      return 0;
    } finally {
      await s.close();
    }
  },
  async "key:create"() {
    const clientId = flag("client");
    if (!clientId || !has("yes"))
      throw Error("Explicit: pnpm data:key:create --client <cli_...> --yes");
    if (!process.stdout.isTTY && !has("stdout-json"))
      throw Error(
        "Refusing to print a one-time secret to a redirected stdout; pass --stdout-json and keep the target outside the repository",
      );
    const s = store("MIGRATOR", "otherbridge-admin");
    try {
      if (!(await s.getClient(clientId))) throw Error("UNKNOWN_CLIENT");
      const k = generateKey(has("test") ? "test" : "live");
      const id = randomId("key");
      await s.createKey({
        id,
        clientId,
        prefix: k.prefix,
        verifier: k.verifier,
        status: "ACTIVE",
        createdAt: Date.now(),
        revokedAt: null,
        lastUsedAt: null,
      });
      // The only time the plaintext exists outside the caller: printed once, never written to disk/logs.
      process.stderr.write(
        "Store this key in a secret manager now; it cannot be shown again.\n",
      );
      process.stdout.write(
        `${JSON.stringify({ keyId: id, prefix: k.prefix, apiKey: k.plaintext })}\n`,
      );
      return 0;
    } finally {
      await s.close();
    }
  },
  async "key:revoke"() {
    const key = flag("key");
    if (!key) throw Error("--key <key_...|prefix> required");
    const s = store("MIGRATOR", "otherbridge-admin");
    try {
      const revoked = await s.revokeKey(key, Date.now());
      console.log(JSON.stringify({ revoked }));
      return revoked ? 0 : 1;
    } finally {
      await s.close();
    }
  },
  async "usage:show"() {
    const client = flag("client");
    if (!client) throw Error("--client required");
    const s = store("MIGRATOR", "otherbridge-admin");
    try {
      const rows = await s.usageSummary(
        client,
        flag("since") ??
          new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10),
      );
      console.log(
        JSON.stringify({ client, billingEnabled: false, rows }, null, 2),
      );
      return 0;
    } finally {
      await s.close();
    }
  },
  async "retention:purge"() {
    const s = store("MIGRATOR", "otherbridge-retention");
    try {
      const out = await s.purgeExpired(Date.now());
      await report("retention-purge.json", {
        at: new Date().toISOString(),
        ...out,
      });
      console.log(JSON.stringify(out));
      return 0;
    } finally {
      await s.close();
    }
  },
  // V1.5: an operator clears a consensus/integrity pause only after investigating the evidence.
  async "indexer:resume"() {
    const chain = flag("chain");
    const reason = flag("reason");
    if (
      !chain ||
      !/^\d{1,18}$/.test(chain) ||
      !has("yes") ||
      !reason ||
      !/^[\w .:,-]{8,160}$/.test(reason)
    )
      throw Error(
        "Explicit: pnpm data:indexer:resume --chain <id> --reason '<investigation note>' --yes",
      );
    const s = store("INDEXER", "otherbridge-indexer-resume");
    try {
      const before = await s.getCheckpoint(chain);
      const resumed = await s.resumeChain(chain);
      const out = {
        at: new Date().toISOString(),
        chainId: chain,
        resumed,
        previousHalt: before?.haltedReason ?? null,
        reason,
      };
      await logLine("indexer-resume.jsonl", out);
      console.log(JSON.stringify(out));
      return resumed ? 0 : 1;
    } finally {
      await s.close();
    }
  },
  async "indexer:rewitness"() {
    const only = flag("chain");
    const s = store("INDEXER", "otherbridge-rewitness");
    try {
      const plane = new DataPlane(s, httpsTransport, 0);
      const state = await plane.state();
      const targets = state.chains.filter((c) =>
        only ? c.chainId === only : c.configuredTier === "FULL_INDEXED",
      );
      let failed = false;
      for (const chain of targets) {
        const p = plane.pool(state, chain.chainId);
        if (!p) continue;
        const r = await reverifyOnce(s, p, chain, {
          maxWindows: Number(flag("max-windows") ?? 20),
        });
        if (r.status === "HALTED" || r.status === "ERROR") failed = true;
        const line = {
          at: new Date().toISOString(),
          ...r,
          records: r.records.length,
        };
        await logLine("rewitness-log.jsonl", line);
        for (const d of r.disputes) await logLine("witness-disputes.jsonl", d);
        for (const rec of r.records)
          await logLine("witness-records.jsonl", rec);
        console.log(JSON.stringify(line));
        for (const [id, h] of p.healthSnapshot())
          await s.recordHealth(id, h).catch(() => {});
      }
      return failed ? 1 : 0;
    } finally {
      await s.close();
    }
  },
  async "indexer:backfill"() {
    const only = flag("chain");
    if (!only) throw Error("--chain required");
    const s = store("INDEXER", "otherbridge-backfill");
    try {
      const plane = new DataPlane(s, httpsTransport, 0);
      const state = await plane.state();
      const chain = state.chains.find((c) => c.chainId === only);
      const p = chain && plane.pool(state, only);
      if (!chain || !p) throw Error("NO_VETTED_RPC");
      const r = await backfillOnce(s, p, chain, `${owner}:bf`, {
        maxWindows: Number(flag("max-windows") ?? 5),
        range: Number(flag("range") ?? 200),
        witness: parseWitnessPolicy(
          flag("witness") ?? process.env.OTHERBRIDGE_INDEX_WITNESS,
          registryProfile().profile,
        ),
      });
      const line = {
        at: new Date().toISOString(),
        ...r,
        records: r.records.length,
      };
      await logLine("backfill-log.jsonl", line);
      for (const rec of r.records) await logLine("witness-records.jsonl", rec);
      for (const d of r.disputes) await logLine("witness-disputes.jsonl", d);
      console.log(JSON.stringify(line));
      return r.status === "ERROR" || r.status === "HALTED" ? 1 : 0;
    } finally {
      await s.close();
    }
  },
  async "rpc:provenance"() {
    const s = store("INDEXER", "otherbridge-rpc-provenance");
    try {
      const endpoints = await s.listEndpoints();
      const profile = registryProfile().profile;
      const rows = endpoints.map((e) => {
        const p = provenanceForUrl(e.url);
        return {
          endpointId: e.id,
          chainId: e.chainId,
          host: new URL(e.url).hostname,
          supportsLogs: e.supportsLogs,
          operatorGroup: p.operatorGroup,
          inventoryGroup: p.inventoryGroup ?? null,
          reviewStatus: p.reviewStatus,
          witnessEligible: p.witnessEligible,
          releaseAllowed: p.releaseAllowed,
          allowedInRelease: profileAllows("release", p),
          allowedInProfile: profileAllows(profile, p),
        };
      });
      const count = (k: keyof (typeof rows)[number]) =>
        rows.reduce<Record<string, number>>(
          (m, r) => ((m[String(r[k])] = (m[String(r[k])] ?? 0) + 1), m),
          {},
        );
      const out = {
        at: new Date().toISOString(),
        profile,
        inventoryGroups: provenanceInventory.groups.length,
        inventoryByStatus: provenanceInventory.groups.reduce<
          Record<string, number>
        >(
          (m, g) => ((m[g.reviewStatus] = (m[g.reviewStatus] ?? 0) + 1), m),
          {},
        ),
        endpoints: rows.length,
        endpointsByStatus: count("reviewStatus"),
        releaseRegistryEndpoints: rows.filter((r) => r.allowedInRelease).length,
        rows,
      };
      await report("rpc-provenance.json", out);
      console.log(
        JSON.stringify({
          profile,
          endpoints: out.endpoints,
          endpointsByStatus: out.endpointsByStatus,
          releaseRegistryEndpoints: out.releaseRegistryEndpoints,
        }),
      );
      // Release policy gate, recomputed from the raw inventory (not from the policy function under
      // test): an endpoint is release-admissible only through an APPROVED_FOR_RELEASE group with a
      // recorded legal review reference and a known operator; the active profile must agree.
      const violations = rows.filter((r) => {
        const g = provenanceInventory.groups.find(
          (x) => x.operatorGroup === r.inventoryGroup,
        );
        const expected =
          !!g &&
          g.reviewStatus === "APPROVED_FOR_RELEASE" &&
          !!g.legalReviewRef &&
          g.provenance !== "unknown";
        return (
          (r.allowedInRelease && !expected) ||
          (profile === "release" && r.allowedInProfile && !expected)
        );
      });
      if (violations.length)
        console.error(
          JSON.stringify({
            releasePolicyViolations: violations.map((r) => r.endpointId),
          }),
        );
      return violations.length ? 1 : 0;
    } finally {
      await s.close();
    }
  },
  async help() {
    console.log(Object.keys(commands).join("\n"));
    return 0;
  },
};
async function runIndexer(cycles: number) {
  // Fatal misconfiguration exits non-zero before any work (no silent default for a typo).
  const witness = parseWitnessPolicy(
    flag("witness") ?? process.env.OTHERBRIDGE_INDEX_WITNESS,
    registryProfile().profile,
  );
  const s = store("INDEXER", "otherbridge-indexer");
  const stop = new AbortController();
  const shutdown = () => stop.abort();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    const plane = new DataPlane(s, httpsTransport, 0);
    let cycle = 0;
    while (cycle < cycles && !stop.signal.aborted) {
      cycle++;
      plane.invalidate();
      const state = await plane.state();
      const only = flag("chain");
      const targets = state.chains.filter(
        (c) =>
          (only ? c.chainId === only : c.configuredTier === "FULL_INDEXED") &&
          c.ecosystem === "EVM",
      );
      for (const chain of targets) {
        if (stop.signal.aborted) break;
        const p: RpcPool | null = plane.pool(state, chain.chainId);
        if (!p) {
          await logLine("indexer-log.jsonl", {
            at: new Date().toISOString(),
            chainId: chain.chainId,
            status: "NO_VETTED_RPC",
          });
          continue;
        }
        const r = await indexOnce(s, p, chain, owner, {
          maxWindows: Number(flag("max-windows") ?? 40),
          maxMs: Number(flag("max-ms") ?? 45000),
          initialRange: flag("range") ? Number(flag("range")) : undefined,
          signal: stop.signal,
          witness,
        });
        for (const d of r.disputes) await logLine("witness-disputes.jsonl", d);
        const m = await resolveMetadata(
          s,
          p,
          (await s.listChains()).find((c) => c.chainId === chain.chainId)!,
          150,
          stop.signal,
        ).catch(() => ({ resolved: 0, failed: 0 }));
        for (const [id, h] of p.healthSnapshot())
          await s.recordHealth(id, h).catch(() => {});
        metrics.inc(
          "indexer_windows_total",
          { chain: chain.chainId },
          r.windows,
        );
        metrics.inc("indexer_logs_total", { chain: chain.chainId }, r.inserted);
        const line = {
          at: new Date().toISOString(),
          cycle,
          witnessPolicy: witness,
          ...r,
          disputes: r.disputes.length,
          metadata: m,
        };
        await logLine("indexer-log.jsonl", line);
        console.log(JSON.stringify(line));
      }
      if (cycle < cycles && !stop.signal.aborted)
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, Number(flag("interval") ?? 15) * 1000);
          stop.signal.addEventListener(
            "abort",
            () => (clearTimeout(t), resolve()),
            { once: true },
          );
        });
    }
    return 0;
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await s.close();
  }
}
const run = commands[command];
if (!run) {
  console.error(`Unknown command ${command}`);
  process.exit(2);
}
run()
  .then((code) => process.exit(code))
  .catch((error) => {
    // Never echo connection strings or keys.
    console.error(
      String(error instanceof Error ? error.message : error).replace(
        /postgres(ql)?:\/\/[^\s]+/g,
        "[database-url]",
      ),
    );
    process.exit(1);
  });
