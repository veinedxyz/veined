import { z } from "zod";
import { catalogWire } from "../routing/client";
import { chainCapabilitySchema, type ActiveCatalog } from "./model";
const schema = z.object({
  chains: z
    .array(
      z.object({
        id: z.string().regex(/^(chain:\d{1,18}|catalog:[a-z0-9-]+)$/),
        name: z
          .string()
          .max(120)
          .regex(/^[\p{L}\p{N} ._()-]+$/u),
        chainId: z.string().nullable(),
        network: catalogWire.shape.networks.element.optional(),
        capability: chainCapabilitySchema,
      }),
    )
    .max(5000),
  observedAt: z.number(),
  stale: z.boolean(),
  hash: z.string().max(100),
  rejected: z.number(),
  livePositive: z.number(),
});
export async function readActiveCatalog(
  signal?: AbortSignal,
  refresh = false,
): Promise<ActiveCatalog> {
  const r = await fetch("/api/catalog", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh }),
    signal: AbortSignal.any([
      AbortSignal.timeout(22000),
      ...(signal ? [signal] : []),
    ]),
  });
  if (!r.ok) throw Error("CATALOG_UNAVAILABLE");
  return schema.parse(await r.json());
}
