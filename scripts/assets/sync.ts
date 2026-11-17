// V1.11 asset & chain registry sync jobs (READ-ONLY toward every upstream; writes only local registry files,
// sanitized local images and evidence). Usage:
//   pnpm assets:sync:chains | assets:sync:trustwallet | assets:sync:coingecko | assets:sync:dexscreener |
//   assets:sync:routing | assets:sync:onebridge | assets:build | assets:verify | assets:coverage | assets:sync:all
// Every network request goes through src/assets/safe-fetch.ts (https, exact host allowlist, public DNS pinned,
// bounded redirects/bytes/time) and every image through src/assets/image-sanitize.ts. Nothing is matched by symbol
// or name: chains by exact chain id, tokens by exact chain + contract.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import routingSnapshot from "../../src/routing/catalog-snapshot.json" with { type: "json" };
import tvlSnapshot from "../../src/catalog/snapshot.json" with { type: "json" };
import { normalizeChains } from "../../src/routing/catalog";
import type { Network } from "../../src/routing/model";
import { safeGet, safeJsonParse } from "../../src/assets/safe-fetch";
import { sanitizeImage } from "../../src/assets/image-sanitize";
import {
  environmentOf,
  shortNameOf,
  type ChainIdentity,
  type ChainIdentityFile,
  type ClientChainIdentity,
} from "../../src/registry/chain-identity";
import {
  assetKey,
  displayText,
  flagImpersonation,
  isEvmAddress,
  textRisk,
  type RegistryAsset,
} from "../../src/assets/model";
import { DEXSCREENER_CHAINS } from "../../src/assets/sources/dexscreener";
import { closeRasterizer, rasterizeJpeg } from "./rasterize";
import { getAddress } from "viem";
import { validAddress } from "../../src/routing/addresses";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NOW = new Date().toISOString();
const evidenceRoot = (() => {
  const at = process.argv.indexOf("--evidence-root");
  if (at >= 0) {
    const root = process.argv[at + 1];
    if (!root || !/^evidence\/otherbridge-v1-12\/[A-Za-z0-9._-]+$/.test(root))
      throw new Error("BAD_ASSET_EVIDENCE_ROOT");
    const dir = join(REPO, root, "asset-sync", NOW.replace(/[-:.]/g, ""));
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  const p = join(REPO, ".otherbridge", "v111-evidence-path.txt");
  const base = existsSync(p)
    ? readFileSync(p, "utf8").trim()
    : "evidence/otherbridge-v1-11/adhoc";
  const dir = join(REPO, base, "asset-sync");
  mkdirSync(dir, { recursive: true });
  return dir;
})();
const OUT = {
  chains: join(REPO, "src/registry/chain-identities.generated.json"),
  chainsClient: join(REPO, "src/registry/chain-identities.client.json"),
  trustwallet: join(REPO, "src/assets/sources/trustwallet.generated.json"),
  coingecko: join(REPO, "src/assets/sources/coingecko.generated.json"),
  dexscreener: join(REPO, "src/assets/sources/dexscreener.generated.json"),
  routing: join(REPO, "src/assets/sources/routing.generated.json"),
  onebridge: join(REPO, "src/assets/onebridge-pairs.generated.json"),
  registry: join(REPO, "src/assets/registry.generated.json"),
  coverage: join(REPO, "src/assets/coverage.generated.json"),
  chainLogos: join(REPO, "public/assets/chains"),
  tokenLogos: join(REPO, "public/assets/tokens"),
};
const sha = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
const write = (p: string, v: unknown) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 1) + "\n");
};
const read = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
const raw = (name: string, body: Buffer | string) => {
  const p = join(evidenceRoot, "raw", name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  return { file: relative(REPO, p).replaceAll("\\", "/"), sha256: sha(body) };
};
const HOSTS = {
  ethereumLists: ["chainid.network"],
  github: ["raw.githubusercontent.com"],
  coingecko: ["api.coingecko.com", "pro-api.coingecko.com"],
  coingeckoImages: ["coin-images.coingecko.com", "assets.coingecko.com"],
  dexscreener: ["api.dexscreener.com"],
  routing: ["li.quest"],
  onebridgeApi: ["bridge-api.crosstoken.io"],
};
async function getJson(
  url: string,
  hosts: readonly string[],
  maxBytes: number,
  rawName?: string,
  headers?: Record<string, string>,
) {
  const r = await safeGet(url, {
    allowedHosts: hosts,
    maxBytes,
    timeoutMs: 60_000,
    accept: "application/json",
    headers,
  });
  const evidence = rawName ? raw(rawName, r.body) : null;
  return { json: safeJsonParse(r.body.toString("utf8")), evidence, url };
}
// Logo ingestion: fetch (safe), sanitize (decode/re-encode), store under a content-addressed same-origin path.
async function ingestLogo(
  url: string,
  hosts: readonly string[],
  dir: string,
  base: string,
  size = 64,
) {
  const r = await safeGet(url, {
    allowedHosts: hosts,
    maxBytes: 600_000,
    timeoutMs: 20_000,
    accept: "image/png,image/webp",
  });
  let s = sanitizeImage(r.body, { outputSize: size });
  let via = "sanitized";
  // JPEG (no in-process codec): sandboxed offline Chromium decodes, our encoder re-encodes, the sanitizer re-checks.
  if (!s.ok && s.reason === "UNSUPPORTED_FORMAT") {
    const j = await rasterizeJpeg(r.body, size);
    if (j) {
      s = { ...j, sourceSha256: s.sourceSha256 };
      via = "jpeg-rasterized";
    }
  }
  if (!s.ok)
    return {
      ok: false as const,
      reason: s.reason,
      url,
      sourceSha256: s.sourceSha256,
    };
  const name = `${base}-${s.sha256.slice(0, 16)}.${s.format}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), s.bytes);
  return {
    ok: true as const,
    path:
      "/" +
      relative(join(REPO, "public"), join(dir, name)).replaceAll("\\", "/"),
    sha256: s.sha256,
    sourceSha256: s.sourceSha256,
    url,
    via,
    dropped: s.dropped,
  };
}
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

const routing: Network[] = normalizeChains(
  (routingSnapshot as { chains: unknown }).chains,
);
const evmRouting = routing.filter(
  (n) => n.ecosystem === "EVM" && n.provider === "routing-core",
);

// ------------------------------------------------------------------------------------------------ Trust Wallet map
type TwEntry = {
  id: string;
  chainId?: string | number;
  blockchain?: string;
  coinId?: number;
  explorer?: { url?: string };
  name?: string;
  displayName?: string;
  symbol?: string;
};
async function trustWalletChains() {
  const { json, evidence } = await getJson(
    "https://raw.githubusercontent.com/trustwallet/wallet-core/master/registry.json",
    HOSTS.github,
    2_000_000,
    "trustwallet/wallet-core-registry.json",
  );
  const entries = (json as TwEntry[]).filter(
    // EVM family only: the registry also has non-EVM coins with colliding numeric chain ids (e.g. Aptos "1").
    (e) =>
      e.blockchain === "Ethereum" && /^\d{1,18}$/.test(String(e.chainId ?? "")),
  );
  const byChain = new Map<string, TwEntry[]>();
  for (const e of entries)
    byChain.set(String(e.chainId), [
      ...(byChain.get(String(e.chainId)) ?? []),
      e,
    ]);
  return { byChain, evidence };
}
async function twAssetsFolder(candidates: TwEntry[]) {
  // Exactly one candidate with an assets/info folder; several => ambiguous => no Trust Wallet source.
  const ok: TwEntry[] = [];
  for (const e of candidates) {
    try {
      await safeGet(
        `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${e.id}/info/info.json`,
        {
          allowedHosts: HOSTS.github,
          maxBytes: 200_000,
          timeoutMs: 15_000,
        },
      );
      ok.push(e);
    } catch {
      /* folder missing */
    }
  }
  return ok.length === 1 ? ok[0] : null;
}

// ------------------------------------------------------------------------------------------------ chains
const NON_EVM: Record<
  string,
  { caip2: string; explorer: string; short: string }
> = {
  "1151111081099710": {
    caip2: "solana:mainnet",
    explorer: "https://explorer.solana.com",
    short: "Solana",
  },
  "20000000000001": {
    caip2: "bip122:000000000019d6689c085ae165831e93",
    explorer: "https://mempool.space",
    short: "Bitcoin",
  },
  "20000000000005": {
    caip2: "bip122:00040fe8ec8471911baa1db1266ea15d",
    explorer: "https://mainnet.zcashexplorer.app",
    short: "Zcash",
  },
  "9270000000000000": {
    caip2: "sui:mainnet",
    explorer: "https://suiscan.xyz/mainnet",
    short: "Sui",
  },
  "728126428": {
    caip2: "tron:mainnet",
    explorer: "https://tronscan.org",
    short: "Tron",
  },
  "1201081091099710": {
    caip2: "stellar:pubnet",
    explorer: "https://stellar.expert/explorer/public",
    short: "Stellar",
  },
};
// Mirrors the reviewed alias table of src/catalog/model.ts (TVL rows without a chain id).
const TVL_ALIASES: Record<string, string> = {
  binance: "56",
  bsc: "56",
  "binance smart chain": "56",
  ethereum: "1",
  base: "8453",
  solana: "1151111081099710",
  arbitrum: "42161",
  "arbitrum one": "42161",
  polygon: "137",
  "polygon pos": "137",
  optimism: "10",
  bitcoin: "20000000000001",
  sui: "9270000000000000",
  tron: "728126428",
  stellar: "148",
};
const OFFICIAL: Record<string, { explorer: string; provenance: string }> = {
  "612055": {
    explorer: "https://explorer.onechain.nexus/612055",
    provenance:
      "Official ONE Docs SVG (docs/NETWORK_IDENTITY.md; sha256 8afac25a…)",
  },
  "56": {
    explorer: "https://bscscan.com",
    provenance:
      "Official BNB Chain brand guideline symbol (docs/NETWORK_IDENTITY.md; sha256 b8ff1ce0…)",
  },
};
async function syncChains() {
  log(
    "chains: ethereum-lists, Trust Wallet registry, CoinGecko asset platforms",
  );
  const eth = await getJson(
    "https://chainid.network/chains.json",
    HOSTS.ethereumLists,
    5_000_000,
    "ethereum-lists/chains.json",
  );
  type El = {
    chainId: number;
    name: string;
    shortName?: string;
    nativeCurrency?: { symbol?: string };
    explorers?: { url?: string; standard?: string }[];
    faucets?: string[];
    slip44?: number;
  };
  const el = new Map(
    (eth.json as El[])
      .filter((c) => Number.isSafeInteger(c.chainId))
      .map((c) => [String(c.chainId), c]),
  );
  const tw = await trustWalletChains();
  const cg = await getJson(
    "https://api.coingecko.com/api/v3/asset_platforms",
    HOSTS.coingecko,
    2_000_000,
    "coingecko/asset_platforms.json",
  );
  type Plat = {
    id: string;
    chain_identifier: number | null;
    name: string;
    image?: { large?: string; small?: string };
  };
  const cgByChain = new Map<string, Plat[]>();
  for (const p of cg.json as Plat[])
    if (p.chain_identifier != null)
      cgByChain.set(String(p.chain_identifier), [
        ...(cgByChain.get(String(p.chain_identifier)) ?? []),
        p,
      ]);

  const tvlRows = (
    tvlSnapshot as {
      raw: {
        name?: unknown;
        chainId?: unknown;
        tvl?: unknown;
        tokenSymbol?: unknown;
        gecko_id?: unknown;
      }[];
    }
  ).raw;
  const geckoOf = new Map<string, string>();
  const ids = new Map<string, ChainIdentity>();
  const explorerOf = (id: string) => {
    const e = el
      .get(id)
      ?.explorers?.find(
        (x) => typeof x.url === "string" && /^https:\/\//.test(x.url),
      );
    return e?.url?.replace(/\/+$/, "") ?? null;
  };
  const twTried = new Map<string, TwEntry | null>();
  const twFor = async (id: string) => {
    if (!twTried.has(id))
      twTried.set(
        id,
        tw.byChain.has(id) ? await twAssetsFolder(tw.byChain.get(id)!) : null,
      );
    return twTried.get(id)!;
  };
  // Logo for a chain that has no reviewed local asset: Trust Wallet (exact chain id) → CoinGecko platform (exact
  // chain id, single platform) → monogram.
  const remoteLogo = async (id: string) => {
    const t = await twFor(id);
    if (t) {
      const url = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${t.id}/info/logo.png`;
      const r = await ingestLogo(
        url,
        HOSTS.github,
        OUT.chainLogos,
        `chain-${id}`,
        64,
      ).catch((e) => ({
        ok: false as const,
        reason: String(e?.message ?? e),
        url,
      }));
      if (r.ok)
        return {
          logo: r.path,
          logoSource: "trustwallet" as const,
          logoProvenance: `Trust Wallet assets (exact chain id → ${t.id}): ${url}; source sha256 ${r.sourceSha256}`,
          logoSha256: r.sha256,
        };
      log(`chains: Trust Wallet logo ${id} refused: ${r.reason}`);
    }
    const plats = cgByChain.get(id) ?? [];
    if (plats.length === 1 && plats[0].image?.large) {
      const url = plats[0].image.large;
      const r = await ingestLogo(
        url,
        HOSTS.coingeckoImages,
        OUT.chainLogos,
        `chain-${id}`,
        64,
      ).catch((e) => ({
        ok: false as const,
        reason: String(e?.message ?? e),
        url,
      }));
      if (r.ok)
        return {
          logo: r.path,
          logoSource: "curated" as const,
          logoProvenance: `CoinGecko asset platform ${plats[0].id} (exact chain id ${id}): ${url.split("?")[0]}; source sha256 ${r.sourceSha256}${r.via === "jpeg-rasterized" ? "; JPEG rasterized offline + re-encoded" : ""}`,
          logoSha256: r.sha256,
        };
      log(`chains: CoinGecko platform logo ${id} refused: ${r.reason}`);
    }
    return {
      logo: null,
      logoSource: "monogram" as const,
      logoProvenance:
        "Generated Otherbridge monogram (no approved exact-id source)",
      logoSha256: null,
    };
  };
  // 1. routing catalog (+ custom ONE): reviewed local assets
  for (const n of routing) {
    const custom = n.provider === "otherbridge-onebridge";
    const env = environmentOf({
      id: n.id,
      name: n.name,
      routingMainnet: custom ? undefined : n.mainnet,
      custom,
    });
    const nonEvm = NON_EVM[n.id];
    const official = OFFICIAL[n.id];
    const local = n.theme.logo !== "/networks/neutral.svg";
    const logoFile = local ? join(REPO, "public", n.theme.logo) : null;
    const logo = local
      ? {
          logo: n.theme.logo,
          logoSource: (official
            ? "official"
            : "local-verified") as ChainIdentity["logoSource"],
          logoProvenance: official ? official.provenance : n.theme.provenance,
          logoSha256:
            logoFile && existsSync(logoFile)
              ? sha(readFileSync(logoFile))
              : null,
        }
      : await remoteLogo(n.id);
    ids.set(n.id, {
      id: n.id,
      chainId: n.id,
      caip2: nonEvm?.caip2 ?? (n.ecosystem === "EVM" ? `eip155:${n.id}` : null),
      name: n.name,
      // Display short name from the official name (ethereum-lists `shortName` is a technical id such as "arb1").
      shortName: shortNameOf(n.name, nonEvm?.short ?? null),
      ...env,
      ecosystem: n.ecosystem,
      nativeSymbol: n.nativeAsset.symbol,
      explorer: official?.explorer ?? nonEvm?.explorer ?? explorerOf(n.id),
      ...logo,
      sources: [
        custom ? "custom-registry" : "routing-catalog",
        ...(el.has(n.id) && n.ecosystem === "EVM" ? ["ethereum-lists"] : []),
      ],
      updatedAt: NOW,
    });
  }
  // 2. active TVL catalog (exact chain id when present; otherwise catalog-only identity without a logo source)
  const tvlCandidates = tvlRows.filter(
    (r) => typeof r.tvl === "number" && r.tvl > 0 && typeof r.name === "string",
  );
  for (const r of tvlCandidates) {
    const name = displayText(String(r.name), 120);
    // Same resolution as the product's active catalog (src/catalog/model.ts normalizeActive): explicit chain id,
    // else the reviewed alias table, else exact (case-insensitive) equality with a routing mainnet's name.
    const routed = routing.find(
      (n) => n.mainnet && n.name.toLowerCase() === name.toLowerCase(),
    );
    const chainId =
      r.chainId != null && /^\d{1,18}$/.test(String(r.chainId))
        ? String(r.chainId)
        : (routed?.id ?? TVL_ALIASES[name.toLowerCase()] ?? null); // same precedence as normalizeActive
    const id =
      chainId ??
      `catalog:${name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60)}`;
    if (!id || id === "catalog:" || ids.has(id)) continue;
    if (typeof r.gecko_id === "string" && /^[a-z0-9-]{1,80}$/.test(r.gecko_id))
      geckoOf.set(id, r.gecko_id);
    const elc = chainId ? el.get(chainId) : undefined;
    const env = environmentOf({
      id,
      name,
      tvlPositive: true,
      ethereumListsTestnet:
        !!elc && /test|sepolia|goerli|holesky/i.test(elc.name),
    });
    const logo = chainId
      ? await remoteLogo(chainId)
      : {
          logo: null,
          logoSource: "monogram" as const,
          logoProvenance:
            "Generated Otherbridge monogram (catalog entry without a chain id)",
          logoSha256: null,
        };
    ids.set(id, {
      id,
      chainId,
      caip2: chainId && elc ? `eip155:${chainId}` : null,
      name,
      shortName: shortNameOf(name),
      ...env,
      ecosystem: chainId && elc ? "EVM" : "OTHER",
      nativeSymbol:
        typeof r.tokenSymbol === "string" &&
        /^[A-Za-z0-9.$-]{1,16}$/.test(r.tokenSymbol)
          ? r.tokenSymbol
          : (elc?.nativeCurrency?.symbol ?? null),
      explorer: chainId ? explorerOf(chainId) : null,
      ...logo,
      sources: ["tvl-catalog", ...(elc ? ["ethereum-lists"] : [])],
      updatedAt: NOW,
    });
  }
  // 2b. catalog entries still without a logo: the catalog's own EXACT CoinGecko id (gecko_id) → that coin's image.
  const needing = [...ids.values()].filter(
    (c) => c.logoSource === "monogram" && geckoOf.has(c.id),
  );
  for (let i = 0; i < needing.length; i += 50) {
    const batch = needing.slice(i, i + 50);
    const ids2 = [...new Set(batch.map((c) => geckoOf.get(c.id)!))];
    const m = await getJson(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=250&ids=${ids2.join(",")}`,
      HOSTS.coingecko,
      5_000_000,
      `coingecko/markets-chains-${i}.json`,
    ).catch(() => null);
    const image = new Map(
      ((m?.json as { id: string; image?: string }[] | null) ?? []).map((x) => [
        x.id,
        x.image,
      ]),
    );
    for (const c of batch) {
      const url = image.get(geckoOf.get(c.id)!);
      if (typeof url !== "string" || !/^https:\/\//.test(url)) continue;
      const r = await ingestLogo(
        url,
        HOSTS.coingeckoImages,
        OUT.chainLogos,
        `chain-${c.id.replace(/[^a-z0-9-]/gi, "-")}`,
        64,
      ).catch((e) => ({
        ok: false as const,
        reason: String(e?.message ?? e),
        url,
      }));
      if (!r.ok) {
        log(`chains: CoinGecko coin logo ${c.id} refused: ${r.reason}`);
        continue;
      }
      Object.assign(c, {
        logo: r.path,
        logoSource: "curated",
        logoProvenance: `CoinGecko coin ${geckoOf.get(c.id)} (exact id from the TVL catalog row): ${url.split("?")[0]}; source sha256 ${r.sourceSha256}${r.via === "jpeg-rasterized" ? "; JPEG rasterized offline + re-encoded" : ""}`,
        logoSha256: r.sha256,
      });
      if (!c.sources.includes("coingecko")) c.sources.push("coingecko");
    }
  }
  // 3. local test chains (local-test mode only)
  for (const [id, name] of [
    ["31337", "Local test source"],
    ["31338", "Local test destination"],
  ] as const)
    ids.set(id, {
      id,
      chainId: id,
      caip2: `eip155:${id}`,
      name,
      shortName: name.replace("Local test ", "Local "),
      ...environmentOf({ id, name }),
      ecosystem: "EVM",
      nativeSymbol: "ETH",
      explorer: null,
      logo: null,
      logoSource: "monogram",
      logoProvenance: "Generated Otherbridge monogram (synthetic local chain)",
      logoSha256: null,
      sources: ["local-test"],
      updatedAt: NOW,
    });
  const chains = [...ids.values()];
  const file: ChainIdentityFile = {
    version: 1,
    generatedAt: NOW,
    note: "Generated by `pnpm assets:sync:chains`. Chains matched by exact chain id only; logos sanitized server-side (src/assets/image-sanitize.ts). Provenance is attribution, not endorsement.",
    chains,
  };
  write(OUT.chains, file);
  const client: Record<string, ClientChainIdentity> = {};
  for (const c of chains)
    client[c.id] = [c.environment, c.logo ?? "", c.shortName, c.explorer ?? ""];
  write(OUT.chainsClient, client);
  write(join(evidenceRoot, "chains-sources.json"), {
    ethereumLists: eth.evidence,
    trustWalletRegistry: tw.evidence,
    coingeckoPlatforms: cg.evidence,
    trustWalletAmbiguous: [...tw.byChain.entries()]
      .filter(([, v]) => v.length > 1)
      .map(([k, v]) => [k, v.map((e) => e.id)]),
  });
  log(`chains: ${chains.length} identities written`);
}

// ------------------------------------------------------------------------------------------------ Trust Wallet tokens
async function syncTrustWallet() {
  const tw = await trustWalletChains();
  const out: Record<
    string,
    {
      chain: string;
      twId: string;
      url: string;
      sha256: string;
      tokens: {
        address: string;
        symbol: string;
        name: string;
        decimals: number;
        logoURI: string;
      }[];
    }
  > = {};
  for (const n of evmRouting) {
    const entry = tw.byChain.has(n.id)
      ? await twAssetsFolder(tw.byChain.get(n.id)!)
      : null;
    if (!entry) continue;
    const url = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${entry.id}/tokenlist.json`;
    let r;
    try {
      r = await getJson(
        url,
        HOSTS.github,
        5_000_000,
        `trustwallet/${entry.id}-tokenlist.json`,
      );
    } catch {
      continue;
    }
    type T = {
      asset?: string;
      address?: string;
      symbol?: string;
      name?: string;
      decimals?: number;
      logoURI?: string;
      chainId?: number;
    };
    const coin = String(entry.coinId ?? "");
    const tokens = ((r.json as { tokens?: T[] }).tokens ?? [])
      .filter(
        (t) =>
          typeof t.address === "string" &&
          isEvmAddress(t.address) &&
          Number.isInteger(t.decimals) &&
          (t.decimals as number) >= 0 &&
          (t.decimals as number) <= 36 &&
          // exact chain: the asset id prefix names this chain's coin id
          (!t.asset || !coin || t.asset.startsWith(`c${coin}_t`)),
      )
      .map((t) => ({
        address: t.address!.toLowerCase(),
        symbol: displayText(String(t.symbol ?? ""), 32),
        name: displayText(String(t.name ?? ""), 120),
        decimals: t.decimals as number,
        logoURI: typeof t.logoURI === "string" ? t.logoURI : "",
      }));
    out[n.id] = {
      chain: n.id,
      twId: entry.id,
      url,
      sha256: r.evidence!.sha256,
      tokens,
    };
    log(`trustwallet: ${n.id} (${entry.id}) ${tokens.length} tokens`);
  }
  write(OUT.trustwallet, {
    generatedAt: NOW,
    source: "Trust Wallet assets repository (per-chain curated tokenlist.json)",
    chains: out,
  });
}

