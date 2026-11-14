import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
// The upstream ESM distribution has extensionless directory imports; use its supported CommonJS export in Node.
const sdk: typeof import("@uniswap/uniswapx-sdk") = createRequire(
  import.meta.url,
)("@uniswap/uniswapx-sdk");
// Use the real server dependency graph. A bundler can turn require.resolve into
// a numeric module ID, which cannot establish an independent Node resolution context.
const sdkRequire = createRequire(
  realpathSync(
    `${process.cwd()}/swap-providers/node_modules/@uniswap/uniswapx-sdk/package.json`,
  ),
);
export const recoverEvmAddress: (hash: string, signature: string) => string =
  sdkRequire("ethers/lib/utils").recoverAddress;
export const {
  CosignedV2DutchOrder,
  CosignedV3DutchOrder,
  CosignedPriorityOrder,
  REACTOR_ADDRESS_MAPPING: UNISWAPX_REACTORS,
  OrderType: UniswapXOrderType,
} = sdk;
