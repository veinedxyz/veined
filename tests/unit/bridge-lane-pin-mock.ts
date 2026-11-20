// VEINED-MC1 (BRIDGE LANE): TEST-ONLY. The bridge pin module with ONLY its code hashes replaced by keccak256 of the
// fake chains' bytes (./bridge-lane-fake.ts fakeBridgeCode), for every chain; every address, slot, selector, topic,
// oracle and pin-set id stays the real pin. Used inside vi.mock factories (a real runtime-code preimage cannot be
// produced). Not a test file itself. Imports nothing from src at run time (type-only imports).
import { keccak256, type Hex } from "viem";
import type * as BridgePinModule from "../../src/swap/lane/bridge-pins";
import type { BridgeChainPins } from "../../src/swap/lane/bridge-pins";

export const fakeBridgeCodeOf = (address: string) =>
  ("0x60806040ba" + address.slice(2).toLowerCase()) as Hex;
export function fakeBridgePinModule(
  real: typeof BridgePinModule,
): typeof BridgePinModule {
  const h = (a: string) => keccak256(fakeBridgeCodeOf(a));
  const table: Readonly<Record<string, Readonly<BridgeChainPins>>> =
    Object.freeze(
      Object.fromEntries(
        Object.entries(real.BRIDGE_LANE_CHAIN_PINS).map(([id, P]) => [
          id,
          Object.freeze({
            ...P,
            diamond: Object.freeze({
              ...P.diamond,
              codehash: h(P.diamond.address),
            }),
            facet: Object.freeze({ ...P.facet, codehash: h(P.facet.address) }),
            feeCollector: Object.freeze({
              ...P.feeCollector,
              codehash: h(P.feeCollector.address),
            }),
            spokePool: Object.freeze({
              ...P.spokePool,
              codehash: h(P.spokePool.address),
              implementation: Object.freeze({
                ...P.spokePool.implementation,
                codehash: h(P.spokePool.implementation.address),
              }),
            }),
            usdc: Object.freeze({
              ...P.usdc,
              codehash: h(P.usdc.address),
              implementation: Object.freeze({
                ...P.usdc.implementation,
                codehash: h(P.usdc.implementation.address),
              }),
            }),
          }),
        ]),
      ),
    );
  return {
    ...real,
    BRIDGE_LANE_CHAIN_PINS: table,
    bridgePinsOf: (id: unknown) =>
      typeof id === "string" && Object.prototype.hasOwnProperty.call(table, id)
        ? table[id]
        : null,
  };
}