// ------------------------------------------------------------------------------------------------ routing tokens
async function syncRouting() {
  const out: Record<
    string,
    { address: string; decimals: number; symbol: string }[]
  > = {};
  const ids = evmRouting.map((n) => n.id);
  for (let i = 0; i < ids.length; i += 8) {
    const chunk = ids.slice(i, i + 8);
    const r = await getJson(
      `https://li.quest/v1/tokens?chains=${chunk.join(",")}`,
      HOSTS.routing,
      40_000_000,
      `routing/tokens-${chunk.join("_")}.json`,
    );
    const tokens =
      (
        r.json as {
          tokens?: Record<
            string,
            { address?: string; decimals?: number; symbol?: string }[]
          >;
        }
      ).tokens ?? {};
    for (const id of chunk)
      out[id] = (tokens[id] ?? [])
        .filter(
          (t) =>
            typeof t.address === "string" &&
            isEvmAddress(t.address) &&
            Number.isInteger(t.decimals),
        )
        .map((t) => ({
          address: t.address!.toLowerCase(),
          decimals: t.decimals!,
          symbol: displayText(String(t.symbol ?? ""), 32),
        }));
    log(`routing: ${chunk.map((id) => `${id}:${out[id].length}`).join(" ")}`);
  }
  // Compact: only addresses + decimals (the app reads live lists at runtime; this snapshot serves classification).
  const compact: Record<string, Record<string, number>> = {};
  for (const [id, list] of Object.entries(out))
    compact[id] = Object.fromEntries(list.map((t) => [t.address, t.decimals]));
  write(OUT.routing, {
    generatedAt: NOW,
    source: "routing provider token lists (fixed host, read-only)",
    chains: compact,
  });
}

