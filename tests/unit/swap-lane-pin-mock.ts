// VEINED-FIN-LIVE-20261115-01 (SWAP-LIVE-01): TEST-ONLY. The lane pin module with ONLY its code hashes replaced by
// keccak256 of the fake chain's bytes (./swap-lane-fake.ts fakeCodeOf), for every route; every address, slot, selector,
// oracle and pin-set id stays the real pin. Used inside vi.mock factories (a real runtime-code preimage cannot be
// produced). Not a test file itself. Imports nothing from src at run time (type-only imports).
import { keccak256 } from "viem";
import type * as PinModule from "../../src/swap/lane/pins";
import type { LanePin, LaneRoutePins } from "../../src/swap/lane/pins";

/** TEST-ONLY switch: the pin set of this route is served with its POOL hash unverified (null), to exercise the
 * engine's PIN_UNVERIFIED refusal now that no real pin is null. Read when an engine is constructed. */
export const PIN_TEST_OVERRIDES: { nullPoolOf: string | null } = {
  nullPoolOf: null,
};
export function fakeCodePinModule(real: typeof PinModule): typeof PinModule {
  const pin = (p: LanePin): LanePin =>
    Object.freeze({
      ...p,
      codehash: keccak256(`0x60806040${p.address.slice(2).toLowerCase()}`),
    });
  const table: Readonly<Record<string, Readonly<LaneRoutePins>>> =
    Object.freeze(
      Object.fromEntries(
        Object.entries(real.SWAP_LANE_ROUTE_PINS).map(([id, P]) => [
          id,
          Object.freeze({
            ...P,
            pay: pin(P.pay),
            receive: pin(P.receive),
            router: pin(P.router),
            quoter: pin(P.quoter),
            factory: pin(P.factory),
            pool: pin(P.pool),
          }),
        ]),
      ),
    );
  return {
    ...real,
    SWAP_LANE_ROUTE_PINS: table,
    pinsOf: (id: unknown) => {
      if (
        typeof id !== "string" ||
        !Object.prototype.hasOwnProperty.call(table, id)
      )
        return null;
      return id === PIN_TEST_OVERRIDES.nullPoolOf
        ? Object.freeze({
            ...table[id],
            pool: Object.freeze({ ...table[id].pool, codehash: null }),
          })
        : table[id];
    },
  };
}
