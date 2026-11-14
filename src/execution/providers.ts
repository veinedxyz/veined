// G13: provider and contract identity for owner-signed plans. Server-side (it reads the protected swap deployment pins,
// unchanged). Every entry is REVIEW_REQUIRED for execution: knowing a contract is not permission to use it — the
// firewall's contractRegistry (protected, empty) and killPolicy (global kill ON) stay the authority; activating an
// entry needs the owner's exact approval (PROTECTED_CHANGE_PROPOSAL_TR.md).
import pins from "../swap/server/deployment-pins.generated.json" with { type: "json" };

export type ContractRole = "router" | "spender";
export interface ProviderContract {
  chainId: string;
  /** Provider family: "lifi" (routing-core routes), "uniswap", "pancakeswap", "aerodrome", "wrapper". */
  family: string;
  roles: readonly ContractRole[];
  address: string;
  /** The proxy/diamond can change behaviour without changing this address. */
  upgradeable: boolean;
  codehash: string | null;
  provenance: string;
  executionStatus: "REVIEW_REQUIRED";
}
const LIFI_DIAMOND = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";
const LIFI_PROVENANCE =
  "Observed as estimate.approvalAddress AND transactionRequest.to of a live read-only LI.FI quote (Base, 2026-11-11T19:58Z, G13 evidence g13-lifi-probe); runtime code present on 1, 8453, 42161 (eth_getCode). Upgradeable diamond: facets can change — the code of the facet for the called selector must be pinned before activation.";
const PIN_ROLES: Readonly<
  Record<string, { family: string; roles: ContractRole[] }>
> = {
  uniswap: { family: "uniswap", roles: ["router"] },
  Uniswap: { family: "uniswap", roles: ["spender"] },
  pancake: { family: "pancakeswap", roles: ["router"] },
  PancakeSwap: { family: "pancakeswap", roles: ["spender"] },
  router: { family: "aerodrome", roles: ["router", "spender"] },
  wrapper: { family: "wrapper", roles: ["router"] },
};
export const PROVIDER_CONTRACTS: readonly ProviderContract[] = Object.freeze([
  ...["1", "8453", "42161"].map((chainId) => ({
    chainId,
    family: "lifi",
    roles: ["router", "spender"] as const,
    address: LIFI_DIAMOND,
    upgradeable: true,
    codehash: null,
    provenance: LIFI_PROVENANCE,
    executionStatus: "REVIEW_REQUIRED" as const,
  })),
  ...(
    pins as {
      chain: string;
      role: string;
      address: string;
      codehash: string;
      source: string;
    }[]
  )
    .filter((p) => PIN_ROLES[p.role])
    .map((p) => ({
      chainId: p.chain,
      family: PIN_ROLES[p.role].family,
      roles: PIN_ROLES[p.role].roles,
      address: p.address.toLowerCase(),
      upgradeable: false,
      codehash: p.codehash,
      provenance: `src/swap/server/deployment-pins.generated.json (${p.role}): ${p.source}`,
      executionStatus: "REVIEW_REQUIRED" as const,
    })),
]);
/** Route source of a plan → the provider family whose contracts it may use. */
export function familyOf(provider: string): string | null {
  if (provider === "routing-core") return "lifi";
  if (provider === "near-intents") return "near-intents";
  return ["uniswap", "pancakeswap", "aerodrome"].includes(provider)
    ? provider
    : null;
}
export function identify(
  chainId: string,
  address: string,
  role: ContractRole,
  family: string | null,
): ProviderContract | null {
  if (!family || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  return (
    PROVIDER_CONTRACTS.find(
      (c) =>
        c.chainId === chainId &&
        c.address === address.toLowerCase() &&
        c.family === family &&
        c.roles.includes(role),
    ) ?? null
  );
}
/**
 * Whether a contract's behaviour is pinned (review F13): a known code hash and not an upgradeable proxy / diamond. An
 * upgradeable contract needs the code of the implementation (facet) for the called selector pinned first.
 */
export function behaviourPinned(c: ProviderContract): boolean {
  return !c.upgradeable && !!c.codehash && /^0x[0-9a-f]{64}$/i.test(c.codehash);
}
