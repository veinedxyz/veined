// VEINED-MC1 (BRIDGE LANE): the pair table, the per-chain values and the pin sets (src/swap/lane/bridge-scope.ts,
// bridge-pins.ts) against (a) a pinned COPY of the restricted signer v5 values (D:/vnd/hk1/mc1/signer/policy-v5.mjs,
// 2026-11-16) and (b) the swap lane's own per-chain values; never looser than either. When the read-only references
// are present on this machine, the same values are also re-derived from them (policy-v5.mjs ROUTES / CHAINS, and the
// B-matrix evidence D-lifi-onchain.json), and the app's EXACT transactions are judged by the signer's own pure policy
// (P.check, injected reads, no key, no network).
// SYNTHETIC_TEST_ONLY where values are synthetic. Nothing here signs, sends or reaches a network.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { toEventSelector, toFunctionSelector } from "viem";
import {
  BRIDGE_LANE_CHAINS,
  BRIDGE_LANE_PAIRS,
  BRIDGE_LANE_SCOPE,
  bridgeChainById,
  bridgeChainProblems,
  enabledPairs,
  pairById,
} from "../../src/swap/lane/bridge-scope";
import {
  BRIDGE_ACROSS_FACET,
  BRIDGE_FEE_COLLECTOR,
  BRIDGE_FEE_RECIPIENT,
  BRIDGE_LANE_CHAIN_PINS,
  BRIDGE_LANE_PIN_CHAINS,
  BRIDGE_LANE_SELECTORS,
  BRIDGE_LANE_TOPICS,
  BRIDGE_LIFI_DIAMOND,
  bridgePinProblems,
  bridgePinsOf,
  bridgeReadContracts,
  sourceCodePins,
} from "../../src/swap/lane/bridge-pins";
import {
  SWAP_LANE_ROUTES,
  LANE_MAX_HEAD_SKEW_BLOCKS,
} from "../../src/swap/lane/scope";
import { SWAP_LANE_RPC_POOL } from "../../src/swap/lane/reads";
import { BRIDGE_SETTLEMENT_ABI } from "../../src/swap/lane/bridge-engine";

