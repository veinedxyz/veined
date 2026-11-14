import { expect, it } from "vitest";
import { knownAsset } from "../../src/assets/registry";
import { assetKey } from "../../src/assets/model";
const chain = "1151111081099710",
  mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
it("Solana USDC exact issuer mint has a local image, with routing still closed", () => {
  const a = knownAsset(chain, mint);
  expect(a?.decimals).toBe(6);
  expect(a?.logo?.src).toContain(`/assets/tokens/${chain}/${mint}-`);
  expect(a?.routable).toBe(false);
});
it("Solana case, different mint and different chain never inherit the USDC logo", () => {
  expect(knownAsset(chain, mint.toLowerCase())).toBeNull();
  expect(knownAsset("1", mint)).toBeNull();
  expect(knownAsset(chain, mint.slice(0, -1) + "2")).toBeNull();
  expect(assetKey(chain, mint)).not.toEqual(
    assetKey(chain, mint.toLowerCase()),
  );
});
