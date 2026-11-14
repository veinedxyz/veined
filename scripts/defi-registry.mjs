import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const sources = JSON.parse(
  readFileSync("src/defi/sources/manifest.json", "utf8"),
);
const deployments = [];
const aaveChains = {
  Ethereum: "1",
  Arbitrum: "42161",
  Optimism: "10",
  Base: "8453",
  Polygon: "137",
  Avalanche: "43114",
  BNB: "56",
  Gnosis: "100",
  Metis: "1088",
  Scroll: "534352",
  Sonic: "146",
  ZkSync: "324",
  Linea: "59144",
  Celo: "42220",
  Mantle: "5000",
  Soneium: "1868",
  Plasma: "9745",
};
function add(
  s,
  id,
  protocolId,
  name,
  chainId,
  adapter,
  category,
  contracts,
  extra = {},
) {
  deployments.push({
    id,
    protocolId,
    name,
    chainId,
    adapter,
    category,
    contracts,
    source: s.url,
    revision: s.revision,
    status: "active",
    environment: "mainnet",
    ...extra,
  });
}
for (const s of sources) {
  const t = readFileSync("src/defi/sources/" + s.local, "utf8");
  if (createHash("sha256").update(t).digest("hex") !== s.sha256)
    throw Error("SOURCE_HASH_MISMATCH");
  const a = /src\/AaveV3(\w+)\.sol$/.exec(s.path);
  if (a && aaveChains[a[1]]) {
    const get = (k) =>
      new RegExp(
        "constant " + k + "\\s*=\\s*(?:\\w+\\()?\\s*(0x[0-9a-fA-F]{40})",
      )
        .exec(t)?.[1]
        .toLowerCase();
    const assets = [
      ...t.matchAll(/constant (\w+)_UNDERLYING\s*=\s*(0x[0-9a-fA-F]{40})/g),
    ]
      .map((m) => ({
        symbol: m[1],
        underlying: m[2].toLowerCase(),
        receipt: get(m[1] + "_A_TOKEN"),
        debt: get(m[1] + "_V_TOKEN"),
        decimals: Number(
          new RegExp("constant " + m[1] + "_DECIMALS = (\\d+)").exec(t)?.[1],
        ),
      }))
      .filter((a) => a.receipt && a.debt && Number.isInteger(a.decimals));
    add(
      s,
      "aave-v3-" + aaveChains[a[1]],
      "aave-v3",
      "Aave V3",
      aaveChains[a[1]],
      "aave-v3",
      "lending",
      {
        pool: get("POOL"),
        provider: get("AAVE_PROTOCOL_DATA_PROVIDER"),
        addressesProvider: get("POOL_ADDRESSES_PROVIDER"),
        incentives: get("DEFAULT_INCENTIVES_CONTROLLER"),
      },
      { assets },
    );
  }
  const c =
    /deployments\/(mainnet|base|arbitrum|optimism|polygon|unichain)\/([^/]+)\/roots.json$/.exec(
      s.path,
    );
  if (c) {
    const j = JSON.parse(t),
      id = {
        mainnet: "1",
        base: "8453",
        arbitrum: "42161",
        optimism: "10",
        polygon: "137",
        unichain: "130",
      }[c[1]];
    add(
      s,
      "compound-" + id + "-" + c[2].replace(".", "-"),
      "compound-iii",
      "Compound III",
      id,
      "compound-iii",
      "lending",
      { comet: j.comet.toLowerCase() },
    );
  }
  if (s.repo === "Uniswap/contracts") {
    const id = /deployments\/(\d+)\.md/.exec(s.path)?.[1];
    if (!id) continue;
    const addr = (n) =>
      new RegExp("<td>" + n + "</td>\\s*<td>[^\\n]*?(0x[0-9a-fA-F]{40})")
        .exec(t)?.[1]
        ?.toLowerCase();
    const factory = addr("UniswapV3Factory"),
      manager = addr("NonfungiblePositionManager"),
      v2 = addr("UniswapV2Factory");
    if (factory && manager)
      add(
        s,
        "uniswap-v3-" + id,
        "uniswap-v3",
        "Uniswap V3",
        id,
        "uniswap-v3",
        "liquidity",
        { factory, manager },
      );
    if (v2)
      add(
        s,
        "uniswap-v2-" + id,
        "uniswap-v2",
        "Uniswap V2",
        id,
        "uniswap-v2",
        "liquidity",
        { factory: v2 },
      );
  }
  if (s.path === "packages/morpho-ts/src/addresses.ts") {
    const chains = {
      EthMainnet: "1",
      BaseMainnet: "8453",
      PolygonMainnet: "137",
      ArbitrumMainnet: "42161",
      OptimismMainnet: "10",
      WorldChainMainnet: "480",
      FraxtalMainnet: "252",
      ScrollMainnet: "534352",
      InkMainnet: "57073",
      Unichain: "130",
      SonicMainnet: "146",
      ModeMainnet: "34443",
      LineaMainnet: "59144",
      BscMainnet: "56",
      CeloMainnet: "42220",
      SoneiumMainnet: "1868",
    };
    for (const [key, id] of Object.entries(chains)) {
      const block = new RegExp(
        "\\[ChainId\\." +
          key +
          "\\]: \\{([\\s\\S]*?)(?=\\n  \\[ChainId\\.|\\n} as)",
      ).exec(t)?.[1];
      if (!block) continue;
      const get = (k) =>
        new RegExp("\\b" + k + ':\\s*"(0x[0-9a-fA-F]{40})"')
          .exec(block)?.[1]
          .toLowerCase();
      const blue = get("blue"),
        irm = get("adaptiveCurveIrm"),
        factory = get("metaMorphoFactory"),
        oracleFactory = get("chainlinkOracleFactory");
      // V1.14: deployment blocks from the same pinned official registry (`_deployments`) start the backfill lanes.
      const deployed = new RegExp(
        "\\[ChainId\\." +
          key +
          "\\]: \\{([\\s\\S]*?)(?=\\n  \\[ChainId\\.|\\n} as)",
      ).exec(t.slice(t.indexOf("const _deployments")))?.[1];
      const deployBlock = (k) =>
        deployed
          ? new RegExp("\\b" + k + ":\\s*([\\d_]+)n")
              .exec(deployed)?.[1]
              ?.replaceAll("_", "")
          : undefined;
      if (blue && irm)
        add(
          s,
          "morpho-blue-" + id,
          "morpho-blue",
          "Morpho Blue",
          id,
          "morpho-blue",
          "lending",
          { blue, irm, ...(oracleFactory ? { oracleFactory } : {}) },
          deployBlock("blue") ? { startBlock: deployBlock("blue") } : {},
        );
      if (factory)
        add(
          s,
          "morpho-vault-" + id,
          "morpho-vault",
          "Morpho Vaults V1",
          id,
          "morpho-vault",
          "vault",
          { factory },
          deployBlock("metaMorphoFactory")
            ? { startBlock: deployBlock("metaMorphoFactory") }
            : {},
        );
    }
  }
  if (s.repo === "sky-ecosystem/sdai" && s.path === "README.md") {
    const core =
      /Mainnet\]\(https:\/\/etherscan.io\/address\/(0x[0-9a-fA-F]{40})/
        .exec(t)?.[1]
        .toLowerCase();
    if (core)
      add(
        s,
        "erc4626-sdai-1",
        "erc4626",
        "Sky Savings DAI",
        "1",
        "erc4626",
        "vault",
        { vault: core },
      );
  }
}
const lido = sources.find(
  (s) =>
    s.repo === "lidofinance/core" && s.path === "contracts/0.6.12/WstETH.sol",
);
// V1.14: the withdrawal queue address is read from the pinned official deployment file, not typed by hand.
const lidoDeployed = sources.find(
  (s) => s.repo === "lidofinance/core" && s.path === "deployed-mainnet.json",
);
const lidoJson = JSON.parse(
  readFileSync("src/defi/sources/" + lidoDeployed.local, "utf8"),
);
add(lido, "lido-1", "lido", "Lido", "1", "lido", "staking", {
  steth: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
  wsteth: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
  withdrawalQueue: lidoJson.withdrawalQueueERC721.proxy.address.toLowerCase(),
});
// V1.14 SparkLend (Aave V3 fork with the same IPool / PoolDataProvider semantics). Every address is a literal in the
// pinned official spark-address-registry. Reserve symbol/decimals come from the pinned Aave address book entry of the
// SAME underlying contract (matched by address, never by symbol); reserves without such a match are left out, so the
// adapter reports them as unchecked reserves instead of guessing decimals.
const sparkSource = (path) =>
  sources.find(
    (s) => s.repo === "sparkdotfi/spark-address-registry" && s.path === path,
  );