const SIGNER = "D:/vnd/hk1/mc1/signer";
const EVIDENCE = "D:/vnd/hk1/mc1/evidence/B-matrix";
/** The signer v5 bridge route ids (policy-v5.mjs PAIR_COST_BPS, `bridge-<src>-<dst>`), in its order. */
const V5_PAIR_IDS = [
  "1-8453",
  "1-42161",
  "1-10",
  "1-137",
  "1-56",
  "8453-1",
  "8453-42161",
  "8453-10",
  "8453-137",
  "8453-56",
  "42161-1",
  "42161-8453",
  "42161-10",
  "42161-137",
  "42161-56",
  "10-1",
  "10-8453",
  "10-42161",
  "10-137",
  "10-56",
  "137-1",
  "137-8453",
  "137-42161",
  "137-10",
  "137-56",
  "56-1",
  "56-8453",
  "56-42161",
  "56-10",
  "56-137",
].map((p) => `bridge-${p}`);
/** A pinned copy of the signer v5 CHAINS values the lane must never be looser than (2026-11-16). */
const V5 = {
  "1": {
    status: "ENABLED",
    feeModel: "PLAIN",
    maxFee: 5_000_000_000n,
    minTip: 0n,
    age: 45,
    skew: 2,
    conf: 10,
    budget: 546_000_000_000_000n,
  },
  "8453": {
    status: "ENABLED",
    feeModel: "OP_STACK",
    maxFee: 200_000_000n,
    minTip: 0n,
    age: 30,
    skew: 5,
    conf: 300,
    budget: 44_000_000_000_000n,
  },
  "42161": {
    status: "ENABLED",
    feeModel: "ARBITRUM",
    maxFee: 400_000_000n,
    minTip: 0n,
    age: 30,
    skew: 10,
    conf: 200,
    budget: 145_000_000_000_000n,
  },
  "10": {
    status: "ENABLED",
    feeModel: "OP_STACK",
    maxFee: 20_000_000n,
    minTip: 0n,
    age: 30,
    skew: 3,
    conf: 30,
    budget: 7_340_000_000_000n,
  },
  "137": {
    status: "ENABLED",
    feeModel: "PLAIN",
    maxFee: 2_000_000_000_000n,
    minTip: 30_000_000_000n,
    age: 30,
    skew: 4,
    conf: 64,
    budget: 3_400_000_000_000_000_000n,
  },
  "56": {
    status: "BLOCKED",
    feeModel: "PLAIN",
    maxFee: 3_000_000_000n,
    minTip: 0n,
    age: 30,
    skew: 10,
    conf: 140,
    budget: 360_000_000_000_000n,
  },
} as const;
const V5_BRIDGE_GAS_CAP = { APPROVE: 120_000n, EXECUTE: 900_000n };
/** A pinned copy of the signer v5 code table entries the bridge lane pins (lower case). */
const V5_CODE: Record<string, Record<string, string>> = {
  "1": {
    [BRIDGE_LIFI_DIAMOND.toLowerCase()]:
      "0x828f8a0694bfba25c80a406283f149d701cdc944acbbc18b57315cf157db9220",
    [BRIDGE_ACROSS_FACET.toLowerCase()]:
      "0x3018e22e23c2513b0a199a42882e855aa98777883cc7e68062fe3828ff6e2689",
    "0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5":
      "0x932cddc50793da935ccf915651ad67f6b746e9936fcc5614f0ff492563782c75",
    "0x456ac26e5ec083ee9889eba0d1a0a582502b8e84":
      "0x94cc890a705ae8f4b973b6531b201fcd53c6bcbefba7caa12d1812f6fcede5bf",
  },
  "8453": {
    [BRIDGE_LIFI_DIAMOND.toLowerCase()]:
      "0x5efa2ebe1ed041ce83c069f1cedc04945f1438680dacf5f88068ef6c7d94110a",
    [BRIDGE_ACROSS_FACET.toLowerCase()]:
      "0x0d049cb64bfcb713b3fe8fa4727ae763cc1efe1e741ea5c43d41d07add0fb1f8",
    "0x09aea4b2242abc8bb4bb78d537a67a245a7bec64":
      "0x932cddc50793da935ccf915651ad67f6b746e9936fcc5614f0ff492563782c75",
    "0xf23c6c04a2b88e8651fe99bbdccbb5c9d306e6b0":
      "0xb36f3bbdffcc931890a4354aa13c9756f032cf6f968d1d1a9604cb3ece9eb480",
  },
  "42161": {
    [BRIDGE_LIFI_DIAMOND.toLowerCase()]:
      "0x828f8a0694bfba25c80a406283f149d701cdc944acbbc18b57315cf157db9220",
    [BRIDGE_ACROSS_FACET.toLowerCase()]:
      "0xf55f58c8e685178b358b945bcc6c6c7ba0d96cc78f6f22878a4a862f2ba8d339",
    "0xe35e9842fceaca96570b734083f4a58e8f7c5f2a":
      "0x932cddc50793da935ccf915651ad67f6b746e9936fcc5614f0ff492563782c75",
    "0xcfcda84333431bcc9155f2368b8362f0d1dff8c9":
      "0xa860f20748abfdf98f4e55411b5db7630457bec1abfb5d88f1ecd5f25b4ec24b",
  },
  "10": {
    [BRIDGE_LIFI_DIAMOND.toLowerCase()]:
      "0x828f8a0694bfba25c80a406283f149d701cdc944acbbc18b57315cf157db9220",
    [BRIDGE_ACROSS_FACET.toLowerCase()]:
      "0x5a04fc18f35fa01344a2d752123551bc57edb3065573fe0ef02d5d8108591298",
    "0x6f26bf09b1c792e3228e5467807a900a503c0281":
      "0x932cddc50793da935ccf915651ad67f6b746e9936fcc5614f0ff492563782c75",
    "0x60674c53a4cc4ed350659c95fb8020b5ac61ca1d":
      "0xcf5c48ec3d2a4cbd9e097f08e8888e4c07d8698e626414e284f52b66515e2b21",
  },
  "137": {
    [BRIDGE_LIFI_DIAMOND.toLowerCase()]:
      "0x828f8a0694bfba25c80a406283f149d701cdc944acbbc18b57315cf157db9220",
    [BRIDGE_ACROSS_FACET.toLowerCase()]:
      "0x053d15581598f1724768a049b13c4cf8a746d4ff5f201f8aee767b43dec2db0e",
    "0x9295ee1d8c5b022be115a2ad3c30c72e34e7f096":
      "0x932cddc50793da935ccf915651ad67f6b746e9936fcc5614f0ff492563782c75",
    "0x304bed95daecd3e680073eab385193da711d59d4":
      "0x9fccb54e8a69629d8cb50bb3e00042456418de9c600dc73763e81b80e7262518",
  },
};
const FEE_COLLECTOR_HASH =
  "0x99a76627aece8903612e0246c10f13a46e511a0a074d9a4e68987a28c78ebd52";

