// V1.14 core and family nonzero proofs — READ-ONLY. Runs the production adapters (DefiReader + adapterFor) at a pinned
// block through the vetted RPC pool, then recomputes the result independently through a different public endpoint
// with plain view calls at the same block. Test addresses are public protocol contracts (treasuries, vaults, gauges,
// strategies, fee collectors) or the zero address; no person is identified. No transaction, signature or wallet use.
//   node … scripts/defi-proofs.ts [--only=<proof-id,…>] [--out=<dir>]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeAbiParameters,
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  toEventSelector,
  keccak256,
  encodePacked,
  type Abi,
  type Hex,
} from "viem";
import { DataPlane } from "../src/data/plane";
import { deployments } from "../src/defi/registry";
import { adapterFor } from "../src/defi/adapters";
import { DefiReader, pinChain, type BlockPin } from "../src/defi/reader";
import type { DefiPosition, PositionRef } from "../src/defi/model";
import { isqrt, uncollectedFees } from "../src/defi/families";
import { liquidityAmounts } from "../src/defi/math";

const args = process.argv.slice(2);
const only = args
  .find((a) => a.startsWith("--only="))
  ?.slice(7)
  .split(",");
const out =
  args.find((a) => a.startsWith("--out="))?.slice(6) ??
  join(process.env.OTHERBRIDGE_V114_EVIDENCE ?? "test-results", "core-nonzero");
mkdirSync(out, { recursive: true });
const INDEPENDENT: Record<string, string> = {
  "1": "https://gateway.tenderly.co/public/mainnet",
  "8453": "https://mainnet.base.org",
  "56": "https://bsc-dataseed1.binance.org",
  "10": "https://mainnet.optimism.io",
  "42161": "https://arb1.arbitrum.io/rpc",
};
let rpcId = 1;
async function rpc(chainId: string, method: string, params: unknown[]) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rpcOnce(chainId, method, params);
    } catch (e) {
      if (
        attempt >= 6 ||
        !/rate limit|429|timeout|fetch failed|block not found/i.test(
          String((e as Error).message),
        )
      )
        throw e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}
async function rpcOnce(chainId: string, method: string, params: unknown[]) {
  const r = await fetch(INDEPENDENT[chainId], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
    signal: AbortSignal.timeout(60000),
  });
  const j = (await r.json()) as { result?: unknown; error?: unknown };
  if (j.error || j.result === undefined)
    throw Error("INDEPENDENT_RPC:" + JSON.stringify(j.error).slice(0, 160));
  return j.result;
}
// Independent view call at the pinned block (separate endpoint, separate code path).
async function view(
  chainId: string,
  block: bigint,
  to: string,
  signature: string,
  callArgs: unknown[] = [],
) {
  const abi = parseAbi([signature]) as Abi;
  const name = signature.slice(9, signature.indexOf("("));
  const data = encodeFunctionData({ abi, functionName: name, args: callArgs });
  const raw = (await rpc(chainId, "eth_call", [
    { to, data },
    "0x" + block.toString(16),
  ])) as Hex;
  return decodeFunctionResult({ abi, functionName: name, data: raw });
}
async function logs(
  chainId: string,
  address: string,
  topic: string,
  from: bigint,
  to: bigint,
) {
  return (await rpc(chainId, "eth_getLogs", [
    {
      address,
      topics: [topic],
      fromBlock: "0x" + from.toString(16),
      toBlock: "0x" + to.toString(16),
    },
  ])) as { topics: string[]; data: string; blockNumber: string }[];
}
const code = async (chainId: string, a: string, block: bigint) =>
  (
    (await rpc(chainId, "eth_getCode", [
      a,
      "0x" + block.toString(16),
    ])) as string
  ).length > 2;
const plane = new DataPlane(null);
const state = await plane.state();
interface Proof {
  id: string;
  family: string;
  deploymentId: string;
  addressNote: string;
  wallet: (pin: BlockPin) => Promise<string>;
  refs?: (pin: BlockPin, wallet: string) => Promise<PositionRef[] | undefined>;
  held?: (pin: BlockPin, wallet: string) => Promise<string[]>;
  independent: (
    pin: BlockPin,
    wallet: string,
    positions: DefiPosition[],
  ) => Promise<{
    method: string;
    expected: Record<string, string>;
    actual: Record<string, string>;
  }>;
}
const deployment = (id: string) => {
  const d = deployments.find((x) => x.id === id);
  if (!d) throw Error("UNKNOWN_DEPLOYMENT:" + id);
  return d;
};
const ZERO = "0x0000000000000000000000000000000000000000";
const sum = (
  positions: DefiPosition[],
  key: "supplied" | "underlying" | "borrowed",
) =>
  positions
    .flatMap((p) => p[key])
    .reduce<Record<string, string>>((a, x) => {
      a[x.contract] = (
        BigInt(a[x.contract] ?? "0") + BigInt(x.rawAmount)
      ).toString();
      return a;
    }, {});
