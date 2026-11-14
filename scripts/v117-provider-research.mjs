// Public-source capture and Base pin verification only. Never loads environment files or credentials.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256 } from "viem";

const root = readFileSync(".otherbridge/v117-evidence-path.txt", "utf8").trim();
const output = join(root, "provider-sources");
mkdirSync(output, { recursive: true });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const urls = {
  "uniswap-faq":
    "https://developers.uniswap.org/docs/trading/swapping-api/faqs",
  "uniswap-supported-chains":
    "https://developers.uniswap.org/docs/api-reference/get_supported_chains",
  "uniswap-openapi": "https://trade-api.gateway.uniswap.org/v1/api.json",
  "uniswap-dashboard-guide":
    "https://developers.uniswap.org/docs/get-started/developer-dashboard",
  "uniswap-supported-chains-md":
    "https://developers.uniswap.org/docs/api-reference/get_supported_chains.md",
  "uniswap-dashboard-current":
    "https://developers.uniswap.org/docs/get-started/dashboard.md",
  "jupiter-setup": "https://developers.jup.ag/docs/portal/setup.md",
  "jupiter-organisations":
    "https://developers.jup.ag/docs/portal/organisations.md",
  "jupiter-api-keys": "https://developers.jup.ag/docs/portal/api-keys.md",
  "jupiter-firewall": "https://developers.jup.ag/docs/portal/firewall.md",
  "jupiter-rate-limits": "https://developers.jup.ag/docs/portal/rate-limits.md",
  "jupiter-plans": "https://developers.jup.ag/docs/portal/plans.md",
  "jupiter-analytics": "https://developers.jup.ag/docs/portal/analytics.md",
  "jupiter-logs": "https://developers.jup.ag/docs/portal/logs.md",
  "titan-home": "https://titan-exchange.gitbook.io/titan/developer-doc/home.md",
  "titan-connection":
    "https://titan-exchange.gitbook.io/titan/developer-doc/swap-api/reference/direct/connection.md",
  "titan-authentication":
    "https://titan-exchange.gitbook.io/titan/developer-doc/getting-started/authentication.md",
  "titan-api-access":
    "https://titan-exchange.gitbook.io/titan/developer-doc/getting-started/api-access.md",
  "titan-sdk":
    "https://titan-exchange.gitbook.io/titan/developer-doc/resources/sdk.md",
  "titan-stream":
    "https://titan-exchange.gitbook.io/titan/developer-doc/swap-api/reference/direct/new-swap-quote-stream.md",
  "titan-get-info":
    "https://titan-exchange.gitbook.io/titan/developer-doc/swap-api/reference/direct/get-info.md",
  "titan-sdk-head":
    "https://api.github.com/repos/Titan-Pathfinder/titan-sdk-ts/commits/main",
  "aerodrome-head":
    "https://api.github.com/repos/aerodrome-finance/contracts/commits/main",
  "slipstream-head":
    "https://api.github.com/repos/aerodrome-finance/slipstream/commits/main",
  "titan-pricing": "https://developer.titan.exchange/",
  "pcsx-overview":
    "https://developer.pancakeswap.finance/contracts/pcsx/overview",
  "pcsx-swap-integration":
    "https://developer.pancakeswap.finance/contracts/pcsx/swap-integration",
  "privy-dashboard-overview":
    "https://docs.privy.io/basics/get-started/dashboard/overview.md",
  "privy-new-app":
    "https://docs.privy.io/basics/get-started/dashboard/create-new-app.md",
  "privy-app-clients":
    "https://docs.privy.io/basics/get-started/dashboard/app-clients.md",
  "privy-login-methods":
    "https://docs.privy.io/basics/get-started/dashboard/configure-login-methods.md",
  "privy-wallet-creation":
    "https://docs.privy.io/basics/react/advanced/automatic-wallet-creation.md",
  "privy-allowed-domains":
    "https://docs.privy.io/recipes/dashboard/allowed-domains.md",
  "privy-csp":
    "https://docs.privy.io/security/implementation-guide/content-security-policy.md",
  "privy-signers":
    "https://docs.privy.io/wallets/using-wallets/signers/configure-signers.md",
  "privy-external-wallets":
    "https://docs.privy.io/wallets/connectors/ethereum.md",
  "privy-index": "https://docs.privy.io/llms.txt",
  "aerodrome-source":
    "https://raw.githubusercontent.com/aerodrome-finance/contracts/1ba30815bba620f7e9faa34769ffd00c214c9b82/README.md",
  "slipstream-source":
    "https://raw.githubusercontent.com/aerodrome-finance/slipstream/f8717faaae6e6717db3c8e3850149c01a79c0603/README.md",
};
const receipts = [];
for (let offset = 0; offset < Object.entries(urls).length; offset += 4) {
  await Promise.all(
    Object.entries(urls)
      .slice(offset, offset + 4)
      .map(async ([id, url]) => {
        const at = new Date().toISOString();
        try {
          const response = await fetch(url, {
            signal: AbortSignal.timeout(18000),
            headers: {
              Accept: "text/markdown, text/plain, application/json, text/html",
            },
          });
          const bytes = Buffer.from(await response.arrayBuffer());
          const pageMissing =
            /# (?:Page Not Found|Not found)|404: Not Found/.test(
              bytes.toString("utf8").slice(0, 3000),
            );
          writeFileSync(join(output, `${id}.txt`), bytes);
          receipts.push({
            id,
            requestedUrl: url,
            finalUrl: response.url,
            retrievedAt: at,
            httpStatus: response.status,
            status:
              response.ok && !pageMissing ? "RETRIEVED" : "RETRIEVAL_FAILED",
            sha256: sha(bytes),
            bytes: bytes.length,
            evidence: `${id}.txt`,
          });
        } catch {
          receipts.push({
            id,
            requestedUrl: url,
            retrievedAt: at,
            status: "UNAVAILABLE",
            error: "PUBLIC_SOURCE_FETCH_FAILED",
          });
        }
      }),
  );
}
writeFileSync(
  join(output, "receipts.json"),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      sources: receipts.sort((a, b) => a.id.localeCompare(b.id)),
      dashboardAccesses: 0,
      secretsLoaded: false,
    },
    null,
    2,
  ) + "\n",
);