describe("the pair table", () => {
  it("30 pairs with the signer v5 ids; 20 ENABLED among 1/8453/42161/10/137; the 10 BNB pairs BLOCKED (NO_CIRCLE_USDC)", () => {
    expect(Object.keys(BRIDGE_LANE_PAIRS).sort()).toEqual(
      [...V5_PAIR_IDS].sort(),
    );
    const enabled = enabledPairs().map((p) => p.id);
    expect(enabled).toHaveLength(20);
    for (const id of V5_PAIR_IDS) {
      const p = pairById(id)!;
      const [s, d] = id.slice(7).split("-");
      expect(p).toMatchObject({ id, source: s, destination: d });
      const bnb = s === "56" || d === "56";
      expect(p.status).toBe(bnb ? "BLOCKED" : "ENABLED");
      expect(p.blockReason).toBe(bnb ? "NO_CIRCLE_USDC" : null);
    }
  });
  it("no Avalanche pair and no Avalanche chain anywhere in the bridge lane", () => {
    expect(Object.keys(BRIDGE_LANE_CHAINS)).not.toContain("43114");
    expect(Object.keys(BRIDGE_LANE_CHAIN_PINS)).not.toContain("43114");
    for (const id of Object.keys(BRIDGE_LANE_PAIRS))
      expect(id).not.toMatch(/43114/);
    for (const id of ["bridge-43114-1", "bridge-1-43114", "bridge-43114-8453"])
      expect(pairById(id)).toBeNull();
    expect(bridgeChainById("43114")).toBeNull();
  });
  it("own entries only: inherited keys are never a pair or a chain", () => {
    for (const k of [
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
      "",
    ]) {
      expect(pairById(k)).toBeNull();
      expect(bridgeChainById(k)).toBeNull();
      expect(bridgePinsOf(k)).toBeNull();
    }
    expect(pairById(5)).toBeNull();
  });
  it.each(Object.keys(BRIDGE_LANE_PAIRS))(
    "%s: exactly 5 USDC in, 4.90 out, 25 bps fee cap, 300 bps cost cap, multiplier 1.0, the source chain's budget",
    (id) => {
      const p = pairById(id)!;
      const S = bridgeChainById(p.source)!,
        D = bridgeChainById(p.destination)!;
      const inU = 10n ** BigInt(S.usdc.decimals),
        outU = 10n ** BigInt(D.usdc.decimals);
      expect(p.exactAmount).toBe(5n * inU);
      expect(p.minimumOut).toBe((49n * outU) / 10n);
      expect(p.maxFee).toBe((5n * inU * 25n) / 10_000n);
      expect(p.maxCostBps).toBe(300);
      expect(p.maxMultiplier).toBe((10n ** 18n * outU) / inU);
      expect(p.gasBudgetWei).toBe(S.gasBudgetWei);
      expect(Object.isFrozen(p)).toBe(true);
      if (p.status === "ENABLED") {
        expect(p.exactAmount).toBe(5_000_000n);
        expect(p.minimumOut).toBe(4_900_000n);
        expect(p.maxFee).toBe(12_500n);
        expect(p.maxMultiplier).toBe(10n ** 18n);
      }
    },
  );
  it("the global scope is the spec's", () => {
    expect(BRIDGE_LANE_SCOPE).toMatchObject({
      exactAmount: 5_000_000n,
      minimumOut: 4_900_000n,
      maxCostBps: 300,
      maxFeeBps: 25,
      minFillWindowSec: 1800,
      maxFillWindowSec: 21_600,
      maxQuoteSkewSec: 600,
      quoteSkewMarginSec: 60,
      maxExclusivitySec: 300,
      maxIntegratorLength: 64,
      tool: "across",
      reviewTtlSec: 20,
      logWindowBlocks: 100,
      singleUse: true,
    });
    expect(Object.isFrozen(BRIDGE_LANE_SCOPE)).toBe(true);
  });
});

