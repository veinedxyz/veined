// Typed client for the Otherbridge Data API (/v1). Server-side only: never embed API keys in
// browser code. Zero dependencies; uses the platform fetch. Read-only GET requests.
export type Tier =
  "FULL_INDEXED" | "ON_DEMAND_FUNGIBLE" | "NATIVE_ONLY" | "CATALOG_ONLY";
export type CoverageState =
  | "COMPLETE"
  | "PARTIAL"
  | "NATIVE_ONLY"
  | "INDEXING"
  | "CATALOG_ONLY"
  | "FAILED"
  | "PENDING";
export interface IndexCoverage {
  chainId: string;
  indexedFromBlock: string | null;
  indexedThroughBlock: string | null;
  headBlock: string | null;
  safeBlock: string | null;
  finalityLag: string | null;
  historicalComplete: boolean;
  current: boolean;
  lastError: string | null;
  observedAt: number | null;
  // V1.5 (optional for forward compatibility with V1.4 servers).
  liveIndexedThrough?: string | null;
  historicalIndexedFrom?: string | null;
  integrity?: {
    level:
      | "FULL_INDEXED_RELEASE_ELIGIBLE"
      | "FULL_INDEXED_DEVELOPMENT"
      | "NOT_INDEXED";
    engineeringEligible: boolean;
    witnessVerified: boolean;
    paused: boolean;
    independentOperators: number;
    windows: number;
    trustedWindows: number;
    developmentWindows: number;
    unwitnessedWindows: number;
    blockers: string[];
  };
}
export interface Chain {
  chainId: string;
  canonicalId: string;
  name: string;
  ecosystem: string;
  tier: Tier;
  configuredTier: Tier;
  routable: boolean;
  tvlUsd: number | null;
  native: { symbol: string; decimals: number };
  vettedRpcEndpoints: number;
  multicallVerified: boolean;
  index: IndexCoverage | null;
}
export interface Page<T> {
  nextCursor: string | null;
  items: T[];
}
export interface ActivityItem {
  chainId: string;
  blockNumber: string;
  logIndex: number;
  txHash: string;
  token: string;
  direction: "in" | "out" | "self";
  value: string;
}
export interface NativeBalance {
  chainId: string;
  address: string;
  balance: string;
  decimals: number;
  nonce?: string | null;
  observedBlock: string;
  observedAt: number;
}
export interface TokenBalancePage {
  chainId: string;
  address: string;
  observedBlock: string;
  observedAt: number;
  native?: { balance: string; decimals: number };
  tokens: {
    token: string;
    balance: string;
    decimals: number | null;
    symbol: string | null;
    discovery: "indexed" | "known-token";
  }[];
  failedReads: string[];
  unchecked: string[];
  checkedCandidates: number;
  totalCandidates: number;
  nextCursor: string | null;
  coverage: {
    tier: Tier;
    tokens: string;
    historicalComplete: boolean;
    indexedFromBlock: string | null;
    indexedThroughBlock: string | null;
  };
}
export interface ChainCoverage {
  chainId: string;
  state: CoverageState;
  tier: Tier;
  native: "CHECKED" | "FAILED" | "UNSUPPORTED" | "PENDING";
  tokens: string;
  historicalComplete: boolean;
  indexedFromBlock: string | null;
  indexedThroughBlock: string | null;
  headBlock: string | null;
  observedBlock: string | null;
  reason: string;
  observedAt: number;
}
export interface Portfolio {
  state: "COMPLETE" | "PARTIAL" | "STALE" | "FAILED";
  holdings: {
    chainId: string;
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    balance: string;
    native: boolean;
    spam: boolean;
    suspicious: boolean;
    usd: number | null;
    discovery?: string;
    observedBlock?: string | null;
  }[];
  coverage: ChainCoverage[];
  coverageSummary: {
    planned: number;
    checked: number;
    indexed: number;
    pending: number;
    failed: number;
    nativeOnly: number;
    catalogOnly: number;
    unsupported: number;
    coverageComplete: boolean;
    historicalComplete: boolean;
  };
  continuation: string | null;
  observedAt: number;
  revision: string;
}
export interface Token {
  chainId: string;
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  metadataStatus: string;
  suspicious: boolean;
  spam: boolean;
  sources: string[];
  price: {
    priceUsd: string | null;
    observedAt: number | null;
    confidence: string;
    method: string;
  } | null;
}
export class DataApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly requestId: string | null,
  ) {
    super(`${code} (${status})`);
    this.name = "DataApiError";
  }
}
export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}
const segment = (v: string) => {
  if (!/^[A-Za-z0-9]{1,128}$/.test(v))
    throw new DataApiError("INVALID_ARGUMENT", 0, null);
  return v;
};
export class OtherbridgeDataClient {
  private readonly base: URL;
  constructor(private readonly options: ClientOptions) {
    this.base = new URL(options.baseUrl);
    // API keys never travel over cleartext except to the local loopback service.
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(
      this.base.hostname,
    );
    if (
      !(
        this.base.protocol === "https:" ||
        (this.base.protocol === "http:" && loopback)
      ) ||
      this.base.username ||
      this.base.password
    )
      throw new DataApiError("INVALID_BASE_URL", 0, null);
    if (!/^ob_(live|test)_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/.test(options.apiKey))
      throw new DataApiError("INVALID_API_KEY_FORMAT", 0, null);
  }
  private async get<T>(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<T> {
    const url = new URL(path, this.base);
    for (const [k, v] of Object.entries(query))
      if (v !== undefined) url.searchParams.set(k, String(v));
    const response = await (this.options.fetch ?? fetch)(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30000),
    });
    const body = (await response.json().catch(() => null)) as
      | { data: T; requestId: string }
      | { error: { code: string; requestId: string } }
      | null;
    if (!response.ok || !body || "error" in body)
      throw new DataApiError(
        body && "error" in body ? body.error.code : "INVALID_RESPONSE",
        response.status,
        body && "error" in body ? body.error.requestId : null,
      );
    return body.data;
  }
  health() {
    return this.get<{ status: string; version: string; billingEnabled: false }>(
      "/v1/health",
    );
  }
  async chains(cursor?: string, limit?: number): Promise<Page<Chain>> {
    const r = await this.get<{ chains: Chain[]; nextCursor: string | null }>(
      "/v1/chains",
      { cursor, limit },
    );
    return { items: r.chains, nextCursor: r.nextCursor };
  }
  chain(chainId: string) {
    return this.get<Chain>(`/v1/chains/${segment(chainId)}`);
  }
  coverage(chainId: string) {
    return this.get<{ chainId: string; tier: Tier; index: IndexCoverage }>(
      `/v1/chains/${segment(chainId)}/coverage`,
    );
  }
  async activity(
    address: string,
    cursor?: string,
    limit?: number,
  ): Promise<Page<ActivityItem>> {
    const r = await this.get<{
      items: ActivityItem[];
      nextCursor: string | null;
    }>(`/v1/address/${segment(address)}/activity`, { cursor, limit });
    return { items: r.items, nextCursor: r.nextCursor };
  }
  nativeBalance(chainId: string, address: string) {
    return this.get<NativeBalance>(
      `/v1/${segment(chainId)}/address/${segment(address)}/native-balance`,
    );
  }
  tokenBalances(
    chainId: string,
    address: string,
    cursor?: string,
    limit?: number,
  ) {
    return this.get<TokenBalancePage>(
      `/v1/${segment(chainId)}/address/${segment(address)}/token-balances`,
      { cursor, limit },
    );
  }
  balances(chainId: string, address: string) {
    return this.get<TokenBalancePage>(
      `/v1/${segment(chainId)}/address/${segment(address)}/balances`,
    );
  }
  portfolio(
    address: string,
    options: {
      ecosystem?: "evm" | "solana";
      maxChains?: number;
      cursor?: string;
    } = {},
  ) {
    return this.get<Portfolio>(
      `/v1/address/${segment(address)}/portfolio`,
      options,
    );
  }
  // Follows continuation cursors until every planned chain is checked or the page budget ends.
  async portfolioAll(
    address: string,
    options: {
      ecosystem?: "evm" | "solana";
      maxChains?: number;
      maxPages?: number;
    } = {},
  ) {
    const pages: Portfolio[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.portfolio(address, { ...options, cursor });
      pages.push(page);
      cursor = page.continuation ?? undefined;
    } while (cursor && pages.length < (options.maxPages ?? 5));
    return pages;
  }
  token(chainId: string, token: string) {
    return this.get<Token>(`/v1/${segment(chainId)}/token/${segment(token)}`);
  }
}