const aeroDir = join(root, "Aerodrome");
mkdirSync(aeroDir, { recursive: true });
const file = "src/swap/server/deployment-pins.generated.json";
const bytes = readFileSync(file);
const pins = JSON.parse(bytes).filter(
  (p) =>
    p.chain === "8453" &&
    [
      "router",
      "factory",
      "registry",
      "slipstream",
      "clFactory",
      "quoter",
    ].includes(p.role),
);
const rpcUrl = "https://base-rpc.publicnode.com";
let requests = 0;
async function rpc(method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requests, method, params }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw Error("RPC_UNAVAILABLE");
  const json = await response.json();
  if (json.error) throw Error("RPC_UNAVAILABLE");
  return json.result;
}
const results = [];
try {
  if (BigInt(await rpc("eth_chainId", [])) !== 8453n)
    throw Error("CHAIN_MISMATCH");
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  for (const pin of pins) {
    try {
      const code = await rpc("eth_getCode", [pin.address, block.number]);
      const observedSlots = [];
      for (const slot of [
        "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
        "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
      ])
        observedSlots.push(
          await rpc("eth_getStorageAt", [pin.address, slot, block.number]),
        );
      const codehash = keccak256(code);
      results.push({
        role: pin.role,
        address: pin.address,
        block: block.number,
        blockHash: block.hash,
        codeExists: code !== "0x",
        expectedCodehash: pin.codehash,
        observedCodehash: codehash,
        expectedProxySlots: pin.proxySlots,
        observedProxySlots: observedSlots,
        status:
          code !== "0x" &&
          codehash === pin.codehash &&
          JSON.stringify(pin.proxySlots) === JSON.stringify(observedSlots)
            ? "PIN_MATCH"
            : "REVIEW_REQUIRED",
        autoActivated: false,
      });
    } catch {
      results.push({
        role: pin.role,
        address: pin.address,
        status: "UNAVAILABLE",
      });
    }
  }
} catch {
  results.push({
    status: "UNAVAILABLE",
    reason: "BASE_READ_ONLY_RPC_UNAVAILABLE",
  });
}
writeFileSync(
  join(aeroDir, "pins.json"),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      rpcUrl,
      chainId: 8453,
      pinFile: file,
      pinFileSha256: sha(bytes),
      pinFileUnchanged: sha(readFileSync(file)) === sha(bytes),
      requests,
      writes: 0,
      results,
      execution: "CLOSED",
      noProviderCredentialRequired: true,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    sources: receipts.length,
    retrieved: receipts.filter((r) => r.status === "RETRIEVED").length,
    pins: results.length,
    matched: results.filter((r) => r.status === "PIN_MATCH").length,
    execution: "CLOSED",
  }),
);