// ------------------------------------------------------------------------------------------------ CoinGecko
async function syncCoinGecko() {
  const key = process.env.COINGECKO_API_KEY?.trim();
  const pro = process.env.COINGECKO_API_PLAN === "pro";
  const base =
    key && pro
      ? "https://pro-api.coingecko.com/api/v3"
      : "https://api.coingecko.com/api/v3";
  const headers: Record<string, string> = key
    ? { [pro ? "x-cg-pro-api-key" : "x-cg-demo-api-key"]: key }
    : {};
  const plats = await getJson(
    `${base}/asset_platforms`,
    HOSTS.coingecko,
    2_000_000,
    "coingecko/asset_platforms.json",
    headers,
  );
  const list = await getJson(
    `${base}/coins/list?include_platform=true`,
    HOSTS.coingecko,
    20_000_000,
    "coingecko/coins-list.json",
    headers,
  );
  const platformChain = new Map<string, string>();
  for (const p of plats.json as {
    id: string;
    chain_identifier: number | null;
  }[])
    if (p.chain_identifier != null)
      platformChain.set(p.id, String(p.chain_identifier));
  const routingTokens = existsSync(OUT.routing)
    ? read<{ chains: Record<string, Record<string, number>> }>(OUT.routing)
        .chains
    : {};
  const tw = existsSync(OUT.trustwallet)
    ? read<{ chains: Record<string, { tokens: { address: string }[] }> }>(
        OUT.trustwallet,
      ).chains
    : {};
  const listed: Record<string, Record<string, string>> = {};
  let total = 0;
  for (const c of list.json as {
    id: string;
    platforms?: Record<string, string | null>;
  }[])
    for (const [platform, addr] of Object.entries(c.platforms ?? {})) {
      const chain = platformChain.get(platform);
      if (!chain || !addr || !isEvmAddress(addr)) continue;
      const a = addr.toLowerCase();
      // Only route-supported or Trust-Wallet-curated contracts are kept (classification set, not a full mirror).
      if (
        !routingTokens[chain]?.[a] &&
        !tw[chain]?.tokens.some((t) => t.address === a)
      )
        continue;
      (listed[chain] ??= {})[a] = c.id;
      total++;
    }
  write(OUT.coingecko, {
    generatedAt: NOW,
    source:
      "CoinGecko public API (asset_platforms + coins/list include_platform; exact platform + contract)",
    keyed: !!key,
    platforms: Object.fromEntries(platformChain),
    listed,
  });
  log(
    `coingecko: ${total} exact contract listings across ${Object.keys(listed).length} chains (key ${key ? "yes" : "no"})`,
  );
}

