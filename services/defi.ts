import { readFile } from "node:fs/promises";
import { connect, PostgresStore } from "../src/data/store/postgres";
import { DataPlane } from "../src/data/plane";
import { PostgresDefiStore } from "../src/defi/store";
import { deployments } from "../src/defi/registry";
import { indexDefiOnce } from "../src/defi/indexer";
import { loadCatalog } from "../src/defi/universe/store";
import { buildQueue } from "../src/defi/universe/queue";
import { loadUniverseIntoDb } from "../src/defi/universe/db";
import { buildReverseIndex } from "../src/defi/reverse-index";
import { LANES, httpLogSource, indexLaneOnce } from "../src/defi/lanes";
import { defaultTierConfig } from "../src/data/registry/chains";
const url =
  process.env.OTHERBRIDGE_DATA_INDEXER_URL ??
  process.env.OTHERBRIDGE_DATA_DATABASE_URL;
if (!url) throw Error("DATABASE_REQUIRED");
const sql = connect(url, { max: 2, application: "otherbridge-defi-indexer" }),
  store = new PostgresDefiStore(sql);
try {
  const [job, id, from] = process.argv.slice(2);
  if (job === "registry") {
    await store.syncRegistry();
    const sources = JSON.parse(
      await readFile("src/defi/sources/manifest.json", "utf8"),
    );
    for (const s of sources)
      await sql`INSERT INTO defi_protocol_sources VALUES(${s.sha256},${s.url},${s.revision},${new Date(s.fetchedAt)},${s.terms}) ON CONFLICT DO NOTHING`;
    console.log(
      JSON.stringify({
        deployments: deployments.length,
        sources: sources.length,
      }),
    );
  } else if (job === "index") {
    const d = deployments.find((d) => d.id === id);
    if (!d) throw Error("UNSUPPORTED_DEPLOYMENT");
    const plane = new DataPlane(new PostgresStore(sql)),
      state = await plane.state(),
      pool = plane.pool(state, d.chainId);
    if (!pool) throw Error("NO_RPC");
    console.log(
      JSON.stringify(
        await indexDefiOnce(sql, pool, d, {
          fromBlock: from ? BigInt(from) : undefined,
        }),
      ),
    );
  } else if (job === "universe") {
    // V1.14: load the accepted last-good catalog (identity, relations, coverage, queue, reverse index) into Postgres.
    const index = await loadCatalog();
    const meta = JSON.parse(
      await readFile("content/defi-universe/sources.json", "utf8"),
    );
    const receipt = JSON.parse(
      await readFile("content/defi-universe/sync-receipt.json", "utf8"),
    );
    const sources = [
      ...meta.sources.map(
        (s: { id: string; url: string; sha256: string; bytes: number }) => ({
          id: s.id,
          url: s.url,
          revision: null,
          sha256: s.sha256,
          bytes: s.bytes,
          license: "LEGAL_REVIEW_REQUIRED",
          use: "catalog",
        }),
      ),
      ...meta.pinnedRepositories.map(
        (r: {
          repo: string;
          revision: string | null;
          license: string;
          use: string;
        }) => ({
          id: r.repo,
          url: "https://github.com/" + r.repo,
          revision: r.revision,
          sha256: null,
          bytes: null,
          license: r.license,
          use: r.use,
        }),
      ),
    ];
    console.log(
      JSON.stringify(
        await loadUniverseIntoDb(
          sql,
          index,
          receipt,
          buildQueue(index),
          buildReverseIndex(deployments),
          sources,
        ),
      ),
    );
  } else if (job === "lane") {
    // V1.14 registry backfill lane (resumable). The log source is operator-configured per chain:
    // OTHERBRIDGE_DEFI_LOG_RPC_<chainId>=https://<allowlisted host>/… (backfill only; never used by wallet requests).
    const d = deployments.find((x) => x.id === id);
    if (!d) throw Error("UNSUPPORTED_DEPLOYMENT");
    const spec = (LANES[d.adapter] ?? []).find((l) => l.lane === from);
    if (!spec) throw Error("UNKNOWN_LANE");
    const url = process.env["OTHERBRIDGE_DEFI_LOG_RPC_" + d.chainId];
    if (!url) throw Error("LOG_SOURCE_NOT_CONFIGURED");
    const source = httpLogSource(url);
    const finality = BigInt(
      (
        defaultTierConfig.finality[d.chainId] ??
        defaultTierConfig.finality.default
      ).depth,
    );
    for (let step = 0; step < 200; step++) {
      const r = await indexLaneOnce(sql, source, d, spec, { finality });
      console.log(JSON.stringify({ deployment: d.id, lane: spec.lane, ...r }));
      if (r.state === "CURRENT") break;
    }
  } else if (job === "retention") {
    await store.purge();
    console.log("EXPIRED_SNAPSHOTS_PURGED");
  } else
    throw Error(
      "USAGE: registry | universe | index <deployment> [fromBlock] | retention",
    );
} finally {
  await sql.end();
}
