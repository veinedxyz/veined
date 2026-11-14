import { errorMessage } from "../i18n/messages";
import type { Locale } from "../i18n/config";
import { z } from "zod";
import {
  quoteBinding,
  quoteInputSchema,
  RoutingError,
  type Catalog,
  type Network,
  type Connection,
  type RoutingQuote,
  type QuoteInput,
} from "./model";
const asset = z.object({
  chainId: z.string(),
  address: z.string().max(128),
  symbol: z.string().max(32),
  name: z.string().max(120),
  decimals: z.number().int().min(0).max(36),
});
const theme = z.object({
  logo: z
    .string()
    .regex(
      /^\/networks\/(catalog\/\d+-[0-9a-f]{16}\.(svg|png)|[a-z][a-z0-9_-]*\.svg)$/,
    ),
  primary: z.string().regex(/^#[0-9a-f]{6}$/i),
  accent: z.string().regex(/^#[0-9a-f]{6}$/i),
  glow: z
    .string()
    .regex(/^\d{1,3} \d{1,3} \d{1,3}$/)
    .refine((v) => v.split(" ").every((c) => Number(c) <= 255)),
  badgeDark: z.string().regex(/^#[0-9a-f]{6}$/i),
  badgeLight: z.string().regex(/^#[0-9a-f]{6}$/i),
  logoSurface: z.string().regex(/^(transparent|#[0-9a-f]{6})$/i),
  provenance: z.string(),
});
const network = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string().max(120),
  ecosystem: z.enum(["EVM", "SVM", "UTXO", "MVM", "TVM", "STL"]),
  mainnet: z.boolean(),
  nativeAsset: asset,
  provider: z.enum(["routing-core", "otherbridge-onebridge"]),
  theme,
});
export const catalogWire = z.object({
  networks: z.array(network).min(1).max(401),
  tools: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        kind: z.enum(["bridge", "exchange"]),
      }),
    )
    .max(2000),
  generation: z.string(),
  observedAt: z.number(),
  stale: z.boolean(),
  error: z.string().optional(),
});
export async function routingRead(
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const r = await fetch("/api/routing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.any([
      AbortSignal.timeout(22000),
      ...(signal ? [signal] : []),
    ]),
  });
  const data = await r.json();
  if (!r.ok)
    throw new RoutingError(
      typeof data.error === "string" ? data.error : "PROVIDER_UNAVAILABLE",
    );
  return data;
}
export async function readCatalog(
  signal?: AbortSignal,
  refresh = false,
): Promise<Catalog> {
  return catalogWire.parse(
    await routingRead({ action: "catalog", refresh }, signal),
  );
}
export async function readConnections(
  source: Network,
  destination: Network,
  signal: AbortSignal,
): Promise<Connection[]> {
  const p = z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        sourceAssets: z.array(asset),
        destinationAssets: z.array(asset),
        provider: z.literal("routing-core"),
        executable: z.literal(false),
      }),
    )
    .parse(
      await routingRead(
        {
          action: "connections",
          source: source.id,
          destination: destination.id,
        },
        signal,
      ),
    );
  if (p.some((c) => c.from !== source.id || c.to !== destination.id))
    throw new RoutingError("INVALID_CONNECTION");
  return p;
}
export async function readQuotes(
  input: QuoteInput,
  signal: AbortSignal,
): Promise<RoutingQuote[]> {
  const raw = await routingRead({ action: "quote", input }, signal);
  // Server normalizes all fields. Reject a malformed envelope before rendering it.
  const p = z
    .array(
      z.object({
        id: z.string(),
        provider: z.literal("routing-core"),
        binding: z.string(),
        input: quoteInputSchema,
        observedAt: z.number(),
        expiresAt: z.number(),
        steps: z.array(
          z.object({
            id: z.string(),
            tool: z.string(),
            toolName: z.string().max(120),
            catalogBound: z.boolean(),
            type: z.string(),
            sourceAsset: asset,
            destinationAsset: asset,
            amount: z.string().regex(/^\d+$/),
            expected: z.string().regex(/^\d+$/),
            minimum: z.string().regex(/^\d+$/),
            duration: z.number(),
            approvalAddress: z.string().optional(),
            destinationSignature: z.boolean(),
          }),
        ),
        fees: z.array(
          z.object({
            name: z.string(),
            amount: z.string().regex(/^\d+$/),
            usd: z.string().optional(),
            asset,
            included: z.boolean(),
            kind: z.enum(["gas", "fee"]),
          }),
        ),
        expected: z.string().regex(/^\d+$/),
        minimum: z.string().regex(/^\d+$/),
        duration: z.number(),
        priceImpact: z.number().nullable(),
        outputUsd: z
          .string()
          .regex(/^\d+(\.\d+)?$/)
          .max(100)
          .optional(),
        platformFee: z
          .object({
            bps: z.literal(0),
            amount: z.literal("0"),
            policy: z.literal("v13-disabled"),
          })
          .strict()
          .optional(),
        requirements: z.object({
          approvals: z.number(),
          signatures: z.number().nullable(),
          chainSwitches: z.number().nullable(),
          destinationSignature: z.boolean(),
          balance: z.literal("UNVERIFIED"),
          allowance: z.literal("UNVERIFIED"),
          reason: z.literal("WRITE_DISABLED"),
        }),
        executable: z.literal(false),
        warnings: z.array(z.string()),
      }),
    )
    .max(20)
    .parse(raw);
  if (
    p.some(
      (q) =>
        q.binding !== quoteBinding(input) ||
        quoteBinding(q.input) !== q.binding ||
        q.expiresAt - q.observedAt > 30000 ||
        q.expiresAt <= q.observedAt,
    )
  )
    throw new RoutingError("QUOTE_BINDING_MISMATCH");
  return p;
}
export function routingMessage(code: string, lang: Locale) {
  return errorMessage(lang, code, true);
}