// ------------------------------------------------------------------------------------------------ DEXScreener
async function syncDexScreener() {
  // Bounded evidence pass: Trust Wallet curated tokens without a CoinGecko listing get DEX pair evidence.
  const tw = read<{
    chains: Record<string, { tokens: { address: string }[] }>;
  }>(OUT.trustwallet).chains;
  const cg = read<{ listed: Record<string, Record<string, string>> }>(
    OUT.coingecko,
  ).listed;
  const evidence: Record<
    string,
    Record<
      string,
      { pairs: number; liquidityUsd: number; priceUsd: string | null }
    >
  > = {};
  let requests = 0;
  for (const [chain, entry] of Object.entries(tw)) {
    const slug = DEXSCREENER_CHAINS[chain];
    if (!slug) continue;
    const missing = entry.tokens
      .map((t) => t.address)
      .filter((a) => !cg[chain]?.[a]);
    for (let i = 0; i < missing.length && requests < 60; i += 30) {
      const batch = missing.slice(i, i + 30);
      requests++;
      const r = await getJson(
        `https://api.dexscreener.com/tokens/v1/${slug}/${batch.join(",")}`,
        HOSTS.dexscreener,
        5_000_000,
      ).catch(() => null);
      for (const p of (r?.json as
        | {
            baseToken?: { address?: string };
            liquidity?: { usd?: number };
            priceUsd?: string;
          }[]
        | null) ?? []) {
        const a = String(p.baseToken?.address ?? "").toLowerCase();
        if (!batch.includes(a)) continue;
        const e = ((evidence[chain] ??= {})[a] ??= {
          pairs: 0,
          liquidityUsd: 0,
          priceUsd: null,
        });
        e.pairs++;
        e.liquidityUsd += Number(p.liquidity?.usd ?? 0) || 0;
        e.priceUsd ??=
          typeof p.priceUsd === "string" ? p.priceUsd.slice(0, 32) : null;
      }
      await new Promise((res) => setTimeout(res, 250));
    }
  }
  write(OUT.dexscreener, {
    generatedAt: NOW,
    source:
      "DEXScreener tokens/v1 (exact chain + token address); evidence only, never safety",
    requests,
    evidence,
  });
  log(`dexscreener: ${requests} requests`);
}