describe("per-chain values: never looser than signer v5, identical to the swap lane", () => {
  it.each(Object.keys(BRIDGE_LANE_CHAINS))("%s", (id) => {
    const c = BRIDGE_LANE_CHAINS[id];
    const v = V5[id as keyof typeof V5];
    expect(bridgeChainProblems(c)).toEqual([]);
    expect(c.status).toBe(v.status);
    expect(c.feeModel).toBe(v.feeModel);
    expect(c.maxFeePerGasWei).toBe(v.maxFee);
    expect(c.minTipWei).toBeGreaterThanOrEqual(v.minTip);
    expect(c.maxTipWei).toBeLessThan(c.maxFeePerGasWei);
    expect(c.maxReviewBlockAgeSec).toBeLessThanOrEqual(v.age);
    expect(c.maxHeadSkewBlocks).toBe(v.skew);
    expect(LANE_MAX_HEAD_SKEW_BLOCKS[id]).toBe(v.skew);
    expect(c.confirmations).toBe(v.conf);
    expect(c.gasBudgetWei).toBe(v.budget);
    expect(c.maxGas.APPROVE).toBeLessThanOrEqual(V5_BRIDGE_GAS_CAP.APPROVE);
    expect(c.maxGas.EXECUTE).toBeLessThanOrEqual(V5_BRIDGE_GAS_CAP.EXECUTE);
    // the swap lane's route of the same chain carries the same fee model, ceiling, tips, depth, age and USDC
    const swap = Object.values(SWAP_LANE_ROUTES).find((r) => r.chainId === id)!;
    expect({
      feeModel: c.feeModel,
      maxFeePerGasWei: c.maxFeePerGasWei,
      minTipWei: c.minTipWei,
      maxTipWei: c.maxTipWei,
      confirmations: c.confirmations,
      maxReviewBlockAgeSec: c.maxReviewBlockAgeSec,
      usdc: c.usdc.address,
      decimals: c.usdc.decimals,
      status: c.status,
    }).toEqual({
      feeModel: swap.feeModel,
      maxFeePerGasWei: swap.maxFeePerGasWei,
      minTipWei: swap.minTipWei,
      maxTipWei: swap.maxTipWei,
      confirmations: swap.confirmations,
      maxReviewBlockAgeSec: swap.maxReviewBlockAgeSec,
      usdc: swap.pay.address,
      decimals: swap.pay.decimals,
      status: swap.status,
    });
    // two operators of different organisations on every bridge chain
    const pool = SWAP_LANE_RPC_POOL[id as keyof typeof SWAP_LANE_RPC_POOL];
    expect(pool).toHaveLength(2);
    expect(pool[0].operator).not.toBe(pool[1].operator);
    expect(Object.isFrozen(c)).toBe(true);
  });
});

