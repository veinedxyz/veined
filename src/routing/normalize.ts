import { z } from "zod";
import { neutralToolName, neutralFeeName } from "../content/public-labels";
import { assetSchema, requirePair } from "./catalog";
import { ecosystemReason } from "./addresses";
import {
  quoteInputSchema,
  quoteBinding,
  RoutingError,
  type Asset,
  type Catalog,
  type Connection,
  type QuoteInput,
  type RoutingQuote,
  type RouteStatus,
  type StatusInput,
} from "./model";
const amount = z.string().regex(/^\d{1,78}$/);
const decimal = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .max(100);
const action = z.object({
  fromChainId: z.union([z.string(), z.number()]).transform(String),
  toChainId: z.union([z.string(), z.number()]).transform(String),
  fromToken: assetSchema,
  toToken: assetSchema,
  fromAmount: amount,
  fromAddress: z.string().max(128).optional(),
  toAddress: z.string().max(128).optional(),
  slippage: z.number().min(0).max(1).optional(),
});
const cost = z.object({
  name: z.string().max(120).optional(),
  type: z.string().max(40).optional(),
  amount,
  amountUSD: decimal.optional(),
  token: assetSchema,
  included: z.boolean().optional(),
  feeSplit: z
    .object({ integratorFee: amount.optional() })
    .passthrough()
    .optional(),
});
const estimate = z.object({
  fromAmount: amount,
  toAmount: amount,
  toAmountMin: amount,
  executionDuration: z.number().min(0).max(604800),
  approvalAddress: z.string().max(128).optional(),
  skipApproval: z.boolean().optional(),
  feeCosts: z.array(cost).max(100).optional(),
  gasCosts: z.array(cost).max(100).optional(),
  fromAmountUSD: decimal.optional(),
  toAmountUSD: decimal.optional(),
});
const step = z.object({
  id: z.string().min(1).max(200),
  type: z.string().min(1).max(40),
  tool: z.string().min(1).max(120),
  toolDetails: z
    .object({ key: z.string().max(120), name: z.string().max(120) })
    .optional(),
  action,
  estimate: estimate.optional(),
  executionType: z.enum(["transaction", "message"]).optional(),
});
const quoteSchema = step.extend({
  estimate,
  includedSteps: z.array(step).max(30).optional(),
  destinationAction: z.unknown().optional(),
});
const same = (a: string, b: string, evm: boolean) =>
  evm ? a.toLowerCase() === b.toLowerCase() : a === b;