// ------------------------------------------------------------------------------------------------ build registry
async function buildRegistry() {
  const chains = read<ChainIdentityFile>(OUT.chains).chains;
  const tw = read<{
    chains: Record<
      string,
      {
        twId: string;
        tokens: {
          address: string;
          symbol: string;
          name: string;
          decimals: number;
          logoURI: string;
        }[];
      }
    >;
  }>(OUT.trustwallet).chains;
  const routingTokens = read<{
    chains: Record<string, Record<string, number>>;
  }>(OUT.routing).chains;
  const cg = read<{ listed: Record<string, Record<string, string>> }>(
    OUT.coingecko,
  ).listed;
  const pairs = existsSync(OUT.onebridge)
    ? read<{
        pairs: {
          local: {
            chainId: string;
            address: string;
            symbol: string;
            decimals: number;
            native: boolean;
          };
          remote: {
            chainId: string;
            address: string;
            symbol: string;
            decimals: number;
            native: boolean;
          };
        }[];
      }>(OUT.onebridge).pairs
    : [];
  const previous = existsSync(OUT.registry)
    ? read<{ assets: RegistryAsset[] }>(OUT.registry).assets
    : [];
  const prevLogo = new Map(
    previous
      .filter((a) => a.logo)
      .map((a) => [assetKey(a.chainId, a.address, a.native), a.logo!]),
  );
  const assets = new Map<string, RegistryAsset>();
  const chainById = new Map(chains.map((c) => [c.id, c]));
  // CANONICAL natives (routing networks + ONE)
  for (const n of routing) {
    const c = chainById.get(n.id);
    if (!c || c.environment !== "mainnet") continue;
    const key = assetKey(n.id, n.nativeAsset.address, true);
    assets.set(key, {
      chainId: n.id,
      address: n.nativeAsset.address.toLowerCase(),
      native: true,
      symbol: displayText(n.nativeAsset.symbol, 32),
      name: displayText(n.nativeAsset.name || n.nativeAsset.symbol, 120),
      decimals: n.nativeAsset.decimals,
      level: "CANONICAL",
      sources: ["native"],
      logo: c.logo
        ? { src: c.logo, source: "canonical-local", sha256: c.logoSha256 ?? "" }
        : null,
      risk: [],
      routable: n.provider === "routing-core",
    });
  }
  // CANONICAL ONEbridge pair tokens
  for (const p of pairs)
    for (const side of [p.local, p.remote]) {
      const key = assetKey(side.chainId, side.address, side.native);
      const existing = assets.get(key);
      if (existing) {
        if (!existing.sources.includes("onebridge"))
          existing.sources.push("onebridge");
        continue;
      }
      assets.set(key, {
        chainId: side.chainId,
        address: side.address.toLowerCase(),
        native: side.native,
        symbol: displayText(side.symbol, 32),
        name: displayText(side.symbol, 120),
        decimals: side.decimals,
        level: "CANONICAL",
        sources: ["onebridge"],
        logo: prevLogo.get(key) ?? null,
        risk: [],
        routable: false,
      });
    }
  // CURATED: Trust Wallet curated list AND routing provider agree on exact contract and decimals.
  const logoJobs: {
    key: string;
    url: string;
    chain: string;
    address: string;
  }[] = [];
  const excluded: { key: string; reason: string }[] = [];
  for (const [chain, entry] of Object.entries(tw)) {
    const route = routingTokens[chain] ?? {};
    for (const t of entry.tokens) {
      const key = assetKey(chain, t.address);
      const routeDecimals = route[t.address];
      const existing = assets.get(key);
      if (existing) {
        if (!existing.sources.includes("trustwallet"))
          existing.sources.push("trustwallet");
        if (routeDecimals !== undefined)
          existing.routable =
            existing.routable || routeDecimals === existing.decimals;
        if (!existing.logo)
          logoJobs.push({ key, url: t.logoURI, chain, address: t.address });
        continue;
      }
      if (routeDecimals === undefined || routeDecimals !== t.decimals) continue;
      const risk = textRisk(t.symbol, t.name);
      // Risky name/symbol text is never CURATED; it may only be MARKET_LISTED with exact CoinGecko evidence,
      // otherwise it stays out of the registry (still reachable by exact address search).
      if (risk.length && !cg[chain]?.[t.address]) {
        excluded.push({ key, reason: "TEXT_RISK_WITHOUT_MARKET_EVIDENCE" });
        continue;
      }
      assets.set(key, {
        chainId: chain,
        address: t.address,
        native: false,
        symbol: t.symbol || "?",
        name: t.name,
        decimals: t.decimals,
        level: risk.length ? "MARKET_LISTED" : "CURATED",
        sources: [
          "otherbridge-curated",
          "trustwallet",
          "routing",
          ...(cg[chain]?.[t.address] ? (["coingecko"] as const) : []),
        ],
        logo: prevLogo.get(key) ?? null,
        coingeckoId: cg[chain]?.[t.address],
        risk,
        routable: true,
      });
      if (!prevLogo.has(key) && t.logoURI)
        logoJobs.push({ key, url: t.logoURI, chain, address: t.address });
    }
  }
  // Symbol collisions inside the trusted set: canonical wins; colliding curated tokens are demoted to MARKET_LISTED
  // when CoinGecko lists that exact contract, otherwise excluded (still reachable by exact address search).
  const bySymbol = new Map<string, RegistryAsset[]>();
  for (const a of assets.values())
    if (a.level === "CANONICAL" || a.level === "CURATED") {
      const k = `${a.chainId}|${a.symbol.toUpperCase()}`;
      bySymbol.set(k, [...(bySymbol.get(k) ?? []), a]);
    }
  for (const group of bySymbol.values()) {
    if (group.length < 2) continue;
    for (const a of group.filter((x) => x.level === "CURATED")) {
      const key = assetKey(a.chainId, a.address, a.native);
      if (a.coingeckoId) {
        a.level = "MARKET_LISTED";
        a.risk = [...new Set([...a.risk, "SYMBOL_IMPERSONATION" as const])];
      } else {
        assets.delete(key);
        excluded.push({
          key,
          reason: "SYMBOL_COLLISION_WITHOUT_MARKET_EVIDENCE",
        });
      }
    }
  }
  // Logos: the Trust Wallet asset of this EXACT chain + contract, at a path derived here (never the list's URL).
  let ingested = 0,
    refused = 0;
  await pool(
    logoJobs.filter((j) => assets.has(j.key)),
    6,
    async (j) => {
      const url = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${tw[j.chain]!.twId}/assets/${getAddress(j.address)}/logo.png`;
      const r = await ingestLogo(
        url,
        HOSTS.github,
        join(OUT.tokenLogos, j.chain),
        j.address,
        64,
      ).catch((e) => ({ ok: false as const, reason: String(e?.message ?? e) }));
      const a = assets.get(j.key)!;
      if (r.ok) {
        a.logo = { src: r.path, source: "trustwallet", sha256: r.sha256 };
        ingested++;
      } else refused++;
    },
  );
  const solanaReviewed = join(
    REPO,
    "src/assets/sources/solana-reviewed.generated.json",
  );
  if (existsSync(solanaReviewed))
    for (const asset of read<{ assets: RegistryAsset[] }>(solanaReviewed)
      .assets) {
      if (
        asset.chainId !== "1151111081099710" ||
        asset.native ||
        !validAddress("SVM", asset.address) ||
        asset.level !== "CURATED" ||
        asset.risk.length
      )
        throw new Error("INVALID_REVIEWED_SOLANA_ASSET");
      assets.set(assetKey(asset.chainId, asset.address), asset);
    }
  // G12 H01: issuer-reviewed EVM USDC (syncEvmIssuerDisplay) survives a rebuild exactly like the Solana entry.
  const evmIssuerReviewed = join(
    REPO,
    "src/assets/sources/evm-issuer-reviewed.generated.json",
  );
  if (existsSync(evmIssuerReviewed))
    for (const asset of read<{ assets: RegistryAsset[] }>(evmIssuerReviewed)
      .assets) {
      // Review H01 m1-m3: the file is evidence, not authority. Every field is pinned again here, the routing and
      // market snapshots must still agree, and no other trusted asset on that network may carry the same symbol.
      if (
        !EVM_ISSUER_USDC.some(
          ([chain, , , address]) =>
            chain === asset.chainId && address.toLowerCase() === asset.address,
        ) ||
        asset.native ||
        !isEvmAddress(asset.address) ||
        asset.level !== "CURATED" ||
        asset.risk.length ||
        asset.symbol !== "USDC" ||
        !/^[ -~]{1,120}$/.test(asset.name) ||
        asset.decimals !== 6 ||
        asset.coingeckoId !== "usd-coin" ||
        asset.routable !== true ||
        asset.sources.join() !==
          "otherbridge-curated,trustwallet,routing,coingecko" ||
        asset.logo?.source !== "trustwallet" ||
        !/^[0-9a-f]{64}$/.test(asset.logo.sha256) ||
        asset.logo.src !==
          `/assets/tokens/${asset.chainId}/${asset.address}-${asset.logo.sha256.slice(0, 16)}.png` ||
        routingTokens[asset.chainId]?.[asset.address] !== 6 ||
        cg[asset.chainId]?.[asset.address] !== "usd-coin" ||
        [...assets.values()].some(
          (o) =>
            o.chainId === asset.chainId &&
            o.address !== asset.address &&
            (o.level === "CANONICAL" || o.level === "CURATED") &&
            o.symbol.toUpperCase() === "USDC",
        )
      )
        throw new Error("INVALID_REVIEWED_EVM_ISSUER_ASSET");
      assets.set(assetKey(asset.chainId, asset.address), asset);
    }
  // VEINED-FIN-LIVE-20261115-01: reviewed canonical wrapped native tokens (EVM_WRAPPED_NATIVE below) survive a rebuild
  // the same way. The file is evidence, not authority: chain + contract + symbol + name + decimals + CoinGecko id are
  // pinned here, the routing and market snapshots must still agree, the row carries no logo (none was reviewed), and
  // no other trusted asset on that network may carry the same symbol.
  const evmWrappedReviewed = join(
    REPO,
    "src/assets/sources/evm-wrapped-native-reviewed.generated.json",
  );
  if (existsSync(evmWrappedReviewed))
    for (const asset of read<{ assets: RegistryAsset[] }>(evmWrappedReviewed)
      .assets) {
      const pin = EVM_WRAPPED_NATIVE.find(
        ([chain, address]) =>
          chain === asset.chainId && address.toLowerCase() === asset.address,
      );
      if (
        !pin ||
        asset.native ||
        !isEvmAddress(asset.address) ||
        asset.level !== "CURATED" ||
        asset.risk.length ||
        asset.symbol !== pin[2] ||
        asset.name !== pin[3] ||
        asset.decimals !== pin[4] ||
        asset.coingeckoId !== pin[5] ||
        asset.routable !== true ||
        asset.sources.join() !== "otherbridge-curated,routing,coingecko" ||
        asset.logo !== null ||
        routingTokens[asset.chainId]?.[asset.address] !== pin[4] ||
        cg[asset.chainId]?.[asset.address] !== pin[5] ||
        [...assets.values()].some(
          (o) =>
            o.chainId === asset.chainId &&
            o.address !== asset.address &&
            (o.level === "CANONICAL" || o.level === "CURATED") &&
            o.symbol.toUpperCase() === pin[2].toUpperCase(),
        )
      )
        throw new Error("INVALID_REVIEWED_EVM_WRAPPED_NATIVE_ASSET");
      assets.set(assetKey(asset.chainId, asset.address), asset);
    }
  const list = flagImpersonation([...assets.values()]).sort(
    (a, b) =>
      Number(a.chainId > b.chainId) - Number(a.chainId < b.chainId) ||
      a.address.localeCompare(b.address),
  );
  write(OUT.registry, {
    version: 1,
    generatedAt: NOW,
    rules: {
      CANONICAL:
        "network native asset or ONEbridge registered pair token (verified on-chain, scripts/assets/onebridge.ts)",
      CURATED:
        "Trust Wallet curated tokenlist AND routing provider list agree on exact chain + contract + decimals; no text risk flag",
      MARKET_LISTED:
        "exact platform + contract on CoinGecko (src/assets/sources/coingecko.generated.json) — not a safety claim",
      DEX_DISCOVERED:
        "exact chain + contract with DEXScreener pair evidence (runtime lookup) — not a safety claim",
      IMPORTED_UNVERIFIED: "exact address imported by the user",
      BLOCKED: "policy/spam/malformed (src/assets/registry.ts)",
    },
    assets: list,
    excluded,
  });
  log(
    `build: ${list.length} assets (${list.filter((a) => a.level === "CANONICAL").length} canonical, ${list.filter((a) => a.level === "CURATED").length} curated); logos ingested ${ingested}, refused ${refused}`,
  );
}

// ------------------------------------------------------------------------------------------------ verify
function verify() {
  const problems: string[] = [];
  const chains = read<ChainIdentityFile>(OUT.chains).chains;
  const seen = new Set<string>();
  for (const c of chains) {
    if (seen.has(c.id)) problems.push(`duplicate chain ${c.id}`);
    seen.add(c.id);
    if (
      c.logo &&
      (!/^\/[A-Za-z0-9_./-]+$/.test(c.logo) ||
        c.logo.includes("..") ||
        !existsSync(join(REPO, "public", c.logo)))
    )
      problems.push(`chain ${c.id} logo missing/unsafe ${c.logo}`);
    if (
      c.logo &&
      c.logoSha256 &&
      sha(readFileSync(join(REPO, "public", c.logo))) !== c.logoSha256
    )
      problems.push(`chain ${c.id} logo hash mismatch`);
    if (
      /test ?net|sepolia|goerli|holesky/i.test(c.name) &&
      c.environment === "mainnet"
    )
      problems.push(`chain ${c.id} testnet-named but mainnet`);
  }
  const client = read<Record<string, ClientChainIdentity>>(OUT.chainsClient);
  if (
    /https?:\/\/(?!explorer|[a-z0-9.-]*scan|mempool|suiscan|tronscan|stellar)/i.test(
      JSON.stringify(Object.values(client).map((c) => c[1])),
    )
  )
    problems.push("client chain identities contain a remote logo URL");
  const reg = read<{ assets: RegistryAsset[] }>(OUT.registry).assets;
  const keys = new Set<string>();
  for (const a of reg) {
    const k = assetKey(a.chainId, a.address, a.native);
    if (keys.has(k)) problems.push(`duplicate asset ${k}`);
    keys.add(k);
    if (
      !a.native &&
      !isEvmAddress(a.address) &&
      !(a.chainId === "1151111081099710" && validAddress("SVM", a.address))
    )
      problems.push(`asset ${k} invalid address`);
    if (a.logo) {
      if (!/^\/assets\/|^\/networks\//.test(a.logo.src))
        problems.push(`asset ${k} logo not local`);
      else if (!existsSync(join(REPO, "public", a.logo.src)))
        problems.push(`asset ${k} logo missing`);
      else if (
        a.logo.sha256 &&
        sha(readFileSync(join(REPO, "public", a.logo.src))) !== a.logo.sha256
      )
        problems.push(`asset ${k} logo hash mismatch`);
    }
    if (a.level === "CURATED" && a.risk.length)
      problems.push(`curated ${k} carries risk ${a.risk.join(",")}`);
  }
  // Every committed image file must decode through the sanitizer unchanged (no unsanitized file slipped in) and be
  // referenced by the registry (no orphaned or stray image is ever served).
  const referenced = new Set(
    [...chains.map((c) => c.logo), ...reg.map((a) => a.logo?.src)].filter(
      Boolean,
    ) as string[],
  );
  for (const [dir, prefix] of [
    [OUT.chainLogos, "/assets/chains/"],
    [OUT.tokenLogos, "/assets/tokens/"],
  ] as const)
    if (existsSync(dir))
      for (const f of readdirSync(dir, { recursive: true }) as string[]) {
        if (!/\.(png|webp)$/.test(f)) continue;
        if (!referenced.has(prefix + f.split(sep).join("/")))
          problems.push(`image ${f} is not referenced by the registry`);
        const bytes = readFileSync(join(dir, f));
        const s = sanitizeImage(bytes, { outputSize: 1024 });
        if (!s.ok) problems.push(`image ${f} fails sanitizer: ${s.reason}`);
        else if (s.format === "png" && !s.bytes.equals(bytes))
          problems.push(`image ${f} is not a canonical sanitized PNG`);
      }
  write(join(evidenceRoot, "verify.json"), {
    at: new Date().toISOString(),
    chains: chains.length,
    assets: reg.length,
    problems,
  });
  if (problems.length) {
    console.error(problems.slice(0, 40).join("\n"));
    process.exitCode = 1;
  } else log(`verify: OK (${chains.length} chains, ${reg.length} assets)`);
}

// ------------------------------------------------------------------------------------------------ coverage
function coverage() {
  const chains = read<ChainIdentityFile>(OUT.chains).chains;
  const reg = read<{ assets: RegistryAsset[] }>(OUT.registry).assets;
  const cg = read<{ listed: Record<string, Record<string, string>> }>(
    OUT.coingecko,
  ).listed;
  const count = <T>(xs: T[], f: (x: T) => boolean) => xs.filter(f).length;
  const env = (e: string) => count(chains, (c) => c.environment === e);
  const logos = {
    official: count(chains, (c) => c.logoSource === "official"),
    localVerified: count(chains, (c) => c.logoSource === "local-verified"),
    trustwallet: count(chains, (c) => c.logoSource === "trustwallet"),
    curated: count(chains, (c) => c.logoSource === "curated"),
    monogram: count(chains, (c) => c.logoSource === "monogram"),
  };
  const real = chains.length - logos.monogram;
  const out = {
    generatedAt: NOW,
    chains: {
      total: chains.length,
      mainnets: env("mainnet"),
      testnets: env("testnet"),
      devnets: env("devnet"),
      local: env("local"),
      unknown: env("unknown"),
      logos,
      realLogo: real,
      coveragePercent: Math.round((real / chains.length) * 1000) / 10,
      mainnetCoveragePercent:
        Math.round(
          (count(
            chains,
            (c) => c.environment === "mainnet" && c.logoSource !== "monogram",
          ) /
            Math.max(1, env("mainnet"))) *
            1000,
        ) / 10,
      withChainId: count(chains, (c) => !!c.chainId),
      withExplorer: count(chains, (c) => !!c.explorer),
    },
    assets: {
      total: reg.length,
      canonical: count(reg, (a) => a.level === "CANONICAL"),
      curated: count(reg, (a) => a.level === "CURATED"),
      marketListedInRegistry: count(reg, (a) => a.level === "MARKET_LISTED"),
      withLogo: count(reg, (a) => !!a.logo),
      logoPercent:
        Math.round(
          (count(reg, (a) => !!a.logo) / Math.max(1, reg.length)) * 1000,
        ) / 10,
      chains: new Set(reg.map((a) => a.chainId)).size,
      coingeckoExactListings: Object.values(cg).reduce(
        (s, m) => s + Object.keys(m).length,
        0,
      ),
      coingeckoChains: Object.keys(cg).length,
    },
  };
  write(OUT.coverage, out);
  write(join(evidenceRoot, "coverage.json"), out);
  log(`coverage: ${JSON.stringify(out.chains)} ${JSON.stringify(out.assets)}`);
}

// V1.12 bounded completion: only exact, presently missing identities. Never replaces a reviewed image.
async function syncMissingImages() {
  const file = read<ChainIdentityFile>(OUT.chains);
  const registry = read<{ assets: RegistryAsset[] }>(OUT.registry);
  const report: unknown[] = [];
  const eth = await getJson(
    "https://chainid.network/chains.json",
    HOSTS.ethereumLists,
    5_000_000,
    "ethereum-lists-missing.json",
  );
  const entries = new Map(
    (eth.json as { chainId: number; icon?: string }[]).map((c) => [
      String(c.chainId),
      c,
    ]),
  );
  for (const c of file.chains.filter(
    (c) => c.logoSource === "monogram" && c.environment !== "local",
  )) {
    const icon = c.chainId ? entries.get(c.chainId)?.icon : null;
    if (!icon || !/^[A-Za-z0-9_-]{1,100}$/.test(icon)) {
      report.push({
        kind: "chain",
        id: c.id,
        resolved: false,
        reason: "No exact chain-ID icon mapping",
      });
      continue;
    }
    const metadata = await getJson(
      `https://raw.githubusercontent.com/ethereum-lists/chains/master/_data/icons/${icon}.json`,
      HOSTS.github,
      80_000,
    ).catch(() => null);
    const image = (metadata?.json as { url?: string }[] | undefined)?.find(
      (i) =>
        typeof i.url === "string" &&
        /^ipfs:\/\/[A-Za-z0-9/_-]{20,200}$/.test(i.url),
    );
    if (!image?.url) {
      report.push({
        kind: "chain",
        id: c.id,
        resolved: false,
        reason: "No bounded content-addressed icon",
      });
      continue;
    }
    const url = `https://ipfs.io/ipfs/${image.url.slice(7)}`;
    const logo = await ingestLogo(
      url,
      ["ipfs.io", "gateway.ipfs.io"],
      OUT.chainLogos,
      `chain-${c.chainId}`,
      128,
    ).catch((e) => ({ ok: false as const, reason: String(e.message) }));
    if (logo.ok) {
      c.logo = logo.path;
      c.logoSha256 = logo.sha256;
      c.logoSource = "curated";
      c.logoProvenance = `ethereum-lists exact chain ID ${c.chainId}; ${image.url}; ${logo.sourceSha256}`;
      c.updatedAt = NOW;
    }
    report.push({
      kind: "chain",
      id: c.id,
      chainId: c.chainId,
      icon,
      source: image.url,
      resolved: logo.ok,
      evidence: logo,
    });
  }
  const tw = read<{ chains: Record<string, { twId: string }> }>(
    OUT.trustwallet,
  ).chains;
  const cg = read<{ listed: Record<string, Record<string, string>> }>(
    OUT.coingecko,
  ).listed;
  for (const asset of registry.assets.filter((a) => !a.logo && !a.native)) {
    const candidates: {
      url: string;
      hosts: readonly string[];
      source: string;
    }[] = [];
    const folder = tw[asset.chainId]?.twId;
    if (folder && isEvmAddress(asset.address))
      candidates.push({
        url: `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${folder}/assets/${getAddress(asset.address)}/logo.png`,
        hosts: HOSTS.github,
        source: "trustwallet",
      });
    const coin = cg[asset.chainId]?.[asset.address.toLowerCase()];
    if (coin) {
      const data = await getJson(
        `https://api.coingecko.com/api/v3/coins/${coin}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`,
        HOSTS.coingecko,
        1_000_000,
      ).catch(() => null);
      const image = (data?.json as { image?: { large?: string } } | undefined)
        ?.image?.large;
      if (image)
        candidates.push({
          url: image,
          hosts: HOSTS.coingeckoImages,
          source: "coingecko",
        });
    }
    const dexChain = DEXSCREENER_CHAINS[asset.chainId];
    if (dexChain) {
      const data = await getJson(
        `https://api.dexscreener.com/token-pairs/v1/${dexChain}/${asset.address}`,
        HOSTS.dexscreener,
        1_000_000,
      ).catch(() => null);
      const pair = (
        data?.json as
          | {
              chainId: string;
              baseToken: { address: string };
              quoteToken: { address: string };
              info?: { imageUrl?: string };
            }[]
          | undefined
      )?.find(
        (p) =>
          p.chainId === dexChain &&
          p.baseToken.address.toLowerCase() === asset.address.toLowerCase(),
      );
      if (pair?.info?.imageUrl)
        candidates.push({
          url: pair.info.imageUrl,
          hosts: ["cdn.dexscreener.com"],
          source: "dexscreener",
        });
    }
    let resolved = false;
    for (const candidate of candidates) {
      const logo = await ingestLogo(
        candidate.url,
        candidate.hosts,
        join(OUT.tokenLogos, asset.chainId),
        asset.address.toLowerCase(),
        128,
      ).catch((e) => ({ ok: false as const, reason: String(e.message) }));
      report.push({
        kind: "token",
        chain: asset.chainId,
        address: asset.address,
        source: candidate.source,
        resolved: logo.ok,
        evidence: logo,
      });
      if (logo.ok) {
        asset.logo = {
          src: logo.path,
          source: candidate.source as NonNullable<
            RegistryAsset["logo"]
          >["source"],
          sha256: logo.sha256,
        };
        resolved = true;
        break;
      }
    }
    if (!resolved)
      report.push({
        kind: "token",
        chain: asset.chainId,
        address: asset.address,
        resolved: false,
        reason: "No usable exact-identity image",
      });
  }
  file.generatedAt = NOW;
  write(OUT.chains, file);
  write(
    OUT.chainsClient,
    Object.fromEntries(
      file.chains.map((c) => [
        c.id,
        [c.environment, c.logo ?? "", c.shortName, c.explorer ?? ""],
      ]),
    ),
  );
  write(OUT.registry, registry);
  write(join(evidenceRoot, "missing-image-report.json"), report);
  coverage();
  log(
    `missing images: ${report.filter((r: unknown) => (r as { resolved: boolean }).resolved).length} resolved observations`,
  );
}

