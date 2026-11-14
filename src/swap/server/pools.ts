import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { V2_ROUTER_ADDRESS } from "../../../swap-providers/runtime";
import {
  identity,
  SwapError,
  ZERO,
  type SwapIntent,
  type SwapQuote,
} from "../model";
import { AERO, routerPin } from "./config";
import { digest } from "./digest";
import { deployment } from "./providers/uniswap";
import { evmContext } from "./providers/aerodrome";
import { rpc } from "./transport";
import pins from "./deployment-pins.generated.json" with { type: "json" };
import { reviewedPoolKey } from "./universal";
import { V4_DEPLOYMENTS } from "./providers/singleton";
const singletonABI = parseAbi([
  "function getSlot0(bytes32) view returns(uint160,int24,uint24,uint24)",
]);
const abi = parseAbi([
  "function factory() view returns(address)",
  "function getPair(address,address) view returns(address)",
  "function getPool(address,address,uint24) view returns(address)",
  "function poolFor(address,address,bool,address) view returns(address)",
  "function isPoolFactoryApproved(address) view returns(bool)",
]);
const clAbi = parseAbi([
  "function getPool(address,address,int24) view returns(address)",
]);
// @pancakeswap/v3-sdk 3.10.3 FACTORY_ADDRESSES: Ethereum, BSC, Base.
const PANCAKE_V3_FACTORY = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865";
/** Verify displayed pool attribution independently of provider JSON at one RPC block. */
export async function verifyPools(
  q: SwapQuote,
  i: SwapIntent,
  signal: AbortSignal,
) {
  const block = await evmContext(i, signal);
  const call = async (to: string, data: Hex) => {
    const result = await rpc(
      i.chain,
      "eth_call",
      [{ to, data }, block],
      signal,
    );
    if (typeof result !== "string") throw new SwapError("REVIEW_REQUIRED");
    return result as Hex;
  };
  const code = async (address: string) => {
    const value = await rpc(i.chain, "eth_getCode", [address, block], signal);
    if (typeof value !== "string" || !/^0x[0-9a-f]{2,}$/i.test(value))
      throw new SwapError("REVIEW_REQUIRED");
    return digest(value.toLowerCase());
  };
  const router = routerPin(q.mode, i.chain);
  const verifyDeployment = async (address: string) => {
    const pin = pins.find(
      (p) => p.chain === i.chain && p.address === identity(address),
    );
    if (!pin) throw new SwapError("REVIEW_REQUIRED");
    const value = await rpc(i.chain, "eth_getCode", [address, block], signal);
    if (typeof value !== "string" || keccak256(value as Hex) !== pin.codehash)
      throw new SwapError("REVIEW_REQUIRED");
    // Reviewed routers/managers are not EIP-1967 proxies. A change in either slot invalidates the pin.
    for (const [n, slot] of [
      "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
      "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
    ].entries()) {
      const current = await rpc(
        i.chain,
        "eth_getStorageAt",
        [address, slot, block],
        signal,
      );
      if (current !== pin.proxySlots[n]) throw new SwapError("REVIEW_REQUIRED");
    }
    return pin.codehash;
  };
  await verifyDeployment(router.address);
  const routerCodeDigest = await code(router.address);
  const pools = [];
  for (const leg of q.route) {
    let expected: string;
    const a = leg.tokenIn as Address,
      b = leg.tokenOut as Address;
    if (q.mode === "AERODROME_CLASSIC") {
      if (identity(leg.factory ?? "") !== identity(AERO.factory))
        throw new SwapError("REVIEW_REQUIRED");
      const approved = decodeFunctionResult({
        abi,
        functionName: "isPoolFactoryApproved",
        data: await call(
          AERO.registry,
          encodeFunctionData({
            abi,
            functionName: "isPoolFactoryApproved",
            args: [AERO.factory as Address],
          }),
        ),
      });
      if (!approved) throw new SwapError("REVIEW_REQUIRED");
      expected = decodeFunctionResult({
        abi,
        functionName: "poolFor",
        data: await call(
          AERO.router,
          encodeFunctionData({
            abi,
            functionName: "poolFor",
            args: [a, b, leg.poolType === "STABLE", AERO.factory as Address],
          }),
        ),
      });
    } else if (q.mode === "AERODROME_SLIPSTREAM") {
      if (identity(leg.factory ?? "") !== identity(AERO.clFactory))
        throw new SwapError("REVIEW_REQUIRED");
      expected = decodeFunctionResult({
        abi: clAbi,
        functionName: "getPool",
        data: await call(
          AERO.clFactory,
          encodeFunctionData({
            abi: clAbi,
            functionName: "getPool",
            args: [a, b, leg.fee!],
          }),
        ),
      });
    } else if (q.mode === "UNISWAP" || q.mode === "PANCAKESWAP_SMART") {
      if (["V4", "INFINITY_CL", "INFINITY_BIN"].includes(leg.poolType)) {
        const key = reviewedPoolKey(leg, q.mode, i.chain);
        const deployment = V4_DEPLOYMENTS[i.chain];
        const manager = key.kind === "V4" ? deployment.manager : leg.factory!;
        const managerCodehash = await verifyDeployment(manager);
        const state = key.kind === "V4" ? deployment.stateView : manager;
        if (key.kind === "V4") await verifyDeployment(state);
        const raw = await call(
          state,
          encodeFunctionData({
            abi: singletonABI,
            functionName: "getSlot0",
            args: [key.id],
          }),
        );
        // CL starts with sqrtPriceX96; Bin starts with activeId. Both must be nonzero.
        if (
          !/^0x[0-9a-f]{192,256}$/i.test(raw) ||
          BigInt(`0x${raw.slice(2, 66)}`) === 0n
        )
          throw new SwapError("REVIEW_REQUIRED");
        pools.push({
          address: key.id,
          poolKey: key.key,
          manager,
          managerCodehash,
          slot0: raw,
          venue: leg.venue,
          poolType: leg.poolType,
        });
        continue;
      } else if (leg.poolType === "V3") {
        const factory =
          q.mode === "UNISWAP"
            ? deployment[i.chain as keyof typeof deployment]?.factory
            : PANCAKE_V3_FACTORY;
        if (!factory) throw new SwapError("REVIEW_REQUIRED");
        expected = decodeFunctionResult({
          abi,
          functionName: "getPool",
          data: await call(
            factory,
            encodeFunctionData({
              abi,
              functionName: "getPool",
              args: [a, b, leg.fee!],
            }),
          ),
        });
      } else if (leg.poolType === "V2") {
        const v2router =
          q.mode === "UNISWAP"
            ? deployment[i.chain as keyof typeof deployment]?.v2
            : V2_ROUTER_ADDRESS[
                Number(i.chain) as keyof typeof V2_ROUTER_ADDRESS
              ];
        if (!v2router) throw new SwapError("REVIEW_REQUIRED");
        const factory = decodeFunctionResult({
          abi,
          functionName: "factory",
          data: await call(
            v2router,
            encodeFunctionData({ abi, functionName: "factory" }),
          ),
        });
        expected = decodeFunctionResult({
          abi,
          functionName: "getPair",
          data: await call(
            factory,
            encodeFunctionData({ abi, functionName: "getPair", args: [a, b] }),
          ),
        });
      } else throw new SwapError("BUILD_REVIEW_REQUIRED");
    } else throw new SwapError("BUILD_REVIEW_REQUIRED");
    if (
      identity(expected) === ZERO ||
      identity(expected) !== identity(leg.pool)
    )
      throw new SwapError("REVIEW_REQUIRED");
    pools.push({
      address: identity(expected),
      codeDigest: await code(expected),
      venue: leg.venue,
      poolType: leg.poolType,
    });
  }
  return { block, router: identity(router.address), routerCodeDigest, pools };
}