describe("the pin sets", () => {
  it("one pin set per chain, consistent with the chain table", () => {
    expect([...BRIDGE_LANE_PIN_CHAINS].sort()).toEqual(
      Object.keys(BRIDGE_LANE_CHAINS).sort(),
    );
    for (const id of Object.keys(BRIDGE_LANE_CHAINS)) {
      expect(bridgePinProblems(id)).toEqual([]);
      const p = bridgePinsOf(id)!;
      expect(p.usdc.address.toLowerCase()).toBe(
        BRIDGE_LANE_CHAINS[id].usdc.address.toLowerCase(),
      );
      expect(Object.isFrozen(p)).toBe(true);
      expect(Object.isFrozen(p.spokePool.implementation)).toBe(true);
      for (const pin of sourceCodePins(p))
        expect(pin.codehash).toMatch(/^0x[0-9a-f]{64}$/);
      // the read contracts are exactly the pins (+ the OP-stack oracle), nothing else
      expect(bridgeReadContracts(id)).toEqual(
        [
          ...sourceCodePins(p).map((x) => x.address),
          ...(p.gasPriceOracle ? [p.gasPriceOracle] : []),
          // review MINOR-3: the Arbitrum NodeInterface (eth_call only), as signer v5 reads it
          ...(id === "42161"
            ? ["0x00000000000000000000000000000000000000c8"]
            : []),
        ].map((a) => a.toLowerCase()),
      );
    }
    expect(bridgePinProblems("43114")).toEqual(["PIN_SET_MISSING"]);
  });
  it.each(Object.keys(V5_CODE))(
    "%s: every bridge pin equals the signer v5 code table (facet hash per chain, Base Diamond differs)",
    (id) => {
      const p = bridgePinsOf(id)!;
      const want = V5_CODE[id];
      expect(p.diamond.codehash).toBe(want[BRIDGE_LIFI_DIAMOND.toLowerCase()]);
      expect(p.facet.codehash).toBe(want[BRIDGE_ACROSS_FACET.toLowerCase()]);
      expect(p.feeCollector.codehash).toBe(FEE_COLLECTOR_HASH);
      expect(p.spokePool.codehash).toBe(
        want[p.spokePool.address.toLowerCase()],
      );
      expect(p.spokePool.implementation.codehash).toBe(
        want[p.spokePool.implementation.address.toLowerCase()],
      );
      // the USDC pins are the swap lane's (one table of truth for the token)
      const swapPins = Object.values(SWAP_LANE_ROUTES).find(
        (r) => r.chainId === id,
      )!;
      expect(p.usdc.address).toBe(swapPins.pay.address);
    },
  );
  it("the facet hash is per chain; the Diamond hash is the same on five chains and differs on Base", () => {
    const facets = Object.values(BRIDGE_LANE_CHAIN_PINS).map(
      (p) => p.facet.codehash,
    );
    expect(new Set(facets).size).toBe(facets.length);
    const diamonds = Object.entries(BRIDGE_LANE_CHAIN_PINS).map(
      ([id, p]) => [id, p.diamond.codehash] as const,
    );
    expect(
      new Set(diamonds.filter(([id]) => id !== "8453").map(([, h]) => h)).size,
    ).toBe(1);
    expect(diamonds.find(([id]) => id === "8453")![1]).not.toBe(
      diamonds.find(([id]) => id === "1")![1],
    );
  });
  it("selectors and topics are the keccak of their signatures", () => {
    expect(BRIDGE_LANE_SELECTORS.bridge).toBe(
      toFunctionSelector(
        "function swapAndStartBridgeTokensViaAcrossV4((bytes32,string,string,address,address,address,uint256,uint256,bool,bool),(address,address,address,address,uint256,bytes,bool)[],(bytes32,bytes32,bytes32,bytes32,uint256,uint128,bytes32,uint32,uint32,uint32,bytes))",
      ),
    );
    expect(BRIDGE_LANE_SELECTORS.forwardFees).toBe(
      toFunctionSelector(
        "function forwardERC20Fees(address,(address,uint256)[])",
      ),
    );
    expect(BRIDGE_LANE_SELECTORS.facetAddress).toBe(
      toFunctionSelector("function facetAddress(bytes4)"),
    );
    expect(BRIDGE_LANE_SELECTORS.spokePool).toBe(
      toFunctionSelector("function SPOKEPOOL()"),
    );
    expect(BRIDGE_LANE_TOPICS.filledRelay).toBe(
      toEventSelector(BRIDGE_SETTLEMENT_ABI[0]),
    );
    expect(BRIDGE_LANE_TOPICS.fundsDeposited).toBe(
      toEventSelector(BRIDGE_SETTLEMENT_ABI[1]),
    );
    expect(BRIDGE_LANE_TOPICS.transfer).toBe(
      toEventSelector(
        "event Transfer(address indexed from, address indexed to, uint256 value)",
      ),
    );
    expect(BRIDGE_FEE_COLLECTOR).toBe(
      "0xde2b920506ee931a6a2abdf566526220214fbbae",
    );
    expect(BRIDGE_FEE_RECIPIENT).toBe(
      "0xc06ebbefd94032b85424d51906e2a335efae264b",
    );
  });
});