// Missing catalogue images use the catalogue's exact identity row + the icon publisher's
// exact filename in its chain directory. No token symbol or fuzzy-name matching.
async function syncCatalogImages() {
  const file = read<ChainIdentityFile>(OUT.chains);
  const report: unknown[] = [];
  const repo = await getJson(
    "https://api.github.com/repos/DefiLlama/icons/contents/assets/chains?ref=v2",
    ["api.github.com"],
    1_000_000,
    "defillama-chain-icons.json",
  );
  const entries = new Map(
    (repo.json as { name: string; download_url: string; sha: string }[]).map(
      (e) => [e.name, e],
    ),
  );
  const rows = (tvlSnapshot as { raw: { name: string; chainId?: unknown }[] })
    .raw;
  for (const chain of file.chains.filter(
    (c) =>
      c.logoSource === "monogram" &&
      c.environment === "mainnet" &&
      c.sources.includes("tvl-catalog"),
  )) {
    const row = rows.find(
      (r) =>
        r.name === chain.name &&
        (r.chainId == null
          ? chain.chainId == null
          : String(r.chainId) === chain.chainId),
    );
    if (!row) {
      report.push({
        id: chain.id,
        resolved: false,
        reason: "Exact catalogue identity missing",
      });
      continue;
    }
    const filename = [
      `rsz_${row.name.toLowerCase()}.png`,
      `rsz_${row.name.toLowerCase()}.jpg`,
    ].find((name) => entries.has(name));
    const entry = filename ? entries.get(filename) : null;
    if (
      !entry ||
      !entry.download_url.startsWith(
        "https://raw.githubusercontent.com/DefiLlama/icons/v2/assets/chains/",
      )
    ) {
      report.push({
        id: chain.id,
        resolved: false,
        reason: "Exact chain icon filename missing",
      });
      continue;
    }
    const logo = await ingestLogo(
      entry.download_url,
      HOSTS.github,
      OUT.chainLogos,
      `chain-${chain.id.replace(/[^a-z0-9-]/gi, "-")}`,
      128,
    ).catch((e) => ({ ok: false as const, reason: String(e.message) }));
    report.push({
      id: chain.id,
      chainId: chain.chainId,
      ecosystem: chain.ecosystem,
      network: chain.environment,
      catalogueRow: row,
      catalogueRowSha256: sha(Buffer.from(JSON.stringify(row))),
      publisher: "https://github.com/DefiLlama/icons",
      filename,
      gitBlob: entry.sha,
      url: entry.download_url,
      resolved: logo.ok,
      evidence: logo,
    });
    if (logo.ok) {
      chain.logo = logo.path;
      chain.logoSha256 = logo.sha256;
      chain.logoSource = "curated";
      chain.logoProvenance = `DefiLlama exact catalogue identity ${chain.id} + chains/${filename}; ${entry.download_url}; source sha256 ${logo.sourceSha256}`;
      chain.updatedAt = NOW;
    }
  }
  file.generatedAt = NOW;
  write(OUT.chains, file);
  write(
    OUT.chainsClient,
    Object.fromEntries(
      file.chains.map((c) => [
        c.id,
        [c.environment, c.logo ?? "", c.shortName, c.explorer ?? ""],
      ]),
    ),
  );
  write(join(evidenceRoot, "catalog-chain-images.json"), report);
  coverage();
  log(
    `catalogue images: ${report.filter((r) => (r as { resolved: boolean }).resolved).length} resolved`,
  );
}
async function syncSolanaDisplay() {
  const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const chainId = "1151111081099710";
  const issuer =
    "https://developers.circle.com/stablecoins/usdc-contract-addresses";
  const metadataUrl = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/assets/${mint}/info.json`;
  const metadata = await getJson(
    metadataUrl,
    HOSTS.github,
    80_000,
    "solana-usdc-info.json",
  );
  const info = metadata.json as {
    id: string;
    type: string;
    decimals: number;
    symbol: string;
    name: string;
  };
  if (
    info.id !== mint ||
    info.type !== "SPL" ||
    info.decimals !== 6 ||
    !validAddress("SVM", mint)
  )
    throw new Error("SOLANA_EXACT_IDENTITY_MISMATCH");
  const logo = await ingestLogo(
    `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/assets/${mint}/logo.png`,
    HOSTS.github,
    join(OUT.tokenLogos, chainId),
    mint,
    128,
  );
  if (!logo.ok) throw new Error(`SOLANA_IMAGE_REFUSED ${logo.reason}`);
  const asset: RegistryAsset = {
    chainId,
    address: mint,
    native: false,
    symbol: displayText(info.symbol, 32),
    name: displayText(info.name, 120),
    decimals: 6,
    level: "CURATED",
    sources: ["otherbridge-curated", "trustwallet"],
    logo: { src: logo.path, source: "trustwallet", sha256: logo.sha256 },
    risk: [],
    routable: false,
  };
  const path = join(REPO, "src/assets/sources/solana-reviewed.generated.json");
  write(path, {
    issuer,
    reviewedAt: NOW,
    metadataUrl,
    metadataSha256: sha(Buffer.from(JSON.stringify(info))),
    assets: [asset],
  });
  const registry = read<{ assets: RegistryAsset[] }>(OUT.registry);
  registry.assets = registry.assets.filter(
    (a) => assetKey(a.chainId, a.address, a.native) !== assetKey(chainId, mint),
  );
  registry.assets.push(asset);
  write(OUT.registry, registry);
  write(join(evidenceRoot, "solana-display.json"), {
    issuer,
    metadataUrl,
    mint,
    decimals: 6,
    logo,
    executionEnabled: false,
  });
  coverage();
}
// G12 H01 (F1): Circle's native USDC on Base, Arbitrum, OP Mainnet and Polygon PoS, by the SAME accepted issuer-review
// rule as Solana USDC above (syncSolanaDisplay): the issuer's published contract list, Trust Wallet's exact per-asset
// metadata (id, decimals, chain type, status) and logo from the fixed GitHub host, plus the routing provider's exact
// contract and decimals and the CoinGecko listing that this registry already holds. Every check must hold or the job
// stops; nothing else in the registry changes. These contracts were missing only because the Trust Wallet token-list
// snapshot omits them (the CURATED build rule needs that snapshot), not because any evidence disagreed.
const EVM_ISSUER_USDC = [
  ["8453", "base", "BASE", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
  [
    "42161",
    "arbitrum",
    "ARBITRUM",
    "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  ],
  ["10", "optimism", "OPTIMISM", "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"],
  ["137", "polygon", "POLYGON", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"],
] as const;
// VEINED-FIN-LIVE-20261115-01: reviewed canonical wrapped native tokens — [chain, contract (checksummed), symbol, name,
// decimals, CoinGecko id]. Base WETH is the OP-stack predeploy (the swap lane's receive token on Base; the Trust Wallet
// token-list snapshot omits it, so the CURATED build rule never sees it). Merged by buildRegistry from
// src/assets/sources/evm-wrapped-native-reviewed.generated.json, which must match these pins exactly.
const EVM_WRAPPED_NATIVE = [
  [
    "8453",
    "0x4200000000000000000000000000000000000006",
    "WETH",
    "Wrapped Ether",
    18,
    "l2-standard-bridged-weth-base",
  ],
] as const;
const EVM_ISSUER_REVIEWED = join(
  REPO,
  "src/assets/sources/evm-issuer-reviewed.generated.json",
);
async function syncEvmIssuerDisplay() {
  const issuer =
    "https://developers.circle.com/stablecoins/usdc-contract-addresses";
  const routingTokens = read<{
    chains: Record<string, Record<string, number>>;
  }>(OUT.routing).chains;
  const cg = read<{ listed: Record<string, Record<string, string>> }>(
    OUT.coingecko,
  ).listed;
  const reviewed: RegistryAsset[] = [];
  const evidence: unknown[] = [];
  for (const [chainId, folder, type, checksummed] of EVM_ISSUER_USDC) {
    const address = checksummed.toLowerCase();
    if (getAddress(address) !== checksummed)
      throw new Error(`EVM_ISSUER_CHECKSUM ${chainId}`);
    const base = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${folder}/assets/${checksummed}`;
    const metadata = await getJson(
      `${base}/info.json`,
      HOSTS.github,
      80_000,
      `evm-issuer-${chainId}-usdc-info.json`,
    );
    const info = metadata.json as {
      id: string;
      type: string;
      decimals: number;
      symbol: string;
      name: string;
      status: string;
    };
    if (
      info.id !== checksummed ||
      info.type !== type ||
      info.decimals !== 6 ||
      info.symbol !== "USDC" ||
      info.status !== "active"
    )
      throw new Error(`EVM_ISSUER_IDENTITY_MISMATCH ${chainId}`);
    if (routingTokens[chainId]?.[address] !== 6)
      throw new Error(`EVM_ISSUER_ROUTING_MISMATCH ${chainId}`);
    if (cg[chainId]?.[address] !== "usd-coin")
      throw new Error(`EVM_ISSUER_MARKET_MISMATCH ${chainId}`);
    const logo = await ingestLogo(
      `${base}/logo.png`,
      HOSTS.github,
      join(OUT.tokenLogos, chainId),
      address,
    );
    if (!logo.ok) throw new Error(`EVM_ISSUER_IMAGE_REFUSED ${logo.reason}`);
    reviewed.push({
      chainId,
      address,
      native: false,
      symbol: displayText(info.symbol, 32),
      name: displayText(info.name, 120),
      decimals: 6,
      level: "CURATED",
      sources: ["otherbridge-curated", "trustwallet", "routing", "coingecko"],
      logo: { src: logo.path, source: "trustwallet", sha256: logo.sha256 },
      coingeckoId: "usd-coin",
      risk: [],
      routable: true,
    });
    evidence.push({
      chainId,
      address,
      metadataUrl: `${base}/info.json`,
      metadataSha256: sha(Buffer.from(JSON.stringify(info))),
      raw: metadata.evidence,
      routingDecimals: 6,
      coingeckoId: "usd-coin",
      logo,
    });
  }
  write(EVM_ISSUER_REVIEWED, {
    issuer,
    rule: "issuer-published contract + Trust Wallet exact asset metadata + routing provider contract and decimals + CoinGecko listing (same rule as solana-reviewed.generated.json)",
    reviewedAt: NOW,
    assets: reviewed,
  });
  const registry = read<{ assets: RegistryAsset[] }>(OUT.registry);
  const keys = new Set(reviewed.map((a) => assetKey(a.chainId, a.address)));
  registry.assets = registry.assets.filter(
    (a) => !keys.has(assetKey(a.chainId, a.address, a.native)),
  );
  // Review H01 m2: no other trusted asset on these networks may already be called USDC.
  if (
    registry.assets.some(
      (o) =>
        reviewed.some((r) => r.chainId === o.chainId) &&
        (o.level === "CANONICAL" || o.level === "CURATED") &&
        o.symbol.toUpperCase() === "USDC",
    )
  )
    throw new Error("EVM_ISSUER_SYMBOL_COLLISION");
  registry.assets.push(...reviewed);
  // The same order as a full build writes, so a later rebuild keeps these rows where they are.
  registry.assets.sort(
    (a, b) =>
      Number(a.chainId > b.chainId) - Number(a.chainId < b.chainId) ||
      a.address.localeCompare(b.address),
  );
  write(OUT.registry, registry);
  write(join(evidenceRoot, "evm-issuer-display.json"), {
    issuer,
    assets: evidence,
    executionEnabled: false,
  });
  coverage();
}
const jobs: Record<string, () => Promise<void> | void> = {
  "solana-display": syncSolanaDisplay,
  "evm-issuer-display": syncEvmIssuerDisplay,
  "catalog-images": syncCatalogImages,
  missing: syncMissingImages,
  chains: syncChains,
  trustwallet: syncTrustWallet,
  routing: syncRouting,
  coingecko: syncCoinGecko,
  dexscreener: syncDexScreener,
  build: buildRegistry,
  verify,
  coverage,
};
const job = process.argv[2];
if (job === "all") {
  for (const j of [
    "chains",
    "trustwallet",
    "routing",
    "coingecko",
    "dexscreener",
    "build",
    "verify",
    "coverage",
  ]) {
    log(`== ${j}`);
    await jobs[j]();
  }
  await closeRasterizer();
} else if (job && jobs[job]) {
  await jobs[job]();
  await closeRasterizer();
} else {
  console.error(`usage: sync.ts <${Object.keys(jobs).join("|")}|all>`);
  process.exitCode = 2;
}
