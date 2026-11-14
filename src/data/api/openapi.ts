import { brand } from "../../content/brand";
import { z } from "zod";
import { positionSchema, scanSchema } from "../../defi/model";
import { COST, PLANS, SCOPES } from "./plans";
// OpenAPI 3.1 for the internal-first Otherbridge Data API (/v1). Not publicly launched; no billing.
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const errorResponses = Object.fromEntries(
  ["400", "401", "403", "404", "422", "429", "500", "503", "504"].map(
    (code) => [
      code,
      {
        description: "Error envelope",
        content: { "application/json": { schema: ref("ErrorEnvelope") } },
      },
    ],
  ),
);
const ok = (schema: object, description: string) => ({
  "200": {
    description,
    headers: {
      "X-Request-Id": { schema: { type: "string" } },
      "X-Cost-Units": { schema: { type: "integer" } },
    },
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["data", "requestId"],
          properties: { data: schema, requestId: { type: "string" } },
        },
      },
    },
  },
  ...errorResponses,
});
interface Param {
  name: string;
  in: "path" | "query";
  required: boolean;
  description: string;
  schema: object;
}
const p = (
  name: string,
  where: "path" | "query",
  schema: object,
  description: string,
  required = where === "path",
): Param => ({
  name,
  in: where,
  required,
  description,
  schema,
});
const chainParam = p(
  "chainId",
  "path",
  { type: "string", pattern: "^\\d{1,18}$" },
  `${brand.name} chain ID (EIP-155 for EVM).`,
);
const addressParam = p(
  "address",
  "path",
  { type: "string", maxLength: 128 },
  "Public wallet address (EVM 0x or Solana base58).",
);
const cursorParam = p(
  "cursor",
  "query",
  { type: "string", maxLength: 400 },
  "Opaque pagination cursor from the previous page.",
);
const limitParam = (max: number) =>
  p(
    "limit",
    "query",
    { type: "integer", minimum: 1, maximum: max },
    `Page size (max ${max}).`,
  );
