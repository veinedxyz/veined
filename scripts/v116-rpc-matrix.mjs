import { writeFileSync, mkdirSync } from "node:fs";
import postgres from "postgres";
import {
  provenanceForUrl,
  provenanceInventory,
} from "../src/data/registry/rpc-provenance.ts";
const out = process.argv[2];
if (!out) throw Error("NEW_OUTPUT_REQUIRED");
mkdirSync(out, { recursive: true });
const sql = postgres(process.env.OTHERBRIDGE_DATA_DATABASE_URL, {
  max: 1,
  onnotice: () => {},
  connection: {
    application_name: "v116-readonly-rpc-inventory",
    default_transaction_read_only: "on",
  },
});
let records;
try {
  records =
    await sql`SELECT e.chain_id,e.url,e.priority,e.status,h.checked_at,h.consecutive_failures,h.latency_ms,h.quarantined_until FROM rpc_endpoints e LEFT JOIN rpc_health h ON h.endpoint_id=e.id WHERE e.status='APPROVED' ORDER BY e.chain_id,e.priority,e.id`;
} finally {
  await sql.end();
}
const at = new Date().toISOString();
const rows = records.map((e) => {
  const p = provenanceForUrl(e.url),
    g = provenanceInventory.groups.find(
      (g) => g.operatorGroup === p.inventoryGroup,
    ),
    u = new URL(e.url);
  return {
    chain: String(e.chain_id),
    operator: g?.operator ?? "UNKNOWN",
    origin: u.origin,
    termsState: p.reviewStatus,
    termsUrl: g?.termsUrl ?? null,
    quota: g?.rateLimitNotes || "OWNER/OPERATOR_CONFIRMATION_REQUIRED",
    health: {
      checkedAt: e.checked_at,
      consecutiveFailures: e.consecutive_failures,
      latencyMs: e.latency_ms,
      quarantinedUntil: e.quarantined_until,
      status:
        !e.checked_at || Date.now() - new Date(e.checked_at).getTime() > 300000
          ? "STALE_OR_UNOBSERVED"
          : e.consecutive_failures
            ? "DEGRADED"
            : "OBSERVED_HEALTHY",
    },
    fallback: records
      .filter((x) => x.chain_id === e.chain_id && x.url !== e.url)
      .map((x) => new URL(x.url).origin),
    productionApproval: p.releaseAllowed ? "APPROVED" : "BLOCKED",
    legalReviewRef: g?.legalReviewRef ?? null,
  };
});
writeFileSync(
  out + "/rpc-release-matrix.json",
  JSON.stringify(
    {
      at,
      rows,
      productionApproved: rows.filter(
        (r) => r.productionApproval === "APPROVED",
      ).length,
      method:
        "Read-only local registry + health snapshot; stale observations explicitly unknown; fallback listing is not production approval",
      publicRpcWrites: 0,
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(
  "docs/V116_RPC_RELEASE_MATRIX.md",
  `# V1.16 RPC release matrix\n\nObserved ${at}. ${rows.length} admitted research/staging endpoints; ${rows.filter((r) => r.productionApproval === "APPROVED").length} production-approved endpoints. Raw machine-readable matrix with per-chain alternatives, stored health timestamps, terms references and quotas is in operations/rpc-matrix/rpc-release-matrix.json. Approval to research or stage does not authorize production. Unknown operator, terms, quota or stale health remains explicit; public production startup rejects all unapproved Swap RPC origins. Fresh fixed Swap RPC pin observations are separately recorded under sources/current-pins.\n\n| Chain | Operator | Origin | Terms | Health | Production |\n|---|---|---|---|---|---|\n` +
    rows
      .map(
        (r) =>
          `| ${r.chain} | ${r.operator.replaceAll("|", "/")} | ${r.origin} | ${r.termsState} | ${r.health.status} | ${r.productionApproval} |`,
      )
      .join("\n") +
    "\n",
);
console.log({
  rows: rows.length,
  productionApproved: rows.filter((r) => r.productionApproval === "APPROVED")
    .length,
});