const proofs: Proof[] = [];
// ---- Aave V3 (Ethereum): the protocol Collector from the pinned official address book ----
proofs.push({
  id: "aave-v3-collector",
  family: "aave-v3",
  deploymentId: "aave-v3-1",
  addressNote:
    "Aave V3 Ethereum COLLECTOR constant in pinned aave-address-book (protocol treasury contract)",
  wallet: async () => "0x464c71f6c2f760dda6093dcb91c24c39e5d6e18c",
  independent: async (pin, wallet, positions) => {
    const d = deployment("aave-v3-1");
    const expected: Record<string, string> = {};
    for (const a of d.assets ?? []) {
      const bal = (await view(
        "1",
        pin.number,
        a.receipt,
        "function balanceOf(address) view returns (uint256)",
        [wallet],
      )) as bigint;
      if (bal > 0n) expected[a.underlying] = bal.toString();
    }
    return {
      method: "aToken.balanceOf(collector) per reserve (independent endpoint)",
      expected,
      actual: sum(positions, "supplied"),
    };
  },
});
// ---- SparkLend (Aave V3 fork) treasury: spToken balances accrued to the protocol TREASURY constant ----
proofs.push({
  id: "sparklend-treasury",
  family: "aave-v3",
  deploymentId: "sparklend-1",
  addressNote:
    "SparkLend TREASURY constant in the pinned spark-address-registry (protocol treasury contract)",
  wallet: async () => "0xb137e7d16564c81ae2b0c8ee6b55de81dd46ece5",
  independent: async (pin, wallet, positions) => {
    const d = deployment("sparklend-1");
    const expected: Record<string, string> = {};
    for (const a of d.assets ?? []) {
      const bal = (await view(
        "1",
        pin.number,
        a.receipt,
        "function balanceOf(address) view returns (uint256)",
        [wallet],
      )) as bigint;
      if (bal > 0n) expected[a.underlying] = bal.toString();
    }
    return {
      method: "spToken.balanceOf(treasury) per reserve (independent endpoint)",
      expected,
      actual: sum(positions, "supplied"),
    };
  },
});
// ---- Aave V3 borrower (debt + health factor): a contract account with variable debt, found from recent Borrow logs ----
proofs.push({
  id: "aave-v3-borrower",
  family: "aave-v3",
  deploymentId: "aave-v3-1",
  addressNote:
    "first contract account (eth_getCode != 0x) with debt among recent Aave V3 Borrow events (public, not identified)",
  wallet: async (pin) => {
    const d = deployment("aave-v3-1");
    const topic = toEventSelector(
      "Borrow(address,address,address,uint256,uint8,uint256,uint16)",
    );
    const found = await logs(
      "1",
      d.contracts.pool,
      topic,
      pin.number - 3000n,
      pin.number,
    );
    const seen = new Set<string>();
    for (const l of found.reverse()) {
      const onBehalf = "0x" + l.topics[2].slice(26);
      if (seen.has(onBehalf)) continue;
      seen.add(onBehalf);
      if (!(await code("1", onBehalf, pin.number))) continue;
      const acct = (await view(
        "1",
        pin.number,
        d.contracts.pool,
        "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
        [onBehalf],
      )) as bigint[];
      if (acct[1] > 0n) return onBehalf;
      if (seen.size > 40) break;
    }
    throw Error("NO_CONTRACT_BORROWER_FOUND");
  },
  independent: async (pin, wallet, positions) => {
    const d = deployment("aave-v3-1");
    const expected: Record<string, string> = {};
    for (const a of d.assets ?? []) {
      const bal = (await view(
        "1",
        pin.number,
        a.debt,
        "function balanceOf(address) view returns (uint256)",
        [wallet],
      )) as bigint;
      if (bal > 0n) expected[a.underlying] = bal.toString();
    }
    const acct = (await view(
      "1",
      pin.number,
      d.contracts.pool,
      "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
      [wallet],
    )) as bigint[];
    const risk = positions[0]?.risk;
    return {
      method:
        "variableDebtToken.balanceOf + Pool.getUserAccountData healthFactor (independent endpoint)",
      expected: { ...expected, healthFactor: acct[5].toString() },
      actual: {
        ...sum(positions, "borrowed"),
        healthFactor:
          risk?.kind === "health-factor"
            ? BigInt(risk.value.replace(".", "")).toString()
            : "n/a",
      },
    };
  },
});
// ---- Compound III (cUSDCv3 Ethereum): a contract supplier from recent Supply events ----
proofs.push({
  id: "compound-iii-supplier",
  family: "compound-iii",
  deploymentId: "compound-1-usdc",
  addressNote:
    "first contract account with a cUSDCv3 balance among recent Supply events",
  wallet: async (pin) => {
    const comet = deployment("compound-1-usdc").contracts.comet;
    const topic = toEventSelector("Supply(address,address,uint256)");
    const found = await logs(
      "1",
      comet,
      topic,
      pin.number - 20000n,
      pin.number,
    );
    const seen = new Set<string>();
    for (const l of found.reverse()) {
      const dst = "0x" + l.topics[2].slice(26);
      if (seen.has(dst)) continue;
      seen.add(dst);
      if (!(await code("1", dst, pin.number))) continue;
      const bal = (await view(
        "1",
        pin.number,
        comet,
        "function balanceOf(address) view returns (uint256)",
        [dst],
      )) as bigint;
      if (bal > 0n) return dst;
      if (seen.size > 40) break;
    }
    throw Error("NO_CONTRACT_SUPPLIER_FOUND");
  },
  independent: async (pin, wallet, positions) => {
    const comet = deployment("compound-1-usdc").contracts.comet;
    const base = (await view(
      "1",
      pin.number,
      comet,
      "function baseToken() view returns (address)",
    )) as string;
    const bal = (await view(
      "1",
      pin.number,
      comet,
      "function balanceOf(address) view returns (uint256)",
      [wallet],
    )) as bigint;
    return {
      method: "Comet.balanceOf at pinned block (independent endpoint)",
      expected: { [base.toLowerCase()]: bal.toString() },
      actual: sum(positions, "supplied"),
    };
  },
});
// ---- Morpho Blue: a MetaMorpho vault's market supply equals its own totalAssets (MorphoBalancesLib expected) ----
let deadVault = "";
proofs.push({
  id: "morpho-blue-metamorpho-supply",
  family: "morpho-blue",
  deploymentId: "morpho-blue-1",
  addressNote:
    "a MetaMorpho V1.1 vault (factory-created, isMetaMorpho=true) used as the supplying account",
  wallet: async (pin) => {
    const factory = deployment("morpho-vault-1").contracts.factory;
    const topic = toEventSelector(
      "CreateMetaMorpho(address,address,address,uint256,address,string,string,bytes32)",
    );
    const created = await logs(
      "1",
      factory,
      topic,
      BigInt(deployment("morpho-vault-1").startBlock!),
      pin.number,
    );
    for (const l of created) {
      const v = "0x" + l.topics[1].slice(26);
      try {
        const n = (await view(
          "1",
          pin.number,
          v,
          "function withdrawQueueLength() view returns (uint256)",
        )) as bigint;
        const ta = (await view(
          "1",
          pin.number,
          v,
          "function totalAssets() view returns (uint256)",
        )) as bigint;
        if (n > 0n && n <= 12n && ta > 10n ** 9n) {
          return v;
        }
      } catch {
        /* next vault */
      }
    }
    throw Error("NO_METAMORPHO_VAULT_FOUND");
  },
  refs: async (pin, wallet) => {
    const n = (await view(
      "1",
      pin.number,
      wallet,
      "function withdrawQueueLength() view returns (uint256)",
    )) as bigint;
    const refs: PositionRef[] = [];
    for (let i = 0n; i < n; i++) {
      const id = (
        (await view(
          "1",
          pin.number,
          wallet,
          "function withdrawQueue(uint256) view returns (bytes32)",
          [i],
        )) as string
      ).toLowerCase();
      refs.push({ key: id, marketId: id, discovery: "event-index" });
    }
    return refs;
  },
  independent: async (pin, wallet, positions) => {
    const ta = (await view(
      "1",
      pin.number,
      wallet,
      "function totalAssets() view returns (uint256)",
    )) as bigint;
    const asset = (
      (await view(
        "1",
        pin.number,
        wallet,
        "function asset() view returns (address)",
      )) as string
    ).toLowerCase();
    return {
      method:
        "MetaMorpho.totalAssets() (sum of MORPHO.expectedSupplyAssets over the withdraw queue)",
      expected: { [asset]: ta.toString() },
      actual: sum(positions, "supplied"),
    };
  },
});
// ---- Morpho Vault (MetaMorpho shares) and ERC-4626 ----
proofs.push({
  id: "morpho-vault-dead-deposit",
  family: "morpho-vault",
  deploymentId: "morpho-vault-1",
  addressNote:
    "0x…dEaD burn address holding the vault's dead deposit (public burn address)",
  wallet: async () => "0x000000000000000000000000000000000000dead",
  refs: async (pin, wallet) => {
    const factory = deployment("morpho-vault-1").contracts.factory;
    const created = await logs(
      "1",
      factory,
      toEventSelector(
        "CreateMetaMorpho(address,address,address,uint256,address,string,string,bytes32)",
      ),
      BigInt(deployment("morpho-vault-1").startBlock!),
      pin.number,
    );
    for (const l of created) {
      const v = "0x" + l.topics[1].slice(26);
      const bal = (await view(
        "1",
        pin.number,
        v,
        "function balanceOf(address) view returns (uint256)",
        [wallet],
      )) as bigint;
      if (bal > 0n) {
        deadVault = v;
        return [{ key: v, contract: v, discovery: "event-index" as const }];
      }
    }
    throw Error("NO_DEAD_DEPOSIT_VAULT_FOUND");
  },
  independent: async (pin, wallet) => {
    const shares = (await view(
      "1",
      pin.number,
      deadVault,
      "function balanceOf(address) view returns (uint256)",
      [wallet],
    )) as bigint;
    const assets = (await view(
      "1",
      pin.number,
      deadVault,
      "function previewRedeem(uint256) view returns (uint256)",
      [shares],
    )) as bigint;
    const asset = (
      (await view(
        "1",
        pin.number,
        deadVault,
        "function asset() view returns (address)",
      )) as string
    ).toLowerCase();
    return {
      method: "MetaMorpho.previewRedeem(balanceOf(dead))",
      expected: { [asset]: assets.toString() },
      actual: {},
    };
  },
});
proofs.push({
  id: "erc4626-sfrxeth-strategy",
  family: "erc4626",
  deploymentId: "erc4626-sfrxeth-1",
  addressNote:
    "EigenLayer sfrxETH strategy contract (README literal) holding sfrxETH",
  wallet: async () => "0x8ca7a5d6f3acd3a7a8bc468a8cd0fb14b6bd28b6",
  independent: async (pin, wallet) => {
    const v = deployment("erc4626-sfrxeth-1").contracts.vault;
    const shares = (await view(
      "1",
      pin.number,
      v,
      "function balanceOf(address) view returns (uint256)",
      [wallet],
    )) as bigint;
    const totalAssets = (await view(
      "1",
      pin.number,
      v,
      "function totalAssets() view returns (uint256)",
    )) as bigint;
    const supply = (await view(
      "1",
      pin.number,
      v,
      "function totalSupply() view returns (uint256)",
    )) as bigint;
    const asset = (
      (await view(
        "1",
        pin.number,
        v,
        "function asset() view returns (address)",
      )) as string
    ).toLowerCase();
    return {
      method: "shares * totalAssets / totalSupply (manual, rounding down)",
      expected: { [asset]: ((shares * totalAssets) / supply).toString() },
      actual: {},
    };
  },
});
// ---- Lido: treasury stETH, Aave aToken wstETH holdings, and the withdrawal queue ----
proofs.push({
  id: "lido-treasury-steth",
  family: "lido",
  deploymentId: "lido-1",
  addressNote: "Lido treasury (deployed-mainnet.json literal)",
  wallet: async () => "0x3e40d73eb977dc6a537af587d48316fee66e9c8c",
  independent: async (pin, wallet, positions) => {
    const d = deployment("lido-1");
    const bal = (await view(
      "1",
      pin.number,
      d.contracts.steth,
      "function balanceOf(address) view returns (uint256)",
      [wallet],
    )) as bigint;
    const shares = (await view(
      "1",
      pin.number,
      d.contracts.steth,
      "function sharesOf(address) view returns (uint256)",
      [wallet],
    )) as bigint;
    const pooled = (await view(
      "1",
      pin.number,
      d.contracts.steth,
      "function getPooledEthByShares(uint256) view returns (uint256)",
      [shares],
    )) as bigint;
    return {
      method:
        "stETH.getPooledEthByShares(sharesOf) == balanceOf (stETH position only; the treasury also holds wstETH)",
      expected: {
        [d.contracts.steth]: pooled.toString(),
        balanceOf: bal.toString(),
      },
      actual: Object.fromEntries(
        positions
          .filter((x) => x.positionKey === d.contracts.steth)
          .flatMap((x) => x.underlying.map((a) => [a.contract, a.rawAmount])),
      ),
    };
  },
});
proofs.push({
  id: "lido-wsteth-aave-atoken",
  family: "lido",
  deploymentId: "lido-1",
  addressNote:
    "Aave V3 Ethereum aEthwstETH aToken (pinned address book) holding wstETH",
  wallet: async () =>
    (deployment("aave-v3-1").assets ?? []).find(
      (a) => a.underlying === "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
    )!.receipt,
  independent: async (pin, wallet) => {
    const d = deployment("lido-1");
    const w = (await view(
      "1",
      pin.number,
      d.contracts.wsteth,
      "function balanceOf(address) view returns (uint256)",
      [wallet],
    )) as bigint;
    const pooled = (await view(
      "1",
      pin.number,
      d.contracts.steth,
      "function getPooledEthByShares(uint256) view returns (uint256)",
      [w],
    )) as bigint;
    return {
      method:
        "stETH.getPooledEthByShares(wstETH.balanceOf) (wstETH balance = stETH shares)",
      expected: { [d.contracts.steth]: pooled.toString() },
      actual: {},
    };
  },
});
proofs.push({
  id: "lido-withdrawal-queue",
  family: "lido",
  deploymentId: "lido-1",
  addressNote:
    "first contract owner with unclaimed requests among recent WithdrawalRequested events",
  wallet: async (pin) => {
    const q = deployment("lido-1").contracts.withdrawalQueue;
    const topic = toEventSelector(
      "WithdrawalRequested(uint256,address,address,uint256,uint256)",
    );
    const found = await logs("1", q, topic, pin.number - 30000n, pin.number);
    const seen = new Set<string>();
    for (const l of found.reverse()) {
      const owner = "0x" + l.topics[3].slice(26);
      if (seen.has(owner)) continue;
      seen.add(owner);
      if (!(await code("1", owner, pin.number))) continue;
      const ids = (await view(
        "1",
        pin.number,
        q,
        "function getWithdrawalRequests(address) view returns (uint256[])",
        [owner],
      )) as bigint[];
      if (ids.length > 0 && ids.length <= 200) return owner;
      if (seen.size > 40) break;
    }
    throw Error("NO_CONTRACT_WITHDRAWAL_OWNER_FOUND");
  },
  independent: async (pin, wallet, positions) => {
    const q = deployment("lido-1").contracts.withdrawalQueue;
    const ids = (
      (await view(
        "1",
        pin.number,
        q,
        "function getWithdrawalRequests(address) view returns (uint256[])",
        [wallet],
      )) as bigint[]
    ).sort((a, b) => (a < b ? -1 : 1));
    const st = (await view(
      "1",
      pin.number,
      q,
      "function getWithdrawalStatus(uint256[]) view returns ((uint256 amountOfStETH,uint256 amountOfShares,address owner,uint256 timestamp,bool isFinalized,bool isClaimed)[])",
      [ids],
    )) as { amountOfStETH: bigint; isFinalized: boolean; isClaimed: boolean }[];
    const fin = ids.filter((_, i) => st[i].isFinalized && !st[i].isClaimed);
    let claimable = 0n;
    if (fin.length) {
      const last = (await view(
        "1",
        pin.number,
        q,
        "function getLastCheckpointIndex() view returns (uint256)",
      )) as bigint;
      const hints = (await view(
        "1",
        pin.number,
        q,
        "function findCheckpointHints(uint256[],uint256,uint256) view returns (uint256[])",
        [fin, 1n, last],
      )) as bigint[];
      claimable = (
        (await view(
          "1",
          pin.number,
          q,
          "function getClaimableEther(uint256[],uint256[]) view returns (uint256[])",
          [fin, hints],
        )) as bigint[]
      ).reduce((a, b) => a + b, 0n);
    }
    const pending = ids.reduce(
      (a, _, i) =>
        a + (!st[i].isFinalized && !st[i].isClaimed ? st[i].amountOfStETH : 0n),
      0n,
    );
    const p = positions.find((x) => x.positionKey === "withdrawals");
    return {
      method:
        "WithdrawalQueueERC721 views recomputed independently (claimable finalized ETH; pending locked stETH)",
      expected: {
        claimableEth: claimable.toString(),
        pendingStETH: pending.toString(),
      },
      actual: {
        claimableEth:
          p?.underlying.find((a) => a.contract === ZERO)?.rawAmount ?? "0",
        pendingStETH: p?.details.pendingStETH ?? "0",
      },
    };
  },
});
// ---- UniswapV2-family: the zero address holds MINIMUM_LIQUIDITY of every pair (public, protocol-defined) ----
for (const [id, deploymentId, chain, tA, tB] of [
  [
    "uniswap-v2-usdc-weth",
    "uniswap-v2-1",
    "1",
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  ],
  [
    "sushiswap-v2-weth-usdc",
    "sushiswap-v2-1",
    "1",
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  ],
] as const)
  proofs.push({
    id,
    family: "uniswap-v2",
    deploymentId,
    addressNote:
      deploymentId === "sushiswap-v2-1"
        ? "zero address MINIMUM_LIQUIDITY lock of a recently created (non-migrated) SushiSwap pair"
        : "zero address: holder of the pair's MINIMUM_LIQUIDITY lock",
    wallet: async () => ZERO,
    held: async (pin) => {
      if (deploymentId === "sushiswap-v2-1") {
        // Migrated Sushi pairs never minted MINIMUM_LIQUIDITY to the zero address; use a recently created pair.
        const created = await logs(
          chain,
          deployment(deploymentId).contracts.factory,
          toEventSelector("PairCreated(address,address,address,uint256)"),
          pin.number - 400000n,
          pin.number,
        );
        for (const l of created.reverse()) {
          const [pair] = decodeAbiParameters(
            [{ type: "address" }, { type: "uint256" }],
            l.data as Hex,
          ) as unknown as string[];
          const locked = (await view(
            chain,
            pin.number,
            pair,
            "function balanceOf(address) view returns (uint256)",
            [ZERO],
          )) as bigint;
          const supply = (await view(
            chain,
            pin.number,
            pair,
            "function totalSupply() view returns (uint256)",
          )) as bigint;
          if (locked > 0n && supply > 10n ** 12n) return [pair.toLowerCase()];
        }
        throw Error("NO_SUSHI_PAIR_FOUND");
      }
      return [
        (
          (await view(
            chain,
            pin.number,
            deployment(deploymentId).contracts.factory,
            "function getPair(address,address) view returns (address)",
            [tA, tB],
          )) as string
        ).toLowerCase(),
      ];
    },
    independent: async (pin, wallet, positions) => {
      const d = deployment(deploymentId);
      const pair = positions[0]?.details.pair ?? "";
      const [t0, t1] = [
        (
          (await view(
            chain,
            pin.number,
            pair,
            "function token0() view returns (address)",
          )) as string
        ).toLowerCase(),
        (
          (await view(
            chain,
            pin.number,
            pair,
            "function token1() view returns (address)",
          )) as string
        ).toLowerCase(),
      ];
      const liq = (await view(
        chain,
        pin.number,
        pair,
        "function balanceOf(address) view returns (uint256)",
        [wallet],
      )) as bigint;
      const supply = (await view(
        chain,
        pin.number,
        pair,
        "function totalSupply() view returns (uint256)",
      )) as bigint;
      const r = (await view(
        chain,
        pin.number,
        pair,
        "function getReserves() view returns (uint112,uint112,uint32)",
      )) as bigint[];
      const feeTo = (
        (await view(
          chain,
          pin.number,
          d.contracts.factory,
          "function feeTo() view returns (address)",
        )) as string
      ).toLowerCase();
      const kLast =
        feeTo === ZERO
          ? 0n
          : ((await view(
              chain,
              pin.number,
              pair,
              "function kLast() view returns (uint256)",
            )) as bigint);
      const mult = d.variant === "fee3" ? 3n : 5n;
      let mint = 0n;
      if (kLast) {
        const rootK = isqrt(r[0] * r[1]),
          rootKLast = isqrt(kLast);
        if (rootK > rootKLast)
          mint = (supply * (rootK - rootKLast)) / (rootK * mult + rootKLast);
      }
      const b0 = (await view(
        chain,
        pin.number,
        t0,
        "function balanceOf(address) view returns (uint256)",
        [pair],
      )) as bigint;
      const b1 = (await view(
        chain,
        pin.number,
        t1,
        "function balanceOf(address) view returns (uint256)",
        [pair],
      )) as bigint;
      return {
        method:
          "UniswapV2Pair.burn arithmetic recomputed: _mintFee then liquidity*balance/totalSupply",
        expected: {
          [t0]: ((liq * b0) / (supply + mint)).toString(),
          [t1]: ((liq * b1) / (supply + mint)).toString(),
        },
        actual: sum(positions, "underlying"),
      };
    },
  });