const constantsOf = (s) =>
  Object.fromEntries(
    [
      ...readFileSync("src/defi/sources/" + s.local, "utf8").matchAll(
        /constant (\w+)\s*=\s*(0x[0-9a-fA-F]{40})/g,
      ),
    ].map((m) => [m[1], m[2].toLowerCase()]),
  );
const aaveReserves = (chain) => {
  const s = sources.find(
    (x) =>
      x.repo === "aave-dao/aave-address-book" &&
      x.path === `src/AaveV3${chain}.sol`,
  );
  const t = readFileSync("src/defi/sources/" + s.local, "utf8");
  return new Map(
    [...t.matchAll(/constant (\w+)_UNDERLYING\s*=\s*(0x[0-9a-fA-F]{40})/g)].map(
      (m) => [
        m[2].toLowerCase(),
        {
          symbol: m[1],
          decimals: Number(
            new RegExp("constant " + m[1] + "_DECIMALS = (\\d+)").exec(t)?.[1],
          ),
        },
      ],
    ),
  );
};
for (const [chainId, corePath, tokenPath, aaveChain] of [
  ["1", "src/SparkLend.sol", "src/Ethereum.sol", "Ethereum"],
  ["100", "src/Gnosis.sol", "src/Gnosis.sol", "Gnosis"],
]) {
  const core = sparkSource(corePath);
  const c = constantsOf(core),
    tokens = constantsOf(sparkSource(tokenPath)),
    book = aaveReserves(aaveChain);
  const assets = Object.keys(c)
    .filter((k) => /^[A-Z0-9]+_(SPTOKEN|ATOKEN)$/.test(k))
    .map((k) => {
      const key = k.replace(/_(SPTOKEN|ATOKEN)$/, "");
      const underlying = tokens[key];
      const meta = underlying ? book.get(underlying) : undefined;
      return {
        symbol: meta?.symbol,
        underlying,
        receipt: c[k],
        debt: c[key + "_DEBT_TOKEN"],
        decimals: meta?.decimals,
      };
    })
    .filter(
      (a) => a.underlying && a.debt && a.symbol && Number.isInteger(a.decimals),
    );
  add(
    core,
    "sparklend-" + chainId,
    "sparklend",
    "SparkLend",
    chainId,
    "aave-v3",
    "lending",
    {
      pool: c.POOL,
      provider: c.PROTOCOL_DATA_PROVIDER,
      addressesProvider: c.POOL_ADDRESSES_PROVIDER,
      incentives: c.INCENTIVES,
    },
    { assets, identity: "OFFICIAL_SOURCE_LITERAL" },
  );
}
// V1.14 reviewed deployments: every contract must appear literally in its pinned, hash-checked official source file,
// or be listed under `derived` with an explicit on-chain derivation (identity recorded as ONCHAIN_DERIVED).
const spec = JSON.parse(
  readFileSync("src/defi/sources/v114-deployments.spec.json", "utf8"),
);
for (const e of spec.deployments) {
  const s = sources.find((x) => x.local === e.source);
  if (!s) throw Error("SPEC_SOURCE_MISSING:" + e.id);
  const text = readFileSync(
    "src/defi/sources/" + s.local,
    "utf8",
  ).toLowerCase();
  for (const [k, address] of Object.entries(e.contracts))
    if (!text.includes(address) && !e.derived?.[k])
      throw Error("SPEC_ADDRESS_NOT_IN_SOURCE:" + e.id + ":" + k);
  for (const st of e.strategies ?? [])
    if (!text.includes(st.strategy))
      throw Error("SPEC_STRATEGY_NOT_IN_SOURCE:" + e.id + ":" + st.symbol);
  add(
    s,
    e.id,
    e.protocolId,
    e.name,
    e.chainId,
    e.adapter,
    e.category,
    e.contracts,
    {
      ...(e.variant ? { variant: e.variant } : {}),
      ...(e.config ? { config: e.config } : {}),
      ...(e.strategies ? { strategies: e.strategies } : {}),
      identity: e.derived ? "ONCHAIN_DERIVED" : "OFFICIAL_SOURCE_LITERAL",
      ...(e.derived ? { derivation: e.derived } : {}),
    },
  );
}
for (const d of deployments)
  if (Object.values(d.contracts).some((a) => !/^0x[0-9a-f]{40}$/.test(a)))
    throw Error("INVALID_CONTRACT:" + d.id);
writeFileSync(
  "src/defi/deployments.generated.json",
  JSON.stringify(
    {
      version: 1,
      generatedAt: sources.reduce(
        (latest, s) => (s.fetchedAt > latest ? s.fetchedAt : latest),
        "",
      ),
      deployments,
    },
    null,
    2,
  ) + "\n",
);
console.log({
  deployments: deployments.length,
  chains: new Set(deployments.map((d) => d.chainId)).size,
});