// ---- the read-only references, when present (offline file reads only) -----------------------------------------------
const haveEvidence = existsSync(`${EVIDENCE}/D-lifi-onchain.json`);
describe.skipIf(!haveEvidence)(
  "re-derived from the B-matrix evidence (D-lifi-onchain.json)",
  () => {
    it("every pin equals the evidence, and both evidence operators agreed on it", () => {
      const ev = JSON.parse(
        readFileSync(`${EVIDENCE}/D-lifi-onchain.json`, "utf8"),
      ) as {
        chains: Record<
          string,
          {
            diamond: { codeHash: Record<string, string> };
            acrossV4Facet: {
              facet: string;
              codeHash: Record<string, string>;
              "SPOKEPOOL()": string;
            };
            acrossSpokePool: {
              address: string;
              codeHash: Record<string, string>;
              implementation: string;
              implementationCodeHash: string;
            };
            feeCollector: { codeHash: Record<string, string> };
          }
        >;
      };
      const one = (o: Record<string, string>) => {
        const v = Object.values(o);
        expect(v).toHaveLength(2);
        expect(v[0]).toBe(v[1]);
        return v[0];
      };
      for (const id of Object.keys(BRIDGE_LANE_CHAIN_PINS)) {
        const e = ev.chains[id],
          p = BRIDGE_LANE_CHAIN_PINS[id];
        expect(one(e.diamond.codeHash)).toBe(p.diamond.codehash);
        expect(e.acrossV4Facet.facet.toLowerCase()).toBe(
          p.facet.address.toLowerCase(),
        );
        expect(one(e.acrossV4Facet.codeHash)).toBe(p.facet.codehash);
        expect(e.acrossV4Facet["SPOKEPOOL()"].toLowerCase()).toBe(
          p.spokePool.address.toLowerCase(),
        );
        expect(e.acrossSpokePool.address.toLowerCase()).toBe(
          p.spokePool.address.toLowerCase(),
        );
        expect(one(e.acrossSpokePool.codeHash)).toBe(p.spokePool.codehash);
        expect(e.acrossSpokePool.implementation.toLowerCase()).toBe(
          p.spokePool.implementation.address.toLowerCase(),
        );
        expect(e.acrossSpokePool.implementationCodeHash).toBe(
          p.spokePool.implementation.codehash,
        );
        expect(one(e.feeCollector.codeHash)).toBe(p.feeCollector.codehash);
      }
      // Avalanche: no facet for the selector (NO_ACROSS_FACET) — the reason it has no pair
      expect(
        (ev.chains["43114"] as unknown as { acrossV4Facet: { facet: string } })
          .acrossV4Facet.facet,
      ).toBe("0x0000000000000000000000000000000000000000");
    });
  },
);

