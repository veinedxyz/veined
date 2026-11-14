# Network environments (V1.11)

Every network the product can name carries an `environment`: `mainnet | testnet | devnet | local | unknown`
(`src/registry/chain-identity.ts`). Environment is a **safety field**: a testnet is never shown or counted as a
mainnet, and a financial route never crosses environments silently.

## Decision rules (most authoritative first)

| Order | Source | Rule |
| --- | --- | --- |
| 1 | `local-test` | chain ids 31337/31338 (local test mode) → `local` |
| 2 | routing catalog | provider `mainnet` flag **and** a name that does not look like a test/dev network → `mainnet`; otherwise `testnet`/`devnet` |
| 3 | custom registry | ONEchain (612055) → `mainnet` unless the name says test/dev |
| 4 | name / ethereum-lists | a test/dev-looking name or an ethereum-lists testnet record → `testnet`/`devnet` (name heuristics may only move a chain **away** from mainnet) |
| 5 | active TVL catalog | positive locked value → `mainnet` |
| — | none of the above | `unknown` (never guessed as mainnet) |

Current registry (`pnpm assets:sync:chains`, 2026-10-06): **343** networks — **335 mainnet, 6 testnet, 0 devnet,
2 local, 0 unknown**. Testnets: Ethereum Sepolia 11155111, Arbitrum Sepolia 421614, OP Sepolia 11155420, Base
Sepolia 84532, Arc Testnet 5042002 (routing catalog) and chain id **5887** (see conflicts).

### Recorded conflicts (resolved conservatively)

- **5887 "MANTRA"**: the TVL catalog maps the MANTRA mainnet row to chain id 5887, but ethereum-lists records 5887
  as the MANTRA Dukong **testnet** (explorer `mantrascan.io/dukong`). The registry keeps **testnet** — the safer
  side — until a release source resolves it. It therefore appears only under *Testnets*.
- **Stellar alias**: the TVL catalog name alias table must not override an exact routing-catalog name; resolution
  takes the routing name first (fixed during sync; Stellar stays `1201081091099710`, `stellar:pubnet`).

## Product behaviour

- **Network selector** (`src/components/network-selector.tsx`): `Mainnets | Testnets` tabs with counts; Mainnets is
  the default (Testnets only when the current selection is a testnet). Search runs inside the active environment;
  the optional **Search all networks** toggle widens a query to all environments. Testnet rows carry a `Testnet`
  badge and the tab shows "Testnet assets have no real value. A testnet can never be combined with a mainnet in a
  route."
- **Routes** (`multichain-bridge.tsx`): `crossEnvironment(a, b)` blocks any pair whose environments differ or are
  unknown → `CROSS_ENVIRONMENT_ROUTE_DISABLED`, "Mainnet and testnet networks cannot be combined in one route.";
  the read-route button is disabled and no quote is requested.
- **Portfolio**: testnet holdings are listed but never counted in *Total known value* ("Testnet assets never count
  toward the total.").
- **Networks page** (`multichain-catalog.tsx`): Mainnets/Testnets filter tabs with counts; testnet rows carry the
  badge.
- **Docs/landing**: counts come from the generated registry at render time (`MAINNETS`, `TESTNETS` doc constants).

## Tests

Unit: `tests/unit/v111-registry.test.ts` (environment rules, cross-environment, short names). E2E:
`tests/e2e/v111.spec.ts` "network environments" (Mainnets default, Testnets count, environment-scoped search,
search-all, testnet note, mainnet→testnet refused before any quote) and the portfolio testnet exclusion.
