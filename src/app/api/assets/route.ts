import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { boundedBody } from "../../../server/body";
import { apiGuard, guardStatus, rateGuard } from "../../../server/api-guard";
import { RoutingError } from "../../../routing/model";
import { routingCore } from "../../../adapters/routing-core";
import {
  dexDiscoveredView,
  listAssets,
  previewImport,
  searchAssets,
  trustWalletFolder,
} from "../../../assets/registry";
import {
  DEXSCREENER_CHAINS,
  dexEvidence,
} from "../../../assets/sources/dexscreener";
import { getDataPlane } from "../../../data/plane";
import { readMetadata } from "../../../data/balances/evm";
import { currentMode } from "../../../server/config";
import { previewSolanaMint } from "../../../assets/solana-import";
import {
  SOLANA_CHAIN_ID,
  isSolanaMint,
  isEvmAddress,
} from "../../../assets/model";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// V1.11 unified asset registry API (read-only). No wallet data is accepted or stored: requests carry a chain id and
// a query or an exact token address only. Upstream lookups (RPC, DEXScreener, logos) are server-side, bounded,
// rate-limited and cached; images reach the browser only as sanitized same-origin bytes.
const chain = z.string().regex(/^\d{1,18}$/);
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), chain }).strict(),
  z
    .object({
      action: z.literal("search"),
      chain,
      query: z.string().max(80),
    })
    .strict(),
  z
    .object({
      action: z.literal("preview"),
      chain,
      address: z.string().max(64),
    })
    .strict(),
]);
async function routeAssets(chainId: string, signal: AbortSignal) {
  // Local test mode is hermetic: registry data only, no upstream route list.
  if (currentMode() === "local-test") return null;
  try {
    return await routingCore.getAssets(chainId, signal);
  } catch {
    return null; // route support unknown => never shown as routable
  }
}
async function pool(chainId: string) {
  const plane = await getDataPlane();
  const state = await plane.state();
  const c = state.chains.find((x) => x.chainId === chainId && x.mainnet);
  const p = c && c.ecosystem === "EVM" ? plane.pool(state, chainId) : null;
  if (!c || !p) throw new RoutingError("NO_VETTED_RPC");
  return { pool: p, multicall: c.multicall };
}
export async function POST(req: NextRequest) {
  const headers = { "Cache-Control": "no-store" };
  try {
    await apiGuard(req, "assets", 90);
    const input = schema.parse(JSON.parse(await boundedBody(req)));
    if (input.action === "list")
      return NextResponse.json(
        {
          assets: listAssets(
            input.chain,
            await routeAssets(input.chain, req.signal),
          ),
        },
        { headers },
      );
    if (input.action === "search") {
      const route = await routeAssets(input.chain, req.signal);
      const found = searchAssets(input.chain, input.query, route);
      // Exact route-supported address with no registry/market identity: one bounded, cached DEXScreener lookup
      // (exact chain + token) may add a DEX_DISCOVERED result. Never in local-test mode (route is null there).
      const address = input.query.trim().toLowerCase();
      const routed = route?.find((r) => r.address.toLowerCase() === address);
      if (found.lookup && routed && DEXSCREENER_CHAINS[input.chain]) {
        const dex = await dexEvidence(input.chain, address).catch(() => null);
        if (dex)
          return NextResponse.json(
            {
              results: [dexDiscoveredView(input.chain, routed, dex, route!)],
              lookup: true,
            },
            { headers },
          );
      }
      return NextResponse.json(found, { headers });
    }
    await rateGuard(req, "assets-preview", 12);
    if (
      !(input.chain === SOLANA_CHAIN_ID
        ? isSolanaMint(input.address)
        : isEvmAddress(input.address))
    )
      throw new RoutingError("INVALID_REQUEST");
    if (currentMode() === "local-test")
      throw new RoutingError("LOCAL_TEST_MODE_NO_LOOKUP");
    if (input.chain === SOLANA_CHAIN_ID)
      return NextResponse.json(
        await previewSolanaMint(
          input.address,
          AbortSignal.any([req.signal, AbortSignal.timeout(6000)]),
        ),
        { headers },
      );
    const result = await previewImport(
      input.chain,
      input.address,
      await routeAssets(input.chain, req.signal),
      {
        code: async (c, a) => {
          const { pool: p } = await pool(c);
          const r = await p.call(
            { method: "eth_getCode", params: [a, "latest"] },
            { signal: req.signal, timeoutMs: 6000, maxBytes: 200_000 },
          );
          return String(r.value);
        },
        metadata: async (c, a) => {
          const { pool: p, multicall } = await pool(c);
          const [m] = await readMetadata(p, [a], multicall, req.signal);
          if (!m) throw new RoutingError("TOKEN_READ_FAILED");
          return {
            decimals: m.decimals,
            symbol: m.symbol ?? "",
            name: m.name ?? "",
          };
        },
        twFolder: trustWalletFolder,
      },
    );
    return NextResponse.json(result, { headers });
  } catch (e) {
    const error =
      e instanceof RoutingError
        ? e.code
        : e instanceof z.ZodError || e instanceof SyntaxError
          ? "INVALID_REQUEST"
          : "PROVIDER_UNAVAILABLE";
    return NextResponse.json(
      { error },
      { status: guardStatus(error), headers },
    );
  }
}