export function validateQuoteInput(raw: unknown, catalog: Catalog): QuoteInput {
  const input = quoteInputSchema.parse(raw),
    { from, to } = requirePair(
      catalog,
      input.source,
      input.destination,
      input.mode,
    );
  if (
    input.mode === "swap" &&
    input.sourceAsset.toLowerCase() === input.destinationAsset.toLowerCase()
  )
    throw new RoutingError("SAME_TOKEN_DISABLED");
  if (input.generation !== catalog.generation)
    throw new RoutingError("CATALOG_CHANGED");
  for (const [network, address] of [
    [from, input.sourceAddress],
    [to, input.destinationAddress],
  ] as const) {
    const reason = ecosystemReason(network, address);
    if (reason) throw new RoutingError(reason);
  }
  return input;
}
export function normalizeQuote(
  raw: unknown,
  input: QuoteInput,
  catalog: Catalog,
  now = Date.now(),
): RoutingQuote {
  validateQuoteInput(input, catalog);
  const q = quoteSchema.parse(raw),
    { from, to } = requirePair(
      catalog,
      input.source,
      input.destination,
      input.mode,
    ),
    a = q.action,
    e = q.estimate;
  if (
    a.fromChainId !== input.source ||
    a.toChainId !== input.destination ||
    a.fromToken.chainId !== input.source ||
    a.toToken.chainId !== input.destination ||
    !same(a.fromToken.address, input.sourceAsset, from.ecosystem === "EVM") ||
    !same(a.toToken.address, input.destinationAsset, to.ecosystem === "EVM") ||
    a.fromAmount !== input.amount ||
    e.fromAmount !== input.amount ||
    !a.fromAddress ||
    !same(a.fromAddress, input.sourceAddress, from.ecosystem === "EVM") ||
    !a.toAddress ||
    !same(a.toAddress, input.destinationAddress, to.ecosystem === "EVM") ||
    a.slippage !== input.slippage ||
    BigInt(e.toAmountMin) > BigInt(e.toAmount) ||
    BigInt(e.toAmount) === 0n
  )
    throw new RoutingError("QUOTE_BINDING_MISMATCH");
  // Otherbridge fee is disabled: any upstream integrator share above zero invalidates the quote.
  const integratorFees = [q, ...(q.includedSteps ?? [])].flatMap(
    (x) => x.estimate?.feeCosts ?? [],
  );
  if (
    integratorFees.some(
      (c) =>
        c.feeSplit?.integratorFee !== undefined &&
        BigInt(c.feeSplit.integratorFee) > 0n,
    )
  )
    throw new RoutingError("PLATFORM_FEE_NONZERO");
  const children = q.includedSteps?.length ? q.includedSteps : [q];
  const steps = children.map((s) => {
    if (
      (!catalog.tools.some((t) => t.id === s.tool) &&
        !(
          s.type === "protocol" &&
          s.tool === "feeCollection" &&
          s.toolDetails?.key === "feeCollection"
        )) ||
      !catalog.networks.some((n) => n.id === s.action.fromChainId) ||
      !catalog.networks.some((n) => n.id === s.action.toChainId)
    )
      throw new RoutingError("TOOL_OR_NETWORK_DISAPPEARED");
    return {
      id: s.id,
      tool: s.tool,
      toolName: neutralToolName(
        catalog.tools.find((t) => t.id === s.tool)?.name ??
          s.toolDetails?.name ??
          s.tool,
      ),
      catalogBound: catalog.tools.some((t) => t.id === s.tool),
      type:
        s.type === "lifi" || s.type === "cross"
          ? "bridge"
          : s.type === "swap"
            ? "exchange"
            : s.type,
      sourceAsset: s.action.fromToken,
      destinationAsset: s.action.toToken,
      amount: s.action.fromAmount,
      expected: s.estimate?.toAmount ?? "0",
      minimum: s.estimate?.toAmountMin ?? "0",
      duration: s.estimate?.executionDuration ?? 0,
      approvalAddress: s.estimate?.skipApproval
        ? undefined
        : s.estimate?.approvalAddress,
      destinationSignature: s.action.fromChainId !== input.source,
    };
  });
  // Top-level costs already aggregate included steps. Never double count them.
  const fees = [
    ...(e.feeCosts ?? []).map((c) => ({
      name: neutralFeeName(c.name ?? "Fee"),
      amount: c.amount,
      usd: c.amountUSD,
      asset: c.token,
      included: c.included ?? false,
      kind: "fee" as const,
    })),
    ...(e.gasCosts ?? []).map((c) => ({
      name: neutralFeeName(c.type ?? "Gas", "gas"),
      amount: c.amount,
      usd: c.amountUSD,
      asset: c.token,
      included: false,
      kind: "gas" as const,
    })),
  ];
  const approvals = steps.filter(
    (s) => s.approvalAddress && !/^0x0{40}$/i.test(s.sourceAsset.address),
  ).length;
  const destinationSignature =
    !!q.destinationAction || steps.some((s) => s.destinationSignature);
  const priceImpact =
    e.fromAmountUSD && e.toAmountUSD && Number(e.fromAmountUSD) > 0
      ? Math.max(
          0,
          (Number(e.fromAmountUSD) - Number(e.toAmountUSD)) /
            Number(e.fromAmountUSD),
        )
      : null;
  return {
    id: q.id,
    provider: "routing-core",
    binding: quoteBinding(input),
    input,
    observedAt: now,
    expiresAt: now + 30000,
    steps,
    fees,
    expected: e.toAmount,
    minimum: e.toAmountMin,
    duration: e.executionDuration,
    priceImpact,
    outputUsd: e.toAmountUSD,
    platformFee: { bps: 0, amount: "0", policy: "v13-disabled" },
    requirements: {
      approvals,
      signatures: null,
      chainSwitches: null,
      destinationSignature,
      balance: "UNVERIFIED",
      allowance: "UNVERIFIED",
      reason: "WRITE_DISABLED",
    },
    executable: false,
    warnings: [
      "WRITE_DISABLED",
      "BALANCE_AND_ALLOWANCE_UNVERIFIED",
      "SIGNATURE_COUNT_UNVERIFIED",
      ...(destinationSignature ? ["DESTINATION_SIGNATURE_REQUIRED"] : []),
      ...(priceImpact !== null && priceImpact > 0.03
        ? ["HIGH_PRICE_IMPACT"]
        : []),
    ],
  };
}
export function normalizeConnections(
  raw: unknown,
  source: string,
  destination: string,
  metadata?: { source: Asset[]; destination: Asset[] },
): Connection[] {
  const token = z
    .object({
      chainId: z.union([z.string(), z.number()]).transform(String),
      address: z.string().min(1).max(128),
    })
    .passthrough();
  const parsed = z
    .object({
      connections: z
        .array(
          z.object({
            fromChainId: z.union([z.string(), z.number()]).transform(String),
            toChainId: z.union([z.string(), z.number()]).transform(String),
            fromTokens: z.array(token).max(15000),
            toTokens: z.array(token).max(15000),
          }),
        )
        .max(1000),
    })
    .parse(raw);
  if (
    parsed.connections.some(
      (c) =>
        c.fromChainId !== source ||
        c.toChainId !== destination ||
        c.fromTokens.some((t) => t.chainId !== source) ||
        c.toTokens.some((t) => t.chainId !== destination),
    )
  )
    throw new RoutingError("INVALID_CONNECTION");
  const hydrate = (list: z.infer<typeof token>[], tokens: Asset[]) =>
    list.flatMap((t) => {
      const complete = assetSchema.safeParse(t);
      if (complete.success) return [complete.data];
      const matched = tokens.find(
        (a) => a.chainId === t.chainId && a.address === t.address,
      );
      return matched ? [matched] : [];
    });
  return parsed.connections.map((c) => ({
    from: source,
    to: destination,
    sourceAssets: hydrate(c.fromTokens, metadata?.source ?? []),
    destinationAssets: hydrate(c.toTokens, metadata?.destination ?? []),
    provider: "routing-core",
    executable: false,
  }));
}
export function normalizeStatus(
  raw: unknown,
  input: StatusInput,
  now = Date.now(),
): RouteStatus {
  const info = z.object({
    txHash: z.string().min(1).max(200).optional(),
    chainId: z.union([z.string(), z.number()]).transform(String),
    amount: amount.optional(),
    token: assetSchema.optional(),
  });
  const s = z
    .object({
      status: z.enum(["NOT_FOUND", "INVALID", "PENDING", "DONE", "FAILED"]),
      substatus: z.string().max(100).optional(),
      sending: info.optional(),
      receiving: info.optional(),
      fromAddress: z.string().max(128).optional(),
      toAddress: z.string().max(128).optional(),
    })
    .parse(raw);
  const eq = (a: string | undefined, b: string) =>
    !!a &&
    (/^(0x)?[0-9a-f]{40,64}$/i.test(b)
      ? a.toLowerCase() === b.toLowerCase()
      : a === b);
  const ctx = input.context;
  const bound =
    !!ctx &&
    ctx.source === input.source &&
    ctx.destination === input.destination &&
    s.sending?.chainId === input.source &&
    eq(s.sending.txHash, input.hash) &&
    s.sending.amount === ctx.amount &&
    s.sending.token?.chainId === input.source &&
    eq(s.sending.token.address, ctx.sourceAsset) &&
    eq(s.fromAddress, ctx.sourceAddress) &&
    eq(s.toAddress, ctx.destinationAddress);
  const received =
    !!ctx && s.receiving?.chainId === input.destination && !!s.receiving.txHash;
  const payout =
    received &&
    s.receiving?.token?.chainId === input.destination &&
    eq(s.receiving.token.address, ctx!.destinationAsset) &&
    !!s.receiving.amount &&
    BigInt(s.receiving.amount) > 0n &&
    BigInt(s.receiving.amount) >= BigInt(ctx!.minimum);
  let status: RouteStatus["status"] = "UNKNOWN";
  if (bound) {
    if (s.status === "DONE" && s.substatus === "COMPLETED" && payout)
      status = "COMPLETED";
    else if (s.status === "DONE" && s.substatus === "PARTIAL" && received)
      status = "PARTIAL";
    else if (
      s.status === "DONE" &&
      s.substatus === "REFUNDED" &&
      s.receiving?.chainId === input.source &&
      !!s.receiving.txHash &&
      eq(s.receiving.token?.address, ctx!.sourceAsset)
    )
      status = "REFUNDED";
    else if (s.status === "PENDING") status = "PENDING";
    else if (s.status === "FAILED") status = "FAILED";
  }
  return {
    status,
    observedAt: now,
    provider: "routing-core",
    authoritative: status !== "UNKNOWN",
    sourceHash: s.sending?.txHash,
    destinationHash: received ? s.receiving?.txHash : undefined,
  };
}