const haveSigner =
  existsSync(`${SIGNER}/policy-v5.mjs`) &&
  existsSync(`${SIGNER}/fixtures-v5.mjs`);
describe.skipIf(!haveSigner)(
  "re-derived from signer v5 (policy-v5.mjs, pure functions, no key, no network)",
  () => {
    it("the 30 bridge routes: same ids, status, amounts, minimum, fee cap, cost cap, multiplier, budget; caps never looser", async () => {
      const P = (await import(
        pathToFileURL(`${SIGNER}/policy-v5.mjs`).href
      )) as {
        ROUTES: Record<string, Record<string, unknown>>;
        CHAINS: Record<
          string,
          Record<string, unknown> & { code?: Record<string, string> }
        >;
      };
      const bridges = Object.values(P.ROUTES).filter(
        (r) => r.lane === "BRIDGE",
      );
      expect(bridges.map((r) => r.id).sort()).toEqual(
        Object.keys(BRIDGE_LANE_PAIRS).sort(),
      );
      for (const r of bridges) {
        const p = pairById(r.id)!;
        expect(p.status).toBe(r.status);
        expect(p.source).toBe(String(r.chainId));
        expect(p.destination).toBe(String(r.destinationChainId));
        expect(p.exactAmount).toBe(r.exactAmount);
        expect(p.minimumOut).toBe(r.minimumOut);
        expect(p.maxFee).toBe(r.maxFee);
        expect(BigInt(p.maxCostBps)).toBe(r.maxCostBps);
        expect(p.maxMultiplier).toBe(r.maxMultiplier);
        expect(p.gasBudgetWei).toBe(r.gasBudgetWei);
        const cap = r.gasCap as { APPROVE: bigint; EXECUTE: bigint };
        const S = bridgeChainById(p.source)!;
        expect(
          S.maxGas.APPROVE <= cap.APPROVE && S.maxGas.EXECUTE <= cap.EXECUTE,
        ).toBe(true);
        expect((r.selector as string).toLowerCase()).toBe(
          BRIDGE_LANE_SELECTORS.bridge,
        );
        expect(r.feeRecipient).toBe(BRIDGE_FEE_RECIPIENT);
        expect(r.feeCollector).toBe(BRIDGE_FEE_COLLECTOR);
        expect(r.facet).toBe(BRIDGE_ACROSS_FACET.toLowerCase());
        expect(r.diamond).toBe(BRIDGE_LIFI_DIAMOND.toLowerCase());
      }
      for (const id of Object.keys(BRIDGE_LANE_CHAINS)) {
        const c = BRIDGE_LANE_CHAINS[id],
          v = P.CHAINS[id];
        expect(c.maxFeePerGasWei).toBe(v.maxFeePerGasWei);
        expect(c.minTipWei >= (v.minPriorityFeePerGasWei as bigint)).toBe(true);
        expect(c.maxReviewBlockAgeSec <= (v.maxReadBlockAgeSec as number)).toBe(
          true,
        );
        expect(c.maxHeadSkewBlocks).toBe(v.maxHeadSkewBlocks);
        expect(c.confirmations).toBe(v.minConfirmations);
        expect(c.gasBudgetWei).toBe(v.bridgeGasBudgetWei);
        expect(c.feeModel).toBe(v.feeModel);
        const pins = BRIDGE_LANE_CHAIN_PINS[id];
        for (const pin of sourceCodePins(pins))
          expect(
            v.code![pin.address.toLowerCase()],
            `${id} ${pin.address}`,
          ).toBe(pin.codehash);
        expect((v.usdc as { impl: string }).impl).toBe(
          pins.usdc.implementation.address.toLowerCase(),
        );
        expect((v.across as { spokePool: string }).spokePool).toBe(
          pins.spokePool.address.toLowerCase(),
        );
        expect((v.across as { spokePoolImpl: string }).spokePoolImpl).toBe(
          pins.spokePool.implementation.address.toLowerCase(),
        );
      }
      expect(P.CHAINS["43114"].status).toBe("BLOCKED");
    });
  },
);
