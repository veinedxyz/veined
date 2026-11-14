// Local pilot registry: static HTTPS URLs already admitted by the accepted G7 registry/provenance.
// A source becomes log-capable only after a successful chain/header/log probe for the requested history.
// Unknown marketplace backing operators (e.g. dRPC) remain excluded. The cache is never a witness.
import { BSC_LOGS_WITNESS, BSC_STATE_SOURCES } from "./policy";
import { G7RpcError, rpcHealth } from "./rpc";
import type { PinCall, PinSource } from "./common-pin";
import { validateLogs } from "./witness-logs";

export interface RpcCapabilities {
  state: boolean;
  blockByNumber: boolean;
  logs: boolean;
  historicalLogs: boolean;
  finalizedTag: boolean;
  archiveDepth: number | null;
}
export interface WitnessObservation {
  source: PinSource;
  chainId: number | null;
  capabilities: RpcCapabilities;
  healthScore: number;
  cooldownUntil: number;
  latencyMs: number | null;
  historicalFrom: number;
  lastSuccessAt: number | null;
  error: string | null;
}
export const BSC_WITNESS_CANDIDATES: readonly PinSource[] = [
  BSC_STATE_SOURCES[2],
  BSC_LOGS_WITNESS,
  BSC_STATE_SOURCES[1],
];
export async function probeWitnessPool(
  call: PinCall,
  from: number,
  address: string,
  now = Date.now,
): Promise<WitnessObservation[]> {
  return Promise.all(
    BSC_WITNESS_CANDIDATES.map(async (source) => {
      const health = rpcHealth(source.url);
      const row: WitnessObservation = {
        source,
        chainId: null,
        capabilities: {
          state: source.url !== BSC_LOGS_WITNESS.url,
          blockByNumber: false,
          logs: false,
          historicalLogs: false,
          finalizedTag: false,
          archiveDepth: null,
        },
        healthScore: 0,
        cooldownUntil: health.cooldownUntil,
        latencyMs: health.latencyMs,
        historicalFrom: from,
        lastSuccessAt: health.lastSuccessAt,
        error: null,
      };
      if (health.cooldownUntil > now())
        return { ...row, error: "RATE_LIMITED_COOLDOWN" };
      const start = now();
      try {
        const cid = await call<string>(source.url, "eth_chainId", [], 8000);
        if (!/^0x[0-9a-f]+$/i.test(cid) || BigInt(cid) !== 56n)
          throw new G7RpcError("WRONG_CHAIN_ID");
        row.chainId = 56;
        const finalized = await call<{ number: string; hash: string }>(
          source.url,
          "eth_getBlockByNumber",
          ["finalized", false],
          8000,
        );
        if (
          !finalized ||
          !/^0x[0-9a-f]{1,16}$/i.test(finalized.number) ||
          !/^0x[0-9a-f]{64}$/i.test(finalized.hash) ||
          Number(BigInt(finalized.number)) < from
        )
          throw new G7RpcError("NO_FINALIZED_HISTORY");
        const header = await call<{ number: string; hash: string }>(
          source.url,
          "eth_getBlockByNumber",
          [`0x${from.toString(16)}`, false],
          8000,
        );
        if (
          !header ||
          Number(BigInt(header.number)) !== from ||
          !/^0x[0-9a-f]{64}$/i.test(header.hash)
        )
          throw new G7RpcError("BAD_HEADER");
        const logs = await call<unknown>(
          source.url,
          "eth_getLogs",
          [
            {
              address,
              fromBlock: `0x${from.toString(16)}`,
              toBlock: `0x${from.toString(16)}`,
            },
          ],
          8000,
        );
        validateLogs(logs, { address }, from, from);
        return {
          ...row,
          capabilities: {
            ...row.capabilities,
            blockByNumber: true,
            logs: true,
            historicalLogs: true,
            finalizedTag: true,
            archiveDepth: Number(BigInt(finalized.number)) - from,
          },
          healthScore: 100,
          latencyMs: now() - start,
          lastSuccessAt: now(),
        };
      } catch (e) {
        // Availability may rotate. Invalid event evidence must remain a strict integrity stop.
        if (
          /MALFORMED_LOG_RESPONSE|LOG_FILTER_MISMATCH|DUPLICATE_LOG_RESPONSE/.test(
            String((e as Error).message),
          )
        )
          throw e;
        return {
          ...row,
          cooldownUntil: rpcHealth(source.url).cooldownUntil,
          error: String((e as Error).message).slice(0, 180),
        };
      }
    }),
  );
}
