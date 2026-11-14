import type { ProtocolDeployment } from "./model";
// V1.14 reverse contract index: exact chain + contract -> protocol + product + version + role. Built only from reviewed
// deployments (and, at runtime, from canonical factory/registry events). Never from symbols or names.
export const CONTRACT_ROLES = [
  "market",
  "pool",
  "vault",
  "factory",
  "staking",
  "position-manager",
  "rewards",
  "comptroller",
  "strategy",
  "router",
  "oracle",
  "receipt-token",
  "debt-token",
  "gauge",
  "registry",
  "withdrawal-queue",
] as const;
export type ContractRole = (typeof CONTRACT_ROLES)[number];
export interface ContractIndexEntry {
  chainId: string;
  contract: string;
  deploymentId: string;
  protocolId: string;
  product: string;
  version: string | null;
  role: ContractRole;
  source: string;
}
// Contract key -> role per adapter family. A key that is not listed here is never indexed (fail closed).
export const CONTRACT_KEY_ROLES: Record<
  string,
  Record<string, ContractRole[]>
> = {
  "aave-v3": {
    pool: ["market"],
    provider: ["registry"],
    addressesProvider: ["registry"],
    incentives: ["rewards"],
  },
  "compound-iii": { comet: ["market", "receipt-token"], rewards: ["rewards"] },
  "morpho-blue": {
    blue: ["market"],
    irm: ["strategy"],
    oracleFactory: ["registry"],
  },
  "morpho-vault": { factory: ["factory"] },
  erc4626: { vault: ["vault", "receipt-token"] },
  lido: {
    steth: ["staking", "receipt-token"],
    wsteth: ["receipt-token"],
    withdrawalQueue: ["withdrawal-queue"],
  },
  "uniswap-v2": { factory: ["factory"] },
  "uniswap-v3": {
    factory: ["factory"],
    manager: ["position-manager"],
    deployer: ["registry"],
  },
  // V1.14 families.
  "lst-rate": { token: ["receipt-token", "staking"] },
  eigenlayer: {
    strategyManager: ["staking"],
    delegationManager: ["registry"],
    eigenPodManager: ["staking"],
  },
  curve: { metaRegistry: ["registry"], addressProvider: ["registry"] },
  "balancer-v2": { vault: ["registry"], weightedPoolFactory: ["factory"] },
  "solidly-v2": { poolFactory: ["factory"], voter: ["registry"] },
};
const versionOf = (d: ProtocolDeployment) =>
  /\bV(\d+(?:\.\d+)?)\b/i.exec(d.name)?.[0]?.toUpperCase() ?? null;
export function buildReverseIndex(
  deployments: readonly ProtocolDeployment[],
): ContractIndexEntry[] {
  const out: ContractIndexEntry[] = [];
  for (const d of deployments) {
    const roles = CONTRACT_KEY_ROLES[d.adapter] ?? {};
    for (const [key, contract] of Object.entries(d.contracts))
      for (const role of roles[key] ?? [])
        out.push({
          chainId: d.chainId,
          contract,
          deploymentId: d.id,
          protocolId: d.protocolId,
          product: d.name,
          version: versionOf(d),
          role,
          source: d.source,
        });
    for (const st of d.strategies ?? [])
      out.push({
        chainId: d.chainId,
        contract: st.strategy,
        deploymentId: d.id,
        protocolId: d.protocolId,
        product: d.name,
        version: versionOf(d),
        role: "strategy",
        source: d.source,
      });
    for (const a of d.assets ?? []) {
      out.push({
        chainId: d.chainId,
        contract: a.receipt,
        deploymentId: d.id,
        protocolId: d.protocolId,
        product: d.name,
        version: versionOf(d),
        role: "receipt-token",
        source: d.source,
      });
      out.push({
        chainId: d.chainId,
        contract: a.debt,
        deploymentId: d.id,
        protocolId: d.protocolId,
        product: d.name,
        version: versionOf(d),
        role: "debt-token",
        source: d.source,
      });
    }
  }
  return out;
}
export class ReverseIndex {
  private byKey = new Map<string, ContractIndexEntry[]>();
  constructor(entries: readonly ContractIndexEntry[]) {
    for (const e of entries) {
      const k = e.chainId + ":" + e.contract;
      this.byKey.set(k, [...(this.byKey.get(k) ?? []), e]);
    }
  }
  get size() {
    return this.byKey.size;
  }
  lookup(chainId: string, contract: string): ContractIndexEntry[] {
    if (!/^\d{1,20}$/.test(chainId) || !/^0x[0-9a-f]{40}$/.test(contract))
      return [];
    return this.byKey.get(chainId + ":" + contract) ?? [];
  }
  /** Held asset ids (chainId:contract) that are exact receipt/debt/vault/pool representations of a reviewed deployment. */
  receiptHits(
    held: readonly string[],
    roles: readonly ContractRole[] = [
      "receipt-token",
      "debt-token",
      "vault",
      "pool",
      "gauge",
      "staking",
    ],
  ) {
    const hits = new Map<string, ContractIndexEntry[]>();
    for (const id of held) {
      const [chainId, contract] = id.split(":");
      for (const e of this.lookup(
        chainId ?? "",
        (contract ?? "").toLowerCase(),
      ))
        if (roles.includes(e.role))
          hits.set(e.deploymentId, [...(hits.get(e.deploymentId) ?? []), e]);
    }
    return hits;
  }
}