const op = (
  summary: string,
  scope: string | null,
  cost: string,
  parameters: Param[],
  responses: object,
  extra: object = {},
) => ({
  summary,
  description: `${scope ? `Scope: \`${scope}\`. ` : "Public. "}Cost units: ${cost}.`,
  ...(scope ? { security: [{ apiKey: [] }] } : { security: [] }),
  parameters,
  responses,
  ...extra,
});
export function openApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: `${brand.name} Data API`,
      version: "1.5.0",
      summary: "Self-hosted, read-only blockchain portfolio and coverage data.",
      description:
        "Internal-first API. Coverage is explicit: chains that were not checked are never reported as empty. No billing is enabled. Responses are read-only; there are no write scopes.",
    },
    servers: [
      {
        url: "http://127.0.0.1:3200",
        description: "Local loopback service only",
      },
    ],
    security: [{ apiKey: [] }],
    "x-otherbridge": {
      billingEnabled: false,
      scopes: SCOPES,
      plans: PLANS,
      costUnits: { ...COST, portfolio: "2 + maxChains (pre-charged)" },
    },
    paths: {
      "/v1/defi/catalog/protocols": {
        get: op(
          "Global DeFi protocol catalog (search, filters, pages)",
          "chains:read",
          "200",
          [
            p(
              "q",
              "query",
              { type: "string", maxLength: 80 },
              "Search name, slug, category, parent.",
            ),
            p("category", "query", { type: "string" }, "Product category."),
            p(
              "chain",
              "query",
              { type: "string" },
              "Catalog chain key (chain:<slug>).",
            ),
            p(
              "coverage",
              "query",
              { type: "string" },
              "FULL_POSITION … DEPRECATED.",
            ),
            p(
              "status",
              "query",
              { type: "string" },
              "ACTIVE (default), INACTIVE or ALL.",
            ),
            p(
              "vm",
              "query",
              { type: "string" },
              "EVM, Solana, Sui, Aptos, Cosmos, Bitcoin, Tron, Stellar, Other.",
            ),
            p("sort", "query", { type: "string" }, "tvl (default) or name."),
            limitParam(100),
            cursorParam,
          ],
          ok(
            { type: "object" },
            "Every cataloged protocol with explicit coverage; TVL is protocol context, never a wallet value.",
          ),
        ),
      },
      "/v1/defi/catalog/protocols/{id}": {
        get: op(
          "Catalog protocol detail",
          "chains:read",
          "200",
          [p("id", "path", { type: "string" }, "llama:<id> or slug.")],
          ok(
            { type: "object" },
            "Identity, category, chains, TVL context, per-chain coverage and limitations.",
          ),
        ),
      },
      "/v1/defi/catalog/chains": {
        get: op(
          "Global chain catalog (all VMs)",
          "chains:read",
          "200",
          [
            p(
              "q",
              "query",
              { type: "string", maxLength: 80 },
              "Search name, alias, chain id.",
            ),
            p("vm", "query", { type: "string" }, "VM family."),
            p(
              "capability",
              "query",
              { type: "string" },
              "Independent capability (CATALOG … NEEDS_REVIEW).",
            ),
            p(
              "status",
              "query",
              { type: "string" },
              "CURRENT (default) or ALL.",
            ),
            p("sort", "query", { type: "string" }, "tvl, name or protocols."),
            limitParam(100),
            cursorParam,
          ],
          ok(
            { type: "object" },
            "Every cataloged network with independent capabilities.",
          ),
        ),
      },
      "/v1/defi/catalog/categories": {
        get: op(
          "Catalog categories",
          "chains:read",
          "200",
          [],
          ok(
            { type: "object" },
            "Raw and product categories with coverage counts.",
          ),
        ),
      },
      "/v1/defi/catalog/coverage": {
        get: op(
          "Catalog coverage report",
          "chains:read",
          "200",
          [],
          ok(
            { type: "object" },
            "Coverage totals, TVL-weighted context share, chain capabilities.",
          ),
        ),
      },
      "/v1/address/{address}/defi": {
        get: op(
          "Supported DeFi positions (bounded progressive scan)",
          "portfolio:read",
          "200",
          [
            addressParam,
            limitParam(100),
            cursorParam,
            p(
              "chains",
              "query",
              { type: "string" },
              "Comma-separated admitted mainnet chain IDs (max 4).",
            ),
            p(
              "deployments",
              "query",
              { type: "string" },
              "Reviewed deployment IDs from continuation (max 32).",
            ),
          ],
          ok(
            ref("DefiScan"),
            "Pinned positions; economic exposure, positive owed debt, explicit coverage.",
          ),
        ),
      },
      "/v1/address/{address}/defi/coverage": {
        get: op(
          "Deployment coverage",
          "portfolio:read",
          "200",
          [addressParam],
          ok({ type: "object" }, "ZERO is checked; UNKNOWN is never zero."),
        ),
      },
      "/v1/address/{address}/defi/protocols": {
        get: op(
          "Checked protocol identities",
          "portfolio:read",
          "200",
          [addressParam],
          ok({ type: "object" }, "Protocol registry identities and coverage."),
        ),
      },
      "/v1/address/{address}/defi/{positionId}": {
        get: op(
          "Position details",
          "portfolio:read",
          "200",
          [
            addressParam,
            p(
              "positionId",
              "path",
              { type: "string" },
              "Exact position ID from this client's current explicit scan.",
            ),
          ],
          ok(ref("DefiPosition"), "Risk semantics and source evidence."),
        ),
      },
      "/v1/health": {
        get: op(
          "Service health",
          null,
          "0",
          [],
          ok({ type: "object" }, "Health"),
        ),
      },
      "/v1/openapi.json": {
        get: op(
          "This document",
          null,
          "0",
          [],
          ok({ type: "object" }, "OpenAPI"),
        ),
      },
      "/v1/chains": {
        get: op(
          "List chains with coverage tiers",
          "chains:read",
          "1",
          [cursorParam, limitParam(200)],
          ok(ref("ChainPage"), "Chains"),
        ),
      },
      "/v1/chains/{chainId}": {
        get: op(
          "Chain detail",
          "chains:read",
          "1",
          [chainParam],
          ok(ref("Chain"), "Chain"),
        ),
      },
      "/v1/chains/{chainId}/coverage": {
        get: op(
          "Index coverage window",
          "chains:read",
          "1",
          [chainParam],
          ok(ref("ChainCoverageResponse"), "Coverage"),
        ),
      },
      "/v1/address/{address}/activity": {
        get: op(
          "Indexed ERC20 transfer activity (indexed windows only)",
          "activity:read",
          "2 per page",
          [addressParam, cursorParam, limitParam(200)],
          ok(ref("ActivityPage"), "Activity"),
        ),
      },
      "/v1/{chainId}/address/{address}/native-balance": {
        get: op(
          "Native balance at an observed block",
          "balances:read",
          "1",
          [chainParam, addressParam],
          ok(ref("NativeBalance"), "Native balance"),
        ),
      },
      "/v1/{chainId}/address/{address}/token-balances": {
        get: op(
          "Token balances (balanceOf at a pinned block) for indexed and known candidates",
          "balances:read",
          "2 per page",
          [chainParam, addressParam, cursorParam, limitParam(200)],
          ok(ref("TokenBalancePage"), "Token balances"),
        ),
      },
      "/v1/{chainId}/address/{address}/balances": {
        get: op(
          "Native plus first token page",
          "balances:read",
          "3",
          [chainParam, addressParam, cursorParam, limitParam(200)],
          ok(ref("TokenBalancePage"), "Balances"),
        ),
      },
      "/v1/address/{address}/portfolio": {
        get: op(
          "Multi-chain portfolio with explicit coverage and continuation",
          "portfolio:read",
          "2 + maxChains (pre-charged)",
          [
            addressParam,
            p(
              "ecosystem",
              "query",
              { type: "string", enum: ["evm", "solana"], default: "evm" },
              "Address ecosystem; non-EVM identities are explicit.",
            ),
            p(
              "maxChains",
              "query",
              { type: "integer", minimum: 1, maximum: 2000 },
              "Upper bound on chains checked in this page (capped by plan).",
            ),
            cursorParam,
          ],
          ok(ref("Portfolio"), "Portfolio"),
        ),
      },
      "/v1/{chainId}/token/{token}": {
        get: op(
          "Token metadata (sanitized text; no remote logos)",
          "tokens:read",
          "1",
          [
            chainParam,
            p(
              "token",
              "path",
              { type: "string", maxLength: 128 },
              "Token contract or mint address.",
            ),
          ],
          ok(ref("Token"), "Token"),
        ),
      },
    },
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "ob_live_<prefix>_<secret>",
          description:
            "Server-side API key. Never embed keys in browser code. CORS is disabled.",
        },
      },
      schemas: {
        DefiPosition: z.toJSONSchema(positionSchema),
        DefiScan: z.toJSONSchema(scanSchema),
        ErrorEnvelope: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message", "requestId"],
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                requestId: { type: "string", pattern: "^req_[a-z0-9]{20,40}$" },
              },
            },
          },
        },
        Tier: {
          type: "string",
          enum: [
            "FULL_INDEXED",
            "ON_DEMAND_FUNGIBLE",
            "CURATED_BALANCE_SCAN",
            "NATIVE_ONLY",
            "CATALOG_ONLY",
          ],
        },
        IndexCoverage: {
          type: "object",
          properties: {
            chainId: { type: "string" },
            indexedFromBlock: { type: ["string", "null"] },
            indexedThroughBlock: { type: ["string", "null"] },
            headBlock: { type: ["string", "null"] },
            safeBlock: { type: ["string", "null"] },
            finalityLag: { type: ["string", "null"] },
            historicalComplete: { type: "boolean" },
            current: { type: "boolean" },
            lastError: { type: ["string", "null"] },
            observedAt: { type: ["integer", "null"] },
            liveIndexedThrough: { type: ["string", "null"] },
            historicalIndexedFrom: { type: ["string", "null"] },
            integrity: ref("IndexIntegrity"),
          },
        },
        IndexIntegrity: {
          type: "object",
          description:
            "V1.5 independent log-set witness status. FULL_INDEXED_RELEASE_ELIGIBLE additionally requires release-approved RPC terms; no chain is release-eligible while that legal review is open.",
          properties: {
            level: {
              type: "string",
              enum: [
                "FULL_INDEXED_RELEASE_ELIGIBLE",
                "FULL_INDEXED_DEVELOPMENT",
                "NOT_INDEXED",
              ],
            },
            engineeringEligible: { type: "boolean" },
            witnessVerified: { type: "boolean" },
            paused: { type: "boolean" },
            independentOperators: { type: "integer" },
            windows: { type: "integer" },
            trustedWindows: { type: "integer" },
            developmentWindows: { type: "integer" },
            unwitnessedWindows: { type: "integer" },
            blockers: { type: "array", items: { type: "string" } },
          },
        },
        Chain: {
          type: "object",
          required: ["chainId", "name", "ecosystem", "tier"],
          properties: {
            chainId: { type: "string" },
            canonicalId: { type: "string" },
            name: { type: "string" },
            ecosystem: { type: "string" },
            tier: ref("Tier"),
            configuredTier: ref("Tier"),
            routable: { type: "boolean" },
            tvlUsd: { type: ["number", "null"] },
            vettedRpcEndpoints: { type: "integer" },
            multicallVerified: { type: "boolean" },
            index: { oneOf: [ref("IndexCoverage"), { type: "null" }] },
          },
        },
        ChainPage: {
          type: "object",
          properties: {
            chains: { type: "array", items: ref("Chain") },
            nextCursor: { type: ["string", "null"] },
            total: { type: "integer" },
          },
        },
        ChainCoverageResponse: {
          type: "object",
          properties: {
            chainId: { type: "string" },
            tier: ref("Tier"),
            index: ref("IndexCoverage"),
          },
        },
        ActivityPage: {
          type: "object",
          properties: {
            address: { type: "string" },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  chainId: { type: "string" },
                  blockNumber: { type: "string" },
                  logIndex: { type: "integer" },
                  txHash: { type: "string" },
                  token: { type: "string" },
                  direction: { type: "string", enum: ["in", "out", "self"] },
                  value: { type: "string", description: "Integer base units" },
                },
              },
            },
            nextCursor: { type: ["string", "null"] },
            coverage: { type: "array", items: { type: "object" } },
          },
        },
        NativeBalance: {
          type: "object",
          properties: {
            chainId: { type: "string" },
            address: { type: "string" },
            balance: { type: "string", description: "Integer base units" },
            decimals: { type: "integer" },
            observedBlock: { type: "string" },
            observedAt: { type: "integer" },
          },
        },
        TokenBalancePage: {
          type: "object",
          properties: {
            chainId: { type: "string" },
            observedBlock: { type: "string" },
            tokens: { type: "array", items: { type: "object" } },
            failedReads: { type: "array", items: { type: "string" } },
            unchecked: { type: "array", items: { type: "string" } },
            checkedCandidates: { type: "integer" },
            totalCandidates: { type: "integer" },
            nextCursor: { type: ["string", "null"] },
            coverage: { type: "object" },
          },
        },
        CoverageState: {
          type: "string",
          enum: [
            "COMPLETE",
            "PARTIAL",
            "NATIVE_ONLY",
            "INDEXING",
            "CATALOG_ONLY",
            "FAILED",
            "PENDING",
          ],
        },
        Portfolio: {
          type: "object",
          required: [
            "state",
            "holdings",
            "coverage",
            "coverageSummary",
            "continuation",
          ],
          properties: {
            state: {
              type: "string",
              enum: ["COMPLETE", "PARTIAL", "STALE", "FAILED"],
            },
            holdings: { type: "array", items: { type: "object" } },
            coverage: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  chainId: { type: "string" },
                  state: ref("CoverageState"),
                  tier: ref("Tier"),
                  historicalComplete: { type: "boolean" },
                },
              },
            },
            coverageSummary: { type: "object" },
            continuation: {
              type: ["string", "null"],
              description: "Pass as cursor to check pending chains.",
            },
          },
        },
        Token: {
          type: "object",
          properties: {
            chainId: { type: "string" },
            address: { type: "string" },
            symbol: { type: ["string", "null"] },
            name: { type: ["string", "null"] },
            decimals: { type: ["integer", "null"] },
            metadataStatus: { type: "string" },
            suspicious: { type: "boolean" },
            price: { type: ["object", "null"] },
          },
        },
      },
    },
  };
}