// Evidence summaries contain only public facts, code references and exact external actions.
const sourceRefs = (prefix) =>
  receipts
    .filter((receipt) => receipt.id.startsWith(prefix))
    .map(({ id, requestedUrl, retrievedAt, httpStatus, status, sha256 }) => ({
      id,
      url: requestedUrl,
      retrievedAt,
      httpStatus,
      status,
      sha256,
    }));
const writeTopic = (topic, value) => {
  mkdirSync(join(root, topic), { recursive: true });
  writeFileSync(
    join(root, topic, "onboarding.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        topic,
        at: new Date().toISOString(),
        sources: sourceRefs(topic.toLowerCase()),
        execution: "CLOSED",
        financialActions: 0,
        ...value,
      },
      null,
      2,
    ) + "\n",
  );
};
const action = (
  id,
  category,
  website,
  secret,
  configure,
  validate,
  blocks,
  evidenceExpected,
) => ({
  id,
  category,
  status: "OWNER_INPUT_REQUIRED",
  exactOwnerVendorAction: configure,
  website,
  secret,
  howToConfigure: configure,
  howToValidate: validate,
  whatItBlocks: blocks,
  evidenceExpected,
});
const actions = [
  action(
    "OWNER_INPUT_UNISWAP_API_KEY",
    "PROVIDER_ONBOARDING",
    "https://developers.uniswap.org/dashboard",
    true,
    "Owner creates dedicated Otherbridge Production API key; separate staging; stores server-only UNISWAP_API_KEY; confirms assigned quota (documented default 6 RPS/key), one process and no browser/log exposure.",
    "pnpm release:credentials:check --out=<run>/Uniswap/credentials.json; authenticated GET /v1/supported_chains plus reviewed representative quote must PASS; offline UNISWAP/UNISWAPX kill check must make zero requests.",
    "Uniswap production authenticated quotes and provider gate closure",
    "Key name, production namespace, assigned quota, redacted read-only PASS and kill-check receipt; no key value",
  ),
  action(
    "OWNER_INPUT_JUPITER_API_KEY",
    "PROVIDER_ONBOARDING",
    "https://developers.jup.ag/portal",
    true,
    "Owner-controlled organisation; team Otherbridge Production with separate staging team; dedicated Swap-only key stored as JUPITER_API_KEY server-side. Deny /swap/v2/execute, /tx/v1/submit and unexpected POST for this key; set 1 RPS key firewall rule; review egress IP, organisation shared quota and analytics/logs; no broad Bypass.",
    "pnpm release:credentials:check --out=<run>/Jupiter/credentials.json; reviewed GET /order and /build read-only quotes; owner permission/firewall/log review; offline Jupiter kill check. No signed execute/submit.",
    "Jupiter production authenticated read-only quotes and verified account restrictions",
    "Org/team/key name, Swap-only permissions, rule inventory, plan and static egress observations, redacted read-only/kill receipt and analytics review time; no key value",
  ),
  action(
    "OWNER_INPUT_TITAN_WS_ENDPOINT",
    "PROVIDER_ONBOARDING",
    "https://titan-exchange.gitbook.io/titan/developer-doc/getting-started/api-access",
    false,
    "Owner obtains enterprise Titan Direct entitlement from Titan/Triton/QuickNode and vendor confirmation that exact accepted wss://api.titan.exchange/api/v1/ws supports uncompressed v1.api.titan.ag, MessagePack and current reviewed request/transaction bounds. Set TITAN_WS_ENDPOINT to that exact URL without auth/query. Obtain numeric account connection/stream/start/update quotas and renewal/reconnect policy. If vendor offers only another endpoint, retain TITAN kill and attach incompatibility statement; do not change pins/allowlist.",
    "Vendor compatibility/limits reference plus pnpm release:credentials:check read-only quote; deterministic reconnect/cancel/frame/redaction tests and offline TITAN kill. General REST plan quota is not WebSocket proof.",
    "Titan production quote streams",
    "Enterprise entitlement/reference, approved exact endpoint, protocol and numeric per-account limits; no dashboard login or token in evidence",
  ),
  action(
    "OWNER_INPUT_TITAN_AUTH_TOKEN",
    "PROVIDER_ONBOARDING",
    "https://developer.titan.exchange/",
    true,
    "Owner obtains a distributor/Titan issued JWT valid for the accepted Direct endpoint, audience api.titan.ag and compatible unbound or synthetic-test-public-key policy; stores server-only TITAN_AUTH_TOKEN with expiry/renewal/rotation procedure. Portal REST x-api-key is not interchangeable. Never mint/sign a token during this task.",
    "pnpm release:credentials:check --out=<run>/Titan/credentials.json and safe runtime deterministic tests; no raw SDK logs, token/query URL or signed financial request.",
    "Titan authenticated production read-only streams",
    "Redacted read-only receipt, issuer/renewal reference and vendor key-binding statement; no JWT value",
  ),
  action(
    "OWNER_INPUT_PCSX_TRAFFIC_QUOTA",
    "HOSTING_DECISION",
    "https://developer.pancakeswap.finance/contracts/pcsx/overview",
    false,
    "Hosting owner records one app process, expected concurrent quote users and static outbound IP/NAT tenancy; confirms aggregate other PCSX traffic plus Otherbridge <=15 RPS steady and within documented short-burst 30, with headroom. Otherbridge itself is capped at 5/rolling second. Request optional PCSX integrator key only if aggregate anonymous envelope cannot be met.",
    "Compare host/NAT process inventory and per-egress capacity policy with PCSX/quota-decision.json and production processCount=1; pnpm release:credentials:check. Credentials are not proof of commercial terms.",
    "Production hosting/provider quota admission, not a missing PCSX credential",
    "Host process count, egress tenancy/traffic budget and chosen user-demand envelope; conditional vendor quota reference only if larger capacity is actually needed",
  ),
  action(
    "OWNER_INPUT_PRIVY_PRODUCTION",
    "OWNER_INPUT",
    "https://dashboard.privy.io/apps?page=settings&tab=basics",
    false,
    "Owner selects dedicated production app, sets public NEXT_PUBLIC_PRIVY_APP_ID and exact https://otherbridge.io allowed origin; reviews app-client overrides; external Ethereum wallet connect-only; all email/social/SMS/passkey and embedded creation OFF; no delegated/session/server execution signers; exact existing CSP retained. No real wallet prompt or App Secret export.",
    "Owner redacted dashboard inventory and review receipt; pnpm release:credentials:check --offline; verify:safety, g7:safety, g7:pilot:safety and existing CSP/browser evidence. CLI cannot prove hidden dashboard settings.",
    "Privy production app/origin/policy verification and external gate closure",
    "Public app reference, reviewer/time, exact origin list and client inventory, login/embedded/signer settings and CSP review; no secret/session/wallet interaction",
  ),
];
writeFileSync(
  join(output, "owner-actions.json"),
  JSON.stringify(
    { schemaVersion: 1, at: new Date().toISOString(), actions },
    null,
    2,
  ) + "\n",
);
writeTopic("Uniswap", {
  status: "OWNER_INPUT_REQUIRED",
  ownerActions: [actions[0]],
  dashboard: "https://developers.uniswap.org/dashboard",
  env: "UNISWAP_API_KEY",
  header: "x-api-key",
  documentedQuotaRps: 6,
  applicationQuotaRps: 5,
  supportedChainsEndpoint:
    "https://trade-api.gateway.uniswap.org/v1/supported_chains",
  credentialStatusAuthority: "V1.17 credential validator receipt",
  dashboardRead: false,
});
writeTopic("Jupiter", {
  status: "OWNER_INPUT_REQUIRED",
  ownerActions: [actions[1]],
  dashboard: "https://developers.jup.ag/portal",
  organisation: "OWNER_CONTROL_REQUIRED",
  productionTeam: "Otherbridge Production",
  stagingTeam: "SEPARATE",
  productPermissions: ["Swap"],
  env: "JUPITER_API_KEY",
  header: "x-api-key",
  plansRps: { Free: 1, Developer: 10, Launch: 50, Pro: 150 },
  planQuotaScope: "ORGANISATION_60_SECOND_SLIDING_WINDOW",
  applicationQuotaRps: 1,
  forbiddenPaths: ["/swap/v2/execute", "/tx/v1/submit"],
  dashboardRead: false,
});
let sdkObserved;
try {
  sdkObserved = JSON.parse(
    readFileSync(join(output, "titan-sdk-head.txt"), "utf8"),
  ).sha;
} catch {
  sdkObserved = null;
}
writeTopic("Titan", {
  status: "OWNER_INPUT_REQUIRED",
  ownerActions: [actions[2], actions[3]],
  dashboard: "https://developer.titan.exchange/",
  entitlement: "ENTERPRISE_DISTRIBUTOR_TITAN_DIRECT",
  acceptedEndpoint: "wss://api.titan.exchange/api/v1/ws",
  endpointEnv: "TITAN_WS_ENDPOINT",
  tokenEnv: "TITAN_AUTH_TOKEN",
  auth: "VENDOR_ISSUED_JWT_AUTH_QUERY_ADDED_ONLY_INSIDE_SAFE_TRANSPORT",
  portalApiKeyIsCompatible: false,
  wire: "v1.api.titan.ag_UNCOMPRESSED_MESSAGEPACK",
  sdkOracle: {
    version: "0.1.6",
    scope: "DEV_ONLY",
    acceptedRevision: "7588482454bee284a7437d0bd5fce6c02edfb60f",
    observedRevision: sdkObserved,
    autoActivated: false,
  },
  runtimeBounds: {
    frameBytes: 262144,
    transactionBytes: 1232,
    quotesPerEvent: 3,
    requestedIntervalMs: 1000,
    maxFramesPerAttempt: 4,
    maxAttempts: 2,
    providerConcurrency: 2,
  },
  accountRateLimits: "OWNER_VENDOR_NUMERIC_CONFIRMATION_REQUIRED",
  dashboardRead: false,
});

