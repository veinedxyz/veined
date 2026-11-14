import { expect, it } from "vitest";
import { isAssetLogoSrc } from "../../src/assets/logo-path";

it.each([
  "/assets/tokens/1151111081099710/EpCaseSensitiveMint-deadbeef.png",
  "/assets/chains/chain-56-aabb.png",
  "/assets/official/onechain.png",
  `/api/asset-image/${"a".repeat(64)}`,
])("accepts exact same-origin registry asset %s", (src) =>
  expect(isAssetLogoSrc(src)).toBe(true),
);
it.each([
  "https://example.com/a.png",
  "//example.com/a.png",
  "/assets/tokens/../secret.png",
  "/assets/tokens//a.png",
  "/api/asset-image/abc",
  "data:image/svg+xml,evil",
  "/assets/tokens/a.svg?x=1",
  "/assets/tokens/a.png#x",
  "/assets/tokens/a%2f.png",
])("refuses foreign or ambiguous image path %s", (src) =>
  expect(isAssetLogoSrc(src)).toBe(false),
);