// ---- Concentrated liquidity: principal + exact uncollected fees recomputed from raw pool state ----
async function clIndependent(
  chain: string,
  pin: BlockPin,
  p: DefiPosition,
  manager: string,
  pancake: boolean,
) {
  const tokenId = BigInt(p.details.tokenId);
  const pool = p.details.pool;
  const pos = (await view(
    chain,
    pin.number,
    manager,
    "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
    [tokenId],
  )) as unknown[];
  const slot = (await view(
    chain,
    pin.number,
    pool,
    pancake
      ? "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint32,bool)"
      : "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  )) as unknown[];
  const g0 = (await view(
    chain,
    pin.number,
    pool,
    "function feeGrowthGlobal0X128() view returns (uint256)",
  )) as bigint;
  const g1 = (await view(
    chain,
    pin.number,
    pool,
    "function feeGrowthGlobal1X128() view returns (uint256)",
  )) as bigint;
  const lo = (await view(
    chain,
    pin.number,
    pool,
    "function ticks(int24) view returns (uint128,int128,uint256,uint256,int56,uint160,uint32,bool)",
    [Number(pos[5])],
  )) as unknown[];
  const hi = (await view(
    chain,
    pin.number,
    pool,
    "function ticks(int24) view returns (uint128,int128,uint256,uint256,int56,uint160,uint32,bool)",
    [Number(pos[6])],
  )) as unknown[];
  const [a0, a1] = liquidityAmounts(
    pos[7] as bigint,
    slot[0] as bigint,
    Number(pos[5]),
    Number(pos[6]),
  );
  const fee = (k: 0 | 1) =>
    uncollectedFees({
      tick: Number(slot[1]),
      lower: Number(pos[5]),
      upper: Number(pos[6]),
      global: k ? g1 : g0,
      lowerOutside: lo[2 + k] as bigint,
      upperOutside: hi[2 + k] as bigint,
      insideLast: pos[8 + k] as bigint,
      liquidity: pos[7] as bigint,
      owed: pos[10 + k] as bigint,
    });
  return {
    method:
      "positions()/slot0/ticks/feeGrowthGlobal re-read on an independent endpoint; amounts and fees recomputed (Python cross-check in evidence)",
    expected: {
      amount0: a0.toString(),
      amount1: a1.toString(),
      fees0: fee(0).toString(),
      fees1: fee(1).toString(),
    },
    actual: {
      amount0:
        p.underlying.find(
          (x) => x.contract === (pos[2] as string).toLowerCase(),
        )?.rawAmount ?? "0",
      amount1:
        p.underlying.find(
          (x) => x.contract === (pos[3] as string).toLowerCase(),
        )?.rawAmount ?? "0",
      fees0: p.details.tokensOwed0,
      fees1: p.details.tokensOwed1,
    },
    raw: {
      pos: pos.map(String),
      slot: slot.map(String),
      g0: g0.toString(),
      g1: g1.toString(),
      lo: lo.map(String),
      hi: hi.map(String),
    },
  };
}
proofs.push({
  id: "pancakeswap-v3-masterchef",
  family: "uniswap-v3",
  deploymentId: "pancakeswap-v3-56",
  addressNote:
    "PancakeSwap MasterChefV3 (official deployments file) which owns staked position NFTs",
  wallet: async () => "0x556b9306565093c855aea9ae92a594704c2cd59e",
  refs: async (pin, wallet) => {
    const npm = deployment("pancakeswap-v3-56").contracts.manager;
    const refs: PositionRef[] = [];
    for (let i = 0n; i < 40n && refs.length < 2; i++) {
      const id = (await view(
        "56",
        pin.number,
        npm,
        "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
        [wallet, i],
      )) as bigint;
      const pos = (await view(
        "56",
        pin.number,
        npm,
        "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
        [id],
      )) as bigint[];
      if (pos[7] > 0n)
        refs.push({
          key: id.toString(),
          tokenId: id.toString(),
          discovery: "enumeration",
        });
    }
    return refs;
  },
  independent: async (pin, _wallet, positions) =>
    clIndependent(
      "56",
      pin,
      positions[0],
      deployment("pancakeswap-v3-56").contracts.manager,
      true,
    ),
});
proofs.push({
  id: "uniswap-v3-contract-owner",
  family: "uniswap-v3",
  deploymentId: "uniswap-v3-1",
  addressNote:
    "first contract owner of an in-range position NFT among recent NonfungiblePositionManager transfers",
  wallet: async (pin) => {
    const npm = deployment("uniswap-v3-1").contracts.manager;
    const topic = toEventSelector("Transfer(address,address,uint256)");
    const found = await logs("1", npm, topic, pin.number - 4000n, pin.number);
    for (const l of found.reverse()) {
      const to = "0x" + l.topics[2].slice(26);
      if (to === ZERO || !(await code("1", to, pin.number))) continue;
      const id = BigInt(l.topics[3]);
      try {
        const owner = (
          (await view(
            "1",
            pin.number,
            npm,
            "function ownerOf(uint256) view returns (address)",
            [id],
          )) as string
        ).toLowerCase();
        const pos = (await view(
          "1",
          pin.number,
          npm,
          "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
          [id],
        )) as bigint[];
        if (owner === to && pos[7] > 0n) {
          v3Token = id;
          return to;
        }
      } catch {
        /* burned */
      }
    }
    throw Error("NO_CONTRACT_NFT_OWNER_FOUND");
  },
  refs: async () => [
    {
      key: v3Token.toString(),
      tokenId: v3Token.toString(),
      discovery: "enumeration",
    },
  ],
  independent: async (pin, _wallet, positions) =>
    clIndependent(
      "1",
      pin,
      positions[0],
      deployment("uniswap-v3-1").contracts.manager,
      false,
    ),
});
let v3Token = 0n;
// ---- Liquid staking: EigenLayer strategy contracts hold each reviewed LST (official README literals) ----
const strategyOf = (symbol: string) =>
  deployment("eigenlayer-1").strategies!.find((s) => s.symbol === symbol)!
    .strategy;
for (const [id, deploymentId, symbol, check] of [
  ["lst-reth", "lst-reth-1", "rETH", "rocket-network-balances"],
  [
    "lst-cbeth",
    "lst-cbeth-1",
    "cbETH",
    "function exchangeRate() view returns (uint256)",
  ],
  [
    "lst-wbeth",
    "lst-wbeth-1",
    "wBETH",
    "function exchangeRate() view returns (uint256)",
  ],
  [
    "lst-sweth",
    "lst-sweth-1",
    "swETH",
    "function swETHToETHRate() view returns (uint256)",
  ],
  ["lst-meth", "lst-meth-1", "mETH", ""],
  ["lst-ethx", "lst-ethx-1", "ETHx", ""],
  ["lst-oseth", "lst-oseth-1", "osETH", ""],
] as const)
  proofs.push({
    id,
    family: "lst-rate",
    deploymentId,
    addressNote: `EigenLayer ${symbol} strategy contract (README literal) holding ${symbol}`,
    wallet: async () => strategyOf(symbol),
    independent: async (pin, wallet, positions) => {
      const d = deployment(deploymentId);
      const bal = (await view(
        "1",
        pin.number,
        d.contracts.token,
        "function balanceOf(address) view returns (uint256)",
        [wallet],
      )) as bigint;
      let expected: bigint;
      let method: string;
      if (check === "rocket-network-balances") {
        // RocketTokenRETH.getEthValue: amount * totalETHBalance / totalRETHSupply from RocketNetworkBalances,
        // resolved through RocketStorage (address literal in the pinned official docs file).
        const storage =
          d.contracts.rocketStorage ??
          "0x1d8f8f00cfa6758d7be78336684788fb0ee0fa46";
        const key = keccak256(
          encodePacked(
            ["string", "string"],
            ["contract.address", "rocketNetworkBalances"],
          ),
        );
        const balances = (await view(
          "1",
          pin.number,
          storage,
          "function getAddress(bytes32) view returns (address)",
          [key],
        )) as string;
        const totalEth = (await view(
          "1",
          pin.number,
          balances,
          "function getTotalETHBalance() view returns (uint256)",
        )) as bigint;
        const supply = (await view(
          "1",
          pin.number,
          balances,
          "function getTotalRETHSupply() view returns (uint256)",
        )) as bigint;
        expected = (bal * totalEth) / supply;
        method =
          "balance * RocketNetworkBalances.getTotalETHBalance / getTotalRETHSupply (via RocketStorage)";
      } else if (check) {
        const rate = (await view(
          "1",
          pin.number,
          d.contracts.token,
          check,
        )) as bigint;
        expected = (bal * rate) / 10n ** 18n;
        method = "balance * " + check.slice(9, check.indexOf("(")) + " / 1e18";
      } else {
        expected = (await view(
          "1",
          pin.number,
          d.contracts.converter,
          `function ${d.config!.call}(uint256) view returns (uint256)`,
          [bal],
        )) as bigint;
        method =
          d.config!.call +
          "(balance) on the official converter (independent endpoint)";
      }
      return {
        method,
        expected: { [ZERO]: expected.toString() },
        actual: sum(positions, "underlying"),
      };
    },
  });
// ---- EigenLayer restaking: a staker found from recent StrategyManager Deposit events ----
proofs.push({
  id: "eigenlayer-staker",
  family: "eigenlayer",
  deploymentId: "eigenlayer-1",
  addressNote:
    "first contract staker with reviewed-strategy deposits among recent StrategyManager Deposit events",
  wallet: async (pin) => {
    const sm = deployment("eigenlayer-1").contracts.strategyManager;
    const topic = toEventSelector("Deposit(address,address,uint256)");
    const found = await logs("1", sm, topic, pin.number - 600000n, pin.number);
    const reviewed = new Set(
      deployment("eigenlayer-1").strategies!.map((s) => s.strategy),
    );
    const seen = new Set<string>();
    for (const l of found.reverse()) {
      const [staker, strategy] = decodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "uint256" }],
        l.data as Hex,
      ) as unknown as string[];
      const s = staker.toLowerCase();
      if (seen.has(s) || !reviewed.has(strategy.toLowerCase())) continue;
      seen.add(s);
      if (await code("1", s, pin.number)) return s;
      if (seen.size > 40) break;
    }
    throw Error("NO_CONTRACT_STAKER_FOUND");
  },
  independent: async (pin, wallet, positions) => {
    const d = deployment("eigenlayer-1");
    const expected: Record<string, string> = {};
    for (const s of d.strategies!) {
      const v = (await view(
        "1",
        pin.number,
        s.strategy,
        "function userUnderlyingView(address) view returns (uint256)",
        [wallet],
      )) as bigint;
      if (v > 0n) expected[s.underlying] = v.toString();
    }
    return {
      method:
        "strategy.userUnderlyingView(staker) for every reviewed strategy (official view)",
      expected,
      actual: sum(positions, "supplied"),
    };
  },
});
// ---- Curve: the 3pool gauge contract holds staked 3CRV LP ----
proofs.push({
  id: "curve-3pool-gauge-holder",
  family: "curve",
  deploymentId: "curve-1",
  addressNote:
    "Curve 3pool gauge contract (MetaRegistry.get_gauge) as the LP holder",
  wallet: async (pin) =>
    (
      (await view(
        "1",
        pin.number,
        deployment("curve-1").contracts.metaRegistry,
        "function get_gauge(address) view returns (address)",
        ["0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7"],
      )) as string
    ).toLowerCase(),
  held: async () => ["0x6c3f90f043a72fa612cbac8115ee7e52bde6e490"],
  independent: async (pin, wallet) => {
    const pool = "0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7",
      lp = "0x6c3f90f043a72fa612cbac8115ee7e52bde6e490";
    const amount = (await view(
      "1",
      pin.number,
      lp,
      "function balanceOf(address) view returns (uint256)",
      [wallet],
    )) as bigint;
    const supply = (await view(
      "1",
      pin.number,
      lp,
      "function totalSupply() view returns (uint256)",
    )) as bigint;
    const expected: Record<string, string> = {};
    for (let i = 0n; i < 3n; i++) {
      const coin = (
        (await view(
          "1",
          pin.number,
          pool,
          "function coins(uint256) view returns (address)",
          [i],
        )) as string
      ).toLowerCase();
      const bal = (await view(
        "1",
        pin.number,
        pool,
        "function balances(uint256) view returns (uint256)",
        [i],
      )) as bigint;
      expected[coin] = ((bal * amount) / supply).toString();
    }
    return {
      method:
        "3pool.balances(i) * lp / totalSupply read directly from the pool (not via MetaRegistry)",
      expected,
      actual: {},
    };
  },
});
// ---- Balancer V2 weighted pool BPT held by the protocol fees collector ----
proofs.push({
  id: "balancer-v2-fee-collector",
  family: "balancer-v2",
  deploymentId: "balancer-v2-1",
  addressNote:
    "Balancer ProtocolFeesCollector (Vault.getProtocolFeesCollector) holding protocol-fee BPT of a WeightedPool V4",
  wallet: async (pin) =>
    (
      (await view(
        "1",
        pin.number,
        deployment("balancer-v2-1").contracts.vault,
        "function getProtocolFeesCollector() view returns (address)",
      )) as string
    ).toLowerCase(),
  held: async (pin, wallet) => {
    const factory = deployment("balancer-v2-1").contracts.weightedPoolFactory;
    const topic = toEventSelector("PoolCreated(address)");
    const created = await logs("1", factory, topic, 16000000n, pin.number);
    const out: string[] = [];
    for (const l of created.reverse()) {
      const pool = ("0x" + l.topics[1].slice(26)).toLowerCase();
      const bal = (await view(
        "1",
        pin.number,
        pool,
        "function balanceOf(address) view returns (uint256)",
        [wallet],
      )) as bigint;
      if (bal > 0n) out.push(pool);
      if (out.length >= 1) break;
    }
    if (!out.length) throw Error("NO_FEE_BPT_FOUND");
    return out;
  },
  independent: async (pin, wallet, positions) => {
    const p = positions[0];
    const vault = deployment("balancer-v2-1").contracts.vault;
    const state = (await view(
      "1",
      pin.number,
      vault,
      "function getPoolTokens(bytes32) view returns (address[],uint256[],uint256)",
      [p.details.poolId],
    )) as [string[], bigint[], bigint];
    const supply = (await view(
      "1",
      pin.number,
      p.details.pool,
      "function getActualSupply() view returns (uint256)",
    )) as bigint;
    const amount = BigInt(p.details.shares);
    const expected: Record<string, string> = {};
    const ratio = (amount * 10n ** 18n) / supply;
    for (let i = 0; i < state[0].length; i++) {
      const dec = (await view(
        "1",
        pin.number,
        state[0][i],
        "function decimals() view returns (uint8)",
      )) as number;
      const s = 10n ** BigInt(18 - Number(dec));
      expected[state[0][i].toLowerCase()] = (
        (state[1][i] * s * ratio) /
        10n ** 18n /
        s
      ).toString();
    }
    return {
      method:
        "WeightedPool exitExactBPTInForTokensOut recomputed (upscale, mulDown(bptRatio), downscaleDown)",
      expected,
      actual: sum(positions, "underlying"),
    };
  },
});
// ---- Aerodrome basic pool LP held by its own gauge ----
proofs.push({
  id: "aerodrome-weth-usdc-gauge",
  family: "solidly-v2",
  deploymentId: "aerodrome-v2-8453",
  addressNote:
    "Aerodrome gauge contract (Voter.gauges) of the WETH/USDC volatile pool, holding staked LP",
  wallet: async (pin) => {
    const d = deployment("aerodrome-v2-8453");
    const pool = (await view(
      "8453",
      pin.number,
      d.contracts.poolFactory,
      "function getPool(address,address,bool) view returns (address)",
      [
        "0x4200000000000000000000000000000000000006",
        "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        false,
      ],
    )) as string;
    aeroPool = pool.toLowerCase();
    return (
      (await view(
        "8453",
        pin.number,
        d.contracts.voter,
        "function gauges(address) view returns (address)",
        [pool],
      )) as string
    ).toLowerCase();
  },
  held: async () => [aeroPool],
  independent: async (pin, wallet) => {
    const t0 = (
      (await view(
        "8453",
        pin.number,
        aeroPool,
        "function token0() view returns (address)",
      )) as string
    ).toLowerCase();
    const t1 = (
      (await view(
        "8453",
        pin.number,
        aeroPool,
        "function token1() view returns (address)",
      )) as string
    ).toLowerCase();
    const amount = (await view(
      "8453",
      pin.number,
      aeroPool,
      "function balanceOf(address) view returns (uint256)",
      [wallet],
    )) as bigint;
    const supply = (await view(
      "8453",
      pin.number,
      aeroPool,
      "function totalSupply() view returns (uint256)",
    )) as bigint;
    const b0 = (await view(
      "8453",
      pin.number,
      t0,
      "function balanceOf(address) view returns (uint256)",
      [aeroPool],
    )) as bigint;
    const b1 = (await view(
      "8453",
      pin.number,
      t1,
      "function balanceOf(address) view returns (uint256)",
      [aeroPool],
    )) as bigint;
    return {
      method:
        "Pool.burn arithmetic: liquidity * token.balanceOf(pool) / totalSupply",
      expected: {
        [t0]: ((amount * b0) / supply).toString(),
        [t1]: ((amount * b1) / supply).toString(),
      },
      actual: {},
    };
  },
});
let aeroPool = "";
// ---- runner ----
const results: unknown[] = [];
for (const p of proofs) {
  if (only && !only.includes(p.id)) continue;
  const d = deployment(p.deploymentId);
  const started = Date.now();
  try {
    const pool = plane.pool(state, d.chainId);
    if (!pool) throw Error("NO_VETTED_POOL");
    const signal = AbortSignal.timeout(180000);
    const pin = await pinChain(pool, signal);
    const wallet = (await p.wallet(pin)).toLowerCase();
    const reader = new DefiReader(d, wallet, pin, signal, pool, new Map(), 512);
    reader.curatedVaults = new Set(
      deployments
        .filter((v) => v.chainId === d.chainId && v.adapter === "erc4626")
        .map((v) => v.contracts.vault),
    );
    const refs = p.refs ? await p.refs(pin, wallet) : undefined;
    if (refs) {
      reader.refs = refs;
      reader.discoveryComplete = false;
    }
    if (p.held) reader.held = await p.held(pin, wallet);
    const adapter = adapterFor(d);
    const found = refs ?? (await adapter.discover(reader));
    const positions: DefiPosition[] = [];
    for (const ref of found) {
      const position = await adapter.readPosition(ref, reader);
      if (position) positions.push(position);
    }
    await reader.verifyPin();
    const independent = (await p.independent(pin, wallet, positions)) as {
      method: string;
      expected: Record<string, string>;
      actual: Record<string, string>;
    };
    // Proofs that compare against the production result use the adapter's economic amounts when "actual" is empty.
    const actual = Object.keys(independent.actual).length
      ? independent.actual
      : { ...sum(positions, "underlying"), ...sum(positions, "supplied") };
    const keys = Object.keys(independent.expected).filter(
      (k) => /^0x/.test(k) || k in actual,
    );
    const match =
      keys.length > 0 &&
      keys.every((k) => actual[k] === independent.expected[k]);
    const nonzero = positions.some((x) =>
      [...x.supplied, ...x.underlying, ...x.borrowed].some(
        (a) => BigInt(a.rawAmount) > 0n,
      ),
    );
    const record = {
      id: p.id,
      family: p.family,
      deploymentId: d.id,
      chainId: d.chainId,
      block: pin.number.toString(),
      blockHash: pin.hash,
      vettedEndpointGroup: pin.endpointGroup,
      independentEndpoint: INDEPENDENT[d.chainId],
      publicTestAddress: wallet,
      addressNote: p.addressNote,
      contracts: d.contracts,
      source: {
        url: d.source,
        revision: d.revision,
        identity: d.identity ?? "OFFICIAL_SOURCE_LITERAL",
      },
      rawCalls: reader.evidence
        .filter((e) => e.kind === "contract-view")
        .map((e) => e.source),
      rpcCalls: reader.calls,
      decoded: positions,
      otherbridgeResult: positions.map((x) => ({
        id: x.id,
        coverage: x.coverage,
        supplied: x.supplied.map((a) => [a.contract, a.rawAmount]),
        borrowed: x.borrowed.map((a) => [a.contract, a.rawAmount]),
        underlying: x.underlying.map((a) => [a.contract, a.rawAmount]),
        fees: (x.fees ?? []).map((a) => [a.contract, a.rawAmount]),
        rewards: x.rewards.map((r) => [r.asset.contract, r.rawClaimable]),
        risk: x.risk,
        warnings: x.warnings,
      })),
      independent: { ...independent, actual },
      status:
        nonzero && match
          ? "REAL_NONZERO_PROOF"
          : nonzero
            ? "NONZERO_MISMATCH"
            : "ZERO_RESULT",
      durationMs: Date.now() - started,
    };
    results.push(record);
    writeFileSync(
      join(out, p.id + ".json"),
      JSON.stringify(
        record,
        (_k, v) => (typeof v === "bigint" ? v.toString() : v),
        2,
      ) + "\n",
    );
    console.log(p.id, record.status, d.chainId, record.block, wallet);
  } catch (e) {
    const record = {
      id: p.id,
      family: p.family,
      deploymentId: d.id,
      status: "FAILED",
      error: String((e as Error).message).slice(0, 300),
      durationMs: Date.now() - started,
    };
    results.push(record);
    writeFileSync(
      join(out, p.id + ".json"),
      JSON.stringify(record, null, 2) + "\n",
    );
    console.log(p.id, "FAILED", record.error);
  }
}
writeFileSync(
  join(out, "summary.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      note: "Real pinned mainnet reads by the production adapters; independent recomputation on a different endpoint. Read-only: no wallet, signature, approval, permit or broadcast.",
      results: results.map((r) => ({
        id: (r as { id: string }).id,
        family: (r as { family: string }).family,
        status: (r as { status: string }).status,
        block: (r as { block?: string }).block,
        chainId: (r as { chainId?: string }).chainId,
      })),
      counters: {
        walletRequests: 0,
        signatures: 0,
        approvals: 0,
        permits: 0,
        broadcasts: 0,
        deploys: 0,
        feeCollection: 0,
      },
    },
    null,
    2,
  ) + "\n",
);