const performanceFile =
  "evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/performance/swap-performance.json";
const performance = JSON.parse(readFileSync(performanceFile, "utf8"));
const intervals = performance.scopes.productionUi.samples
  .filter((sample) => sample.refresh)
  .map((sample) => sample.refresh.intervalRequestStartMs);
const interval = intervals[0];
const dataLoadFile =
  "evidence/otherbridge-v1-5/v15-20261004T131452Z-64ebac/performance/data-api-load.json";
const dataLoad = JSON.parse(readFileSync(dataLoadFile, "utf8")).runs.internal;
const quotaDecision = {
  schemaVersion: 1,
  at: new Date().toISOString(),
  classification: "ANONYMOUS_QUOTA_SUFFICIENT_FOR_LAUNCH",
  sources: sourceRefs("pcsx"),
  observedPerformance: {
    path: performanceFile,
    sha256: sha(readFileSync(performanceFile)),
    classification: performance.scopes.productionUi.classification,
    productionUiSamples: performance.scopes.productionUi.n,
    automaticRefreshSamples: intervals.length,
    refreshIntervalMs: interval,
    refreshRequestsPerUserRps: 1000 / interval,
    livePcsxLoadMeasured: false,
  },
  launchScenario: {
    concurrentRefreshingUsers: 20,
    status: "PLANNING_SCENARIO_NOT_MEASURED_PRODUCTION_DEMAND",
    steadyRps: (20 * 1000) / interval,
    simultaneousInitialRequestsBeforeRuntimeAdmission: 20,
    expectedActualConcurrentUsers: "OWNER_CONFIRMATION_REQUIRED",
  },
  runtimeAdmission: {
    code: "src/swap/server/egress.ts",
    sha256: sha(readFileSync("src/swap/server/egress.ts")),
    limit: 5,
    windowMs: 1000,
    window: "ROLLING",
    scope: "ONE_NODE_PROCESS_ORIGIN",
    checkBeforeFetch: true,
    maxProviderConcurrency: 2,
    queue: false,
    processCount: 1,
    processCountSchema: "src/release/config.ts",
    maxSteadyRps: 5,
    maxRollingSecondBurst: 5,
    coalescing: "IDENTICAL_INTENT_ONLY_NOT_ASSUMED_FOR_CAPACITY",
  },
  providerQuota: {
    anonymousSteadyRpsPerIp: 15,
    anonymousShortBurst: 30,
    integratorRps: 10000,
    keyHeader: "X-API-Key",
    keyProvidesEndpointPrivileges: false,
  },
  sharedEgress: {
    formula: "5 Otherbridge RPS + all other egress tenants RPS",
    otherTenantsSteadyCapacityBeforeHeadroomRps: 10,
    otherTenantsBurstCapacityBeforeHeadroom: 25,
    knownOtherTenantTraffic: "OWNER_INPUT_REQUIRED",
    acceptance:
      "ONE_PROCESS_AND_AGGREGATE_EGRESS_WITHIN_ANONYMOUS_QUOTA_WITH_HEADROOM",
    ownerActionId: actions[4].id,
  },
  unrelatedCapacityEvidence: {
    path: dataLoadFile,
    sha256: sha(readFileSync(dataLoadFile)),
    service: "DATA_API_NOT_PCSX",
    requests: dataLoad.requests,
    concurrency: dataLoad.concurrency,
    wallMs: dataLoad.wallMs,
    observedRps: (dataLoad.requests * 1000) / dataLoad.wallMs,
    pcsxDemandInferenceAllowed: false,
  },
  credential: {
    requiredForLaunchEnvelope: false,
    conditionalEnv: "PCSX_INTEGRATOR_KEY",
    escalation:
      "REQUEST_ONLY_IF_AGGREGATE_IP_QUOTA_OR_ACCOUNT_PLAN_REQUIRES_MORE_CAPACITY",
  },
  quoteCompatibilityIndependent: true,
  execution: "CLOSED",
  financialActions: 0,
};
mkdirSync(join(root, "PCSX"), { recursive: true });
writeFileSync(
  join(root, "PCSX", "quota-decision.json"),
  JSON.stringify(quotaDecision, null, 2) + "\n",
);
writeTopic("PCSX", {
  status: quotaDecision.classification,
  sources: sourceRefs("pcsx"),
  ownerActions: [actions[4]],
  quotaDecision: "PCSX/quota-decision.json",
  requiredProviderCredential: false,
  optionalKeyEnv: "PCSX_INTEGRATOR_KEY",
  optInEnv: "PCSX_QUOTE_ENABLED",
  kill: "PANCAKESWAP_X_INTENT",
});
writeTopic("Aerodrome", {
  sources: [...sourceRefs("aerodrome"), ...sourceRefs("slipstream")],
  status:
    results.length === 6 &&
    results.every((result) => result.status === "PIN_MATCH")
      ? "PRODUCTION_CONFIG_READY"
      : "READ_ONLY_PIN_VERIFICATION_INCOMPLETE",
  credentialStatus: "NO_PROVIDER_CREDENTIAL_REQUIRED",
  sourceRevisions: {
    classic: "1ba30815bba620f7e9faa34769ffd00c214c9b82",
    slipstream: "f8717faaae6e6717db3c8e3850149c01a79c0603",
  },
  codeVerification: "Aerodrome/pins.json",
  kills: ["AERODROME_CLASSIC", "AERODROME_SLIPSTREAM"],
  rpc: {
    url: rpcUrl,
    chainId: 8453,
    requiredMethods: [
      "eth_chainId",
      "eth_getBlockByNumber",
      "eth_getCode",
      "eth_getStorageAt",
      "eth_call",
    ],
    termsApproval: "SEPARATE_RPC_EXTERNAL_GATE",
  },
  ownerActions: [],
});
writeTopic("Privy", {
  status: "OWNER_DASHBOARD_VERIFICATION_REQUIRED",
  ownerActions: [actions[5]],
  publicEnv: "NEXT_PUBLIC_PRIVY_APP_ID",
  appIdObserved: false,
  productionOrigin: "https://otherbridge.io",
  actualDashboardSettings: "NOT_READ_UNKNOWN",
  requiredPolicy: {
    externalWalletConnectOnly: true,
    embeddedEthereum: false,
    embeddedSolana: false,
    email: false,
    social: false,
    delegatedSigners: false,
    sessionSigners: false,
    serverControlledExecution: false,
  },
  genericFullFeatureCspCopied: false,
  walletRequests: 0,
  dashboardRead: false,
});
