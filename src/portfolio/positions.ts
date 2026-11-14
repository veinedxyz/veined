import { z } from "zod";
import snapshot from "./positions.generated.json" with { type: "json" };
import { isAssetLogoSrc } from "../assets/logo-path";

export const positionCategorySchema = z.enum([
  "lending",
  "borrowing",
  "staking",
  "vault",
  "lp",
  "restaking",
  "rewards",
]);
export type PositionCategory = z.infer<typeof positionCategorySchema>;
export const positionSchema = z
  .object({
    protocol: z.enum(["Aave V3", "Lido", "Sky Savings"]),
    category: positionCategorySchema,
    role: z.enum(["asset", "debt"]),
    source: z.string().url().max(300),
  })
  .strict();
export type Position = z.infer<typeof positionSchema>;
const contractSchema = positionSchema.extend({
  chainId: z.string().regex(/^\d{1,18}$/),
  address: z.string().regex(/^0x[0-9a-f]{40}$/),
  symbol: z.string().min(1).max(32),
  decimals: z.number().int().min(0).max(36),
  logo: z.string().refine(isAssetLogoSrc).optional(),
});
export const positionContracts = z
  .array(contractSchema)
  .max(100)
  .parse(snapshot.positions);
const byContract = new Map(
  positionContracts.map((p) => [`${p.chainId}:${p.address}`, p]),
);
export const positionFor = (chainId: string, address: string) =>
  byContract.get(`${chainId}:${address.toLowerCase()}`);
export const positionsForChain = (chainId: string) =>
  positionContracts.filter((p) => p.chainId === chainId);
export const defiCoverageSchema = z
  .object({
    chainId: z.string().regex(/^\d{1,18}$/),
    protocol: z.enum(["Aave V3", "Lido", "Sky Savings"]),
    category: positionCategorySchema,
    state: z.enum(["CHECKED", "PARTIAL", "FAILED", "PENDING", "NOT_CHECKED"]),
    checked: z.number().int().min(0).max(100),
    planned: z.number().int().min(1).max(100),
    observedAt: z.number().nonnegative(),
    observedBlock: z.string().regex(/^\d+$/).nullable(),
  })
  .strict()
  .refine(
    (c) =>
      c.checked <= c.planned &&
      (c.state !== "CHECKED" || c.checked === c.planned),
  );
export type DefiCoverage = z.infer<typeof defiCoverageSchema>;

/** A successful zero balance is checked; missing or failed reads never imply no position. */
export function receiptCoverage(
  chainId: string,
  reads: { token: string; balance: bigint | null }[],
  observedAt: number,
  observedBlock: string,
): DefiCoverage[] {
  const balances = new Map(
    reads.map((r) => [r.token.toLowerCase(), r.balance]),
  );
  const groups = new Map<string, typeof positionContracts>();
  for (const p of positionsForChain(chainId)) {
    const key = `${p.protocol}:${p.category}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return [...groups.values()].map((group) => {
    const checked = group.filter(
      (p) => balances.has(p.address) && balances.get(p.address) !== null,
    ).length;
    const failed = group.some(
      (p) => balances.has(p.address) && balances.get(p.address) === null,
    );
    return {
      chainId,
      protocol: group[0].protocol,
      category: group[0].category,
      state:
        checked === group.length
          ? "CHECKED"
          : checked > 0
            ? "PARTIAL"
            : failed
              ? "FAILED"
              : "NOT_CHECKED",
      checked,
      planned: group.length,
      observedAt,
      observedBlock: checked > 0 ? observedBlock : null,
    };
  });
}
