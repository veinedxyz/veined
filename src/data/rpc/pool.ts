import {
  freshHealth,
  recordFailure,
  recordSuccess,
  score,
  type EndpointHealth,
} from "./health";
import type { CallPolicy, RpcCall } from "./methods";
import {
  RpcError,
  rpcBatch,
  rpcCall,
  type BatchItem,
  type RpcEndpoint,
  type RpcTransport,
  type TransportOptions,
} from "./transport";
export interface ApprovedEndpoint extends RpcEndpoint {
  priority: number;
  supportsLogs: boolean;
  maxLogRange: number;
  supportsBatch: boolean;
  supportsFinalized: boolean;
  supportsSafe: boolean;
  archive: boolean;
  // V1.5 provenance annotations (rpc-provenance.ts); absent means UNKNOWN, never independent.
  operatorGroup?: string | null;
  witnessEligible?: boolean;
  reviewStatus?: string;
}
// Capability errors are not endpoint faults; policy errors are caller faults and never retried.
// V1.14.1: CAPACITY_EXCEEDED (gas / size budget of one request) is returned to the caller, which splits it.
const notEndpointFault = new Set([
  "POLICY_REJECTED",
  "RANGE_TOO_LARGE",
  "CAPACITY_EXCEEDED",
]);
// V1.14.1: a contract revert is the same on every honest endpoint at the same block. It is returned to the caller
// at once (no failover) and recorded as a healthy response, so an expected revert (e.g. a receipt probe on a plain
// token) can never quarantine the endpoint every other adapter on that chain is pinned to.
const contractResult = new Set(["EXECUTION_REVERTED"]);
export class RpcPool {
  constructor(
    readonly chainId: string,
    readonly policy: CallPolicy,
    private endpoints: ApprovedEndpoint[],
    private transport: RpcTransport,
    private health: Map<string, EndpointHealth> = new Map(),
    private now: () => number = Date.now,
  ) {}
  private state(id: string) {
    return this.health.get(id) ?? freshHealth();
  }
  bestHead(): bigint | null {
    let best: bigint | null = null;
    for (const e of this.endpoints) {
      const b = this.state(e.id).latestBlock;
      if (b !== null && (best === null || b > best)) best = b;
    }
    return best;
  }
  ranked(filter: (e: ApprovedEndpoint) => boolean = () => true) {
    const now = this.now(),
      head = this.bestHead();
    return this.endpoints
      .filter(filter)
      .map((e) => ({ e, s: score(this.state(e.id), now, head) }))
      .filter((x) => x.s > 0)
      .sort(
        (a, b) =>
          b.s - a.s ||
          a.e.priority - b.e.priority ||
          a.e.id.localeCompare(b.e.id),
      )
      .map((x) => x.e);
  }
  available(filter?: (e: ApprovedEndpoint) => boolean) {
    return this.ranked(filter).length;
  }
  healthSnapshot() {
    return new Map(this.health);
  }
  markSuccess(id: string, latency: number, block?: bigint) {
    this.health.set(
      id,
      recordSuccess(this.state(id), latency, this.now(), block),
    );
  }
  markFailure(id: string, code: string) {
    this.health.set(id, recordFailure(this.state(id), code, this.now()));
  }
  // Bounded failover across ranked healthy endpoints (default three attempts).
  async call(
    call: RpcCall,
    options: TransportOptions & {
      attempts?: number;
      filter?: (e: ApprovedEndpoint) => boolean;
      policy?: CallPolicy;
    } = {},
  ): Promise<{ value: unknown; endpoint: ApprovedEndpoint }> {
    const candidates = this.ranked(options.filter).slice(
      0,
      options.attempts ?? 3,
    );
    if (!candidates.length)
      throw new RpcError("HTTP_ERROR", "NO_HEALTHY_ENDPOINT");
    let last: unknown;
    for (const endpoint of candidates) {
      if (options.signal?.aborted) throw new RpcError("TIMEOUT");
      const started = this.now();
      try {
        const value = await rpcCall(
          this.transport,
          endpoint,
          call,
          options.policy ?? this.policy,
          options,
        );
        this.markSuccess(endpoint.id, Math.max(0, this.now() - started));
        return { value, endpoint };
      } catch (error) {
        last = error;
        const code =
          error instanceof RpcError ? error.code : "INVALID_RESPONSE";
        if (contractResult.has(code)) {
          this.markSuccess(endpoint.id, Math.max(0, this.now() - started));
          throw error;
        }
        // An oversized log page is a range capability limit (caller shrinks/bisects), not a fault.
        if (
          notEndpointFault.has(code) ||
          (code === "RESPONSE_TOO_LARGE" &&
            (call.method === "eth_getLogs" || call.method === "eth_call"))
        )
          throw error;
        this.markFailure(endpoint.id, code);
      }
    }
    throw last instanceof RpcError ? last : new RpcError("INVALID_RESPONSE");
  }
  async batch(
    calls: RpcCall[],
    options: TransportOptions & {
      attempts?: number;
      policy?: CallPolicy;
      filter?: (e: ApprovedEndpoint) => boolean;
    } = {},
  ): Promise<{ items: BatchItem[]; endpoint: ApprovedEndpoint }> {
    const candidates = this.ranked(
      (e) => e.supportsBatch && (!options.filter || options.filter(e)),
    ).slice(0, options.attempts ?? 2);
    let last: unknown = new RpcError("HTTP_ERROR", "NO_BATCH_ENDPOINT");
    for (const endpoint of candidates) {
      if (options.signal?.aborted) throw new RpcError("TIMEOUT");
      const started = this.now();
      try {
        const items = await rpcBatch(
          this.transport,
          endpoint,
          calls,
          options.policy ?? this.policy,
          options,
        );
        this.markSuccess(endpoint.id, Math.max(0, this.now() - started));
        return { items, endpoint };
      } catch (error) {
        last = error;
        const code =
          error instanceof RpcError ? error.code : "INVALID_RESPONSE";
        if (code === "POLICY_REJECTED") throw error;
        this.markFailure(endpoint.id, code);
      }
    }
    throw last;
  }
}
