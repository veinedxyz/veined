import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { base58 } from "@scure/base";

// Evidence acquisition only. This module cannot sign, broadcast, approve terms, or activate pins.
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PROGRAM = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const PINNED_SOURCE = "cc683ec92acb5e7606caa3d8e514d9383e9c7c11";
const TRANSFER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const READS = new Set([
  "eth_chainId",
  "eth_getBlockByNumber",
  "eth_getLogs",
  "getSlot",
  "getAccountInfo",
]);
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export function decodeProgramData(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 45 ||
    bytes.readUInt32LE(0) !== 3 ||
    ![0, 1].includes(bytes[12])
  )
    throw Error("PROGRAM_DATA_HEADER_INVALID");
  return {
    upgradeSlot: bytes.readBigUInt64LE(4).toString(),
    upgradeAuthority:
      bytes[12] === 1 ? base58.encode(bytes.subarray(13, 45)) : null,
    metadataBase64: bytes.subarray(0, 45).toString("base64"),
  };
}
export function codeHashes(bytes) {
  const code = bytes.subarray(45);
  let end = code.length;
  while (end && code[end - 1] === 0) end--;
  return {
    programDataSha256: sha256(bytes),
    binarySha256: sha256(code),
    binaryBytes: code.length,
    zeroTrimmedBinarySha256: sha256(code.subarray(0, end)),
    zeroTrimmedBinaryBytes: end,
    hashDefinition:
      "binarySha256 covers every byte after the 45-byte upgradeable-loader ProgramData header, including allocation padding; zeroTrimmedBinarySha256 removes trailing zero bytes for comparison with Solana Verify/Osec",
  };
}
export function decodeAnchorIdl(bytes) {
  // Anchor's legacy IdlAccount uses #[account("internal")], not the default account namespace.
  if (
    bytes.length < 44 ||
    !bytes
      .subarray(0, 8)
      .equals(
        createHash("sha256")
          .update("internal:IdlAccount")
          .digest()
          .subarray(0, 8),
      )
  )
    throw Error("INVALID_IDL_DISCRIMINATOR");
  const len = bytes.readUInt32LE(40);
  if (len > 2000000 || len + 44 > bytes.length)
    throw Error("INVALID_IDL_LENGTH");
  const plain = inflateSync(bytes.subarray(44, len + 44), {
    maxOutputLength: 2000000,
  });
  return {
    plain,
    idl: JSON.parse(plain.toString("utf8")),
    authority: base58.encode(bytes.subarray(8, 40)),
  };
}
export function classifyChange({
  metadataMatches,
  binaryMatches,
  currentBinaryAvailable,
  verifiedSourceBinding,
  instructionCompatible,
}) {
  if (currentBinaryAvailable && binaryMatches && !metadataMatches)
    return "METADATA_ONLY";
  if (instructionCompatible === false && verifiedSourceBinding)
    return "INCOMPATIBLE";
  if (
    verifiedSourceBinding &&
    instructionCompatible === true &&
    currentBinaryAvailable
  )
    return "REVIEWED_COMPATIBLE_UPGRADE";
  return "UNVERIFIED_UPSTREAM_CHANGE";
}
function writeNew(file, value) {
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(
    file,
    typeof value === "string" || Buffer.isBuffer(value)
      ? value
      : JSON.stringify(value, null, 2) + "\n",
    { flag: "wx" },
  );
}
function errorText(e) {
  return String(e?.message ?? e).slice(0, 250);
}
function safeEndpoint(url) {
  return url.replace(
    /(\/v[12]\/)[A-Za-z0-9_-]{20,}/g,
    "$1<PUBLIC_REGISTRY_TOKEN_REDACTED>",
  );
}
async function pooled(items, concurrency, fn) {
  const result = new Array(items.length);
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (index < items.length) {
        const i = index++;
        result[i] = await fn(items[i], i);
      }
    }),
  );
  return result;
}
async function rpc(url, method, params, output, label, maxBytes = 16000000) {
  if (!READS.has(method)) throw Error("READ_ONLY_RPC_METHOD_REQUIRED");
  const startedAt = new Date().toISOString(),
    start = performance.now();
  const request = { jsonrpc: "2.0", id: 1, method, params };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    const raw = await r.text();
    if (Buffer.byteLength(raw) > maxBytes) throw Error("RESPONSE_SIZE_LIMIT");
    let response;
    try {
      response = JSON.parse(raw);
    } catch {
      response = {
        nonJsonBodySha256: sha256(raw),
        bytes: Buffer.byteLength(raw),
      };
    }
    const record = {
      endpoint: safeEndpoint(url),
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - start),
      httpStatus: r.status,
      request,
      response,
    };
    writeNew(join(output, label + ".json"), record);
    if (!r.ok || response.error || !("result" in response))
      return {
        ok: false,
        record: label + ".json",
        status: r.status,
        error: response.error ?? `HTTP_${r.status}`,
        durationMs: record.durationMs,
      };
    return {
      ok: true,
      value: response.result,
      durationMs: record.durationMs,
      record: label + ".json",
    };
  } catch (e) {
    writeNew(join(output, label + ".json"), {
      endpoint: safeEndpoint(url),
      startedAt,
      finishedAt: new Date().toISOString(),
      request,
      error: errorText(e),
    });
    return { ok: false, error: errorText(e), record: label + ".json" };
  }
}
async function source(url, output, name, maxBytes = 12000000) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        "user-agent": "otherbridge-v117-read-only-review",
        accept: "*/*",
      },
    });
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length > maxBytes) throw Error("SOURCE_SIZE_LIMIT");
    const record = {
      url,
      finalUrl: r.url,
      observedAt: new Date().toISOString(),
      httpStatus: r.status,
      sha256: sha256(bytes),
      bytes: bytes.length,
      contentType: r.headers.get("content-type"),
      artifact: name + ".body",
    };
    writeNew(join(output, name + ".body"), bytes);
    writeNew(join(output, name + ".json"), record);
    return { ...record, ok: r.ok, body: bytes };
  } catch (e) {
    const record = {
      url,
      observedAt: new Date().toISOString(),
      ok: false,
      error: errorText(e),
    };
    writeNew(join(output, name + ".json"), record);
    return record;
  }
}
function jsonBody(r) {
  try {
    return r.ok ? JSON.parse(r.body.toString()) : null;
  } catch {
    return null;
  }
}

export async function reviewWhirlpool(output) {
  mkdirSync(output, { recursive: true });
  const pinPath = join(
    ROOT,
    "src/swap/server/solana-program-pins.generated.json",
  );
  const pinBytes = readFileSync(pinPath),
    pin = JSON.parse(pinBytes).find((p) => p.address === PROGRAM);
  const endpoints = [
    "https://api.mainnet-beta.solana.com",
    "https://solana-rpc.publicnode.com",
  ];
  const observations = await pooled(endpoints, 2, async (endpoint, i) => {
    const account = await rpc(
      endpoint,
      "getAccountInfo",
      [PROGRAM, { encoding: "base64", commitment: "finalized" }],
      output,
      `program-${i}`,
    );
    if (!account.ok || !account.value?.value)
      return { endpoint, status: "UNAVAILABLE", account };
    const a = account.value.value,
      programBytes = Buffer.from(a.data[0], "base64");
    if (
      a.owner !== LOADER ||
      !a.executable ||
      programBytes.length !== 36 ||
      programBytes.readUInt32LE(0) !== 2
    )
      return { endpoint, status: "INVALID_LOADER", owner: a.owner };
    const programData = base58.encode(programBytes.subarray(4));
    const data = await rpc(
      endpoint,
      "getAccountInfo",
      [
        programData,
        {
          encoding: "base64",
          commitment: "finalized",
          minContextSlot: account.value.context.slot,
        },
      ],
      output,
      `program-data-${i}`,
    );
    if (!data.ok || !data.value?.value)
      return {
        endpoint,
        status: "PROGRAM_DATA_UNAVAILABLE",
        programData,
        data,
      };
    const d = data.value.value,
      dataBytes = Buffer.from(d.data[0], "base64");
    if (d.owner !== LOADER || d.executable)
      return {
        endpoint,
        status: "INVALID_PROGRAM_DATA_LOADER",
        programData,
        owner: d.owner,
      };
    writeNew(join(output, `program-data-${i}.bin`), dataBytes);
    const decoded = decodeProgramData(dataBytes),
      hashes = codeHashes(dataBytes);
    return {
      endpoint,
      status: "OBSERVED",
      accountContextSlot: account.value.context.slot,
      programDataContextSlot: data.value.context.slot,
      commitment: "finalized",
      programId: PROGRAM,
      programData,
      loader: a.owner,
      executable: a.executable,
      programAccountSha256: sha256(programBytes),
      ...decoded,
      ...hashes,
      programDataBytes: dataBytes.length,
      metadataMatchesPin: decoded.metadataBase64 === pin.metadata,
      programAccountMatchesPin: sha256(programBytes) === pin.codeSha256,
      binaryFile: `program-data-${i}.bin`,
      rawEvidence: [account.record, data.record],
    };
  });
  const sources = [];
  const get = async (url, name) => {
    const r = await source(url, output, name);
    sources.push(
      Object.fromEntries(Object.entries(r).filter(([k]) => k !== "body")),
    );
    return r;
  };
  const main = jsonBody(
    await get(
      "https://api.github.com/repos/orca-so/whirlpools/commits/main",
      "upstream-main",
    ),
  );
  const releases = jsonBody(
    await get(
      "https://api.github.com/repos/orca-so/whirlpools/releases?per_page=5",
      "upstream-releases",
    ),
  );
  const osec = jsonBody(
    await get(`https://verify.osec.io/status/${PROGRAM}`, "osec-verification"),
  );
  const paths = [
    "README.md",
    "idl/README.md",
    "SECURITY.md",
    "programs/whirlpool/src/security.rs",
    "programs/whirlpool/src/instructions/swap.rs",
    "programs/whirlpool/src/instructions/v2/swap.rs",
    "programs/whirlpool/src/state/whirlpool.rs",
    "programs/whirlpool/src/lib.rs",
    "programs/whirlpool/Cargo.toml",
    "Anchor.toml",
    "ts-sdk/client/src/generated/instructions/swap.ts",
    "ts-sdk/client/src/generated/instructions/swapV2.ts",
  ];
  const comparisons = await pooled(paths, 3, async (path, i) => {
    const pinned = await get(
      `https://raw.githubusercontent.com/orca-so/whirlpools/${PINNED_SOURCE}/${path}`,
      `pinned-source-${i}`,
    );
    const current =
      main?.sha === PINNED_SOURCE
        ? pinned
        : await get(
            `https://raw.githubusercontent.com/orca-so/whirlpools/${main?.sha ?? "main"}/${path}`,
            `current-source-${i}`,
          );
    return {
      path,
      pinnedSha256: pinned.sha256 ?? null,
      currentSha256: current.sha256 ?? null,
      equal: pinned.ok && current.ok && pinned.sha256 === current.sha256,
      status: pinned.ok && current.ok ? "FETCHED" : "UNAVAILABLE",
    };
  });
  const sdk = jsonBody(
    await get(
      "https://registry.npmjs.org/@orca-so%2fwhirlpools-sdk/latest",
      "sdk-metadata",
    ),
  );
  const idlResult = sdk?.version
    ? await get(
        `https://cdn.jsdelivr.net/npm/@orca-so/whirlpools-sdk@${sdk.version}/dist/artifacts/whirlpool.json`,
        "sdk-idl",
      )
    : null;
  const idl = idlResult ? jsonBody(idlResult) : null;
  const relevantInstructions = (idl?.instructions ?? []).filter((ix) =>
    ["swap", "swap_v2", "swapV2"].includes(ix.name),
  );
  const tree = jsonBody(
    await get(
      `https://api.github.com/repos/orca-so/whirlpools/git/trees/${main?.sha ?? PINNED_SOURCE}?recursive=1`,
      "upstream-tree",
    ),
  );
  const audits = (tree?.tree ?? [])
    .filter((x) => x.path.startsWith(".audits/") && x.path.endsWith(".pdf"))
    .map((x) => ({
      path: x.path,
      gitBlobSha: x.sha,
      url: `https://github.com/orca-so/whirlpools/blob/${main?.sha ?? PINNED_SOURCE}/${x.path}`,
      scopeLinkedToCurrentBinary: false,
    }));
  const current = observations.find((o) => o.status === "OBSERVED");
  const independentAgreement =
    observations.length === 2 &&
    observations.every(
      (o) =>
        o.status === "OBSERVED" &&
        o.programData === current.programData &&
        o.metadataBase64 === current.metadataBase64 &&
        o.programDataSha256 === current.programDataSha256,
    );
  const pinnedHeader = decodeProgramData(Buffer.from(pin.metadata, "base64"));
  const classification = classifyChange({
    metadataMatches: current?.metadataMatchesPin === true,
    binaryMatches: false,
    currentBinaryAvailable: !!current,
    verifiedSourceBinding: false,
    instructionCompatible: null,
  });
  const result = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    classification,
    routeStatus: "BUILD_REVIEW_REQUIRED",
    autoActivated: false,
    pinCandidatePrepared: false,
    pinCandidateReason:
      "No historical full binary hash is pinned and current deployed binary is not verified to a source commit. Identical public source/IDL alone cannot prove deployed semantics.",
    pinned: {
      ...pin,
      ...pinnedHeader,
      codeSha256Definition:
        "36-byte upgradeable-loader Program account header hash; NOT an executable binary hash",
      sourceCommit: PINNED_SOURCE,
      fullBinarySha256: null,
      fullBinaryReason:
        "Accepted pin stores only program-account hash and 45-byte ProgramData metadata; historical executable not retained in this pin",
    },
    currentProgramId: current?.programId ?? null,
    observations,
    independentAgreement,
    source: {
      mainCommit: main?.sha ?? null,
      mainCommitDate: main?.commit?.committer?.date ?? null,
      acceptedAndCurrentSourceEqual: main?.sha === PINNED_SOURCE,
      comparisons,
      latestGithubRelease: releases?.[0]
        ? {
            tag: releases[0].tag_name,
            name: releases[0].name,
            publishedAt: releases[0].published_at,
            url: releases[0].html_url,
            deployedProgramBinding: "NOT_PROVEN_SDK_RELEASE",
          }
        : null,
      sdkVersion: sdk?.version ?? null,
      idlSha256: idlResult?.sha256 ?? null,
      idlProgramAddress: idl?.address ?? idl?.metadata?.address ?? null,
      idlInstructions: relevantInstructions,
      idlStatus: idl ? "FETCHED_SDK_IDL_NOT_ONCHAIN_PROVEN" : "UNAVAILABLE",
      onchainIdl: "NOT_ATTESTED_TO_DEPLOYED_BINARY",
      instructionCompatibility:
        "SOURCE_SHAPE_UNCHANGED_BUT_DEPLOYED_SEMANTICS_UNPROVEN",
      audits,
    },
    verificationService: osec,
    verifiedSourceBinding: false,
    pinnedFileSha256Before: sha256(pinBytes),
    pinnedFileSha256After: sha256(readFileSync(pinPath)),
    sources,
    publicRpcWrites: 0,
    signatures: 0,
    broadcasts: 0,
  };
  writeNew(join(output, "whirlpool-upstream-review.json"), result);
  return {
    classification,
    independentAgreement,
    observed: observations.filter((o) => o.status === "OBSERVED").length,
    fullBinarySha256: current?.binarySha256,
    verificationService: osec?.is_verified,
  };
}

export async function reviewWhirlpoolSupplement(output) {
  mkdirSync(output, { recursive: true });
  const { PublicKey } =
    await import("../swap-providers/node_modules/@solana/web3.js/lib/index.cjs.js");
  const program = new PublicKey(PROGRAM),
    [base] = PublicKey.findProgramAddressSync([], program);
  const address = (
    await PublicKey.createWithSeed(base, "anchor:idl", program)
  ).toBase58();
  const sdk = JSON.parse(readFileSync(join(output, "sdk-idl.body"), "utf8"));
  const relevant = (idl) =>
    (idl.instructions ?? [])
      .filter((ix) => ["swap", "swap_v2", "swapV2"].includes(ix.name))
      .map((ix) => ({
        name: ix.name.replace(/[A-Z]/g, (x) => "_" + x.toLowerCase()),
        discriminator: ix.discriminator ?? null,
        accounts: ix.accounts.map((a) =>
          a.name.replace(/[A-Z]/g, (x) => "_" + x.toLowerCase()),
        ),
        args: ix.args,
      }));
  const observations = await pooled(
    [
      "https://api.mainnet-beta.solana.com",
      "https://solana-rpc.publicnode.com",
    ],
    2,
    async (endpoint, i) => {
      const r = await rpc(
        endpoint,
        "getAccountInfo",
        [address, { encoding: "base64", commitment: "finalized" }],
        output,
        `onchain-idl-final-${i}`,
        4000000,
      );
      if (!r.ok || !r.value?.value)
        return { endpoint, status: "UNAVAILABLE", evidence: r.record };
      const a = r.value.value,
        bytes = Buffer.from(a.data[0], "base64");
      if (a.owner !== PROGRAM)
        return {
          endpoint,
          status: "INVALID_IDL_OWNER",
          owner: a.owner,
          evidence: r.record,
        };
      const { plain, idl, authority } = decodeAnchorIdl(bytes);
      writeNew(join(output, `onchain-idl-decoded-${i}.json`), plain);
      return {
        endpoint,
        status: "OBSERVED",
        address,
        slot: r.value.context.slot,
        owner: a.owner,
        authority,
        decodedSha256: sha256(plain),
        accountSha256: sha256(bytes),
        instructions: relevant(idl),
        evidence: r.record,
        decodedFile: `onchain-idl-decoded-${i}.json`,
      };
    },
  );
  const audits = await pooled(
    ["2026-08-11.pdf", "2026-08-18.pdf", "2026-09-30.pdf"],
    3,
    async (name) => {
      if (existsSync(join(output, "audit-" + name + ".json"))) {
        const cached = JSON.parse(
          readFileSync(join(output, "audit-" + name + ".json"), "utf8"),
        );
        return { ...cached, ok: cached.httpStatus === 200 };
      }
      const r = await source(
        `https://raw.githubusercontent.com/orca-so/whirlpools/${PINNED_SOURCE}/.audits/${name}`,
        output,
        "audit-" + name,
      );
      return Object.fromEntries(
        Object.entries(r).filter(([k]) => k !== "body"),
      );
    },
  );
  const result = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    addressDerivation:
      "Anchor findProgramAddressSync([], Whirlpool program), then createWithSeed(base, 'anchor:idl', Whirlpool program)",
    onchainIdlAddress: address,
    observations,
    sdkInstructions: relevant(sdk),
    onchainIdlDoesNotProveBinarySemantics: true,
    audits,
    ownerActions: [
      {
        id: "V117-WHIRLPOOL-SOURCE-BINDING",
        owner:
          "Orca upstream release/upgrade owner + independent security reviewer",
        status: "OWNER ACTION",
        requiredInput:
          "Provide exact source commit/tag, build toolchain/container digest, Cargo.lock/features and reproducible build recipe for Whirlpool upgrade slot 457152296 at program-data CtXfPzz36dH5Ws4UYKZvrQ1Xqzn42ecDW6y8NKuiN8nD; independently reproduce and match zero-trimmed executable SHA-256 75d0cbf14e39949d50656d581b2e0065ac9543588da96a1dc4c1091a939c605c (refresh if upgraded). Supply the complete audited scope/diff and current program/IDL authority provenance. A README/SDK release or unchanged 36-byte Program account is insufficient.",
        successCheck:
          "Independently reproduce binary/source binding; review exact-in swap/swap_v2 accounts/arguments, tick arrays/oracle, Token-2022 hooks/extensions/CPI parent semantics and unsupported-family rejection; rerun recorded positive/negative economics tests; prepare a separate tested pin-update candidate for owner review while active pins remain unchanged.",
        noAutomaticActivation: true,
      },
    ],
    routeStatus: "BUILD_REVIEW_REQUIRED",
    classification: "UNVERIFIED_UPSTREAM_CHANGE",
    publicRpcWrites: 0,
    signatures: 0,
    broadcasts: 0,
  };
  writeNew(join(output, "idl-and-audit-review-final.json"), {
    ...result,
    supersedes:
      "idl-and-audit-review.json used default account namespace; final parser uses documented Anchor internal:IdlAccount discriminator",
  });
  if (!existsSync(join(output, "owner-actions.json")))
    writeNew(join(output, "owner-actions.json"), {
      schemaVersion: 1,
      ownerActions: result.ownerActions,
    });
  return {
    onchainIdlAddress: address,
    onchainIdlObserved: observations.filter((o) => o.status === "OBSERVED")
      .length,
    auditsFetched: audits.filter((a) => a.ok).length,
  };
}

export async function reviewRpc(output) {
  mkdirSync(output, { recursive: true });
  const snapshotPath = join(
      ROOT,
      "src/data/registry/rpc-registry.snapshot.json",
    ),
    provenancePath = join(ROOT, "src/data/registry/rpc-provenance.json");
  const snapshotBytes = readFileSync(snapshotPath),
    provenanceBytes = readFileSync(provenancePath);
  const snapshot = JSON.parse(snapshotBytes),
    inventory = JSON.parse(provenanceBytes);
  const matchGroup = (url) => {
    const host = new URL(url).hostname;
    return (
      inventory.groups.find((g) => g.hosts.includes(host)) ??
      inventory.groups.find((g) =>
        g.hosts.some((h) => h.startsWith("*.") && host.endsWith(h.slice(1))),
      )
    );
  };
  // Union the accepted V1.16 endpoint matrix and the committed snapshot. Registry metadata is not changed.
  const priorPath = join(
    ROOT,
    "evidence/otherbridge-v1-16/20261015T133159055Z-16dfa3/operations/rpc-matrix/rpc-release-matrix.json",
  );
  const previous = existsSync(priorPath)
    ? JSON.parse(readFileSync(priorPath)).rows
    : [];
  const endpoints = [...snapshot.endpoints];
  for (const row of previous)
    if (
      !endpoints.some(
        (e) =>
          String(e.chainId) === row.chain &&
          new URL(e.url).origin === row.origin,
      )
    )
      endpoints.push({
        id: `${row.chain}:${row.origin}`,
        chainId: row.chain,
        url: row.origin,
        previousMatrixOriginOnly: true,
      });
  // Fixed Swap and G7 endpoints not present in the generic snapshot are explicitly included.
  for (const [chainId, url] of [
    ["612055", "https://mainnet.crosstoken.io:22001"],
    ["612055", "https://mainnet.onechain.nexus:22001"],
    ["56", "https://bnb.api.onfinality.io/public"],
  ])
    if (!endpoints.some((e) => e.url === url))
      endpoints.push({
        id: `${chainId}:${url}`,
        chainId,
        url,
        role: "G7_STATE_OR_WITNESS",
      });
  const sourceUrls = [
    ...new Set(
      inventory.groups
        .flatMap((g) => [g.termsUrl, g.privacyUrl, g.officialDocsUrl])
        .filter(Boolean),
    ),
  ];
  sourceUrls.push(
    "https://www.quicknode.com/docs/platform/supported-chains-node-types",
    "https://support.quicknode.com/articles/3261121056-understanding-the-10-000-block-range-limit-for-querying-logs-and-events",
    "https://www.quicknode.com/pricing",
    "https://www.alchemy.com/docs/chains/arbitrum/arbitrum-api-endpoints/eth-get-logs",
    "https://www.alchemy.com/docs/chains/avalanche/avalanche-api-endpoints/eth-get-logs",
    "https://www.alchemy.com/pricing",
    "https://solana.com/docs/references/clusters",
  );
  const sourceResults = await pooled(
    [...new Set(sourceUrls)],
    4,
    async (url, i) => {
      const r = await source(url, join(output, "sources"), `source-${i}`);
      return Object.fromEntries(
        Object.entries(r).filter(([k]) => k !== "body"),
      );
    },
  );
  const sourceByUrl = new Map(sourceResults.map((s) => [s.url, s]));
  const rows = await pooled(endpoints, 6, async (e, i) => {
    const group = matchGroup(e.url),
      solana = String(e.chainId) === "1151111081099710";
    const id = await rpc(
      e.url,
      solana ? "getSlot" : "eth_chainId",
      solana ? [{ commitment: "finalized" }] : [],
      join(output, "health"),
      `endpoint-${i}-identity`,
      50000,
    );
    let health;
    if (!id.ok)
      health = {
        ...id,
        httpStatus: id.status ?? null,
        status: "UNAVAILABLE",
        checkedAt: new Date().toISOString(),
      };
    else if (
      !solana &&
      (!/^0x[0-9a-f]+$/i.test(id.value) ||
        BigInt(id.value) !== BigInt(e.chainId))
    )
      health = {
        status: "CHAIN_MISMATCH",
        checkedAt: new Date().toISOString(),
        observedChainId: id.value,
        record: id.record,
      };
    else if (solana)
      health = {
        status: "OBSERVED_READABLE",
        checkedAt: new Date().toISOString(),
        finalizedSlot: id.value,
        latencyMs: id.durationMs,
        record: id.record,
      };
    else {
      const head = await rpc(
        e.url,
        "eth_getBlockByNumber",
        ["latest", false],
        join(output, "health"),
        `endpoint-${i}-head`,
        8000000,
      );
      const block = head.value;
      const ageSeconds =
        block?.timestamp && /^0x[0-9a-f]+$/i.test(block.timestamp)
          ? Math.round(Date.now() / 1000 - Number(BigInt(block.timestamp)))
          : null;
      health = {
        status: !head.ok
          ? "HEAD_UNAVAILABLE"
          : !block?.hash || !block?.number || ageSeconds === null
            ? "INVALID_HEAD"
            : ageSeconds < -60 || ageSeconds > 600
              ? "STALE_OR_CLOCK_MISMATCH"
              : "OBSERVED_READABLE",
        checkedAt: new Date().toISOString(),
        observedChainId: id.value,
        block: block?.number,
        blockHash: block?.hash,
        ageSeconds,
        latencyMs: (id.durationMs ?? 0) + (head.durationMs ?? 0),
        records: [id.record, head.record],
        error: head.ok ? null : head.error,
      };
    }
    return {
      chain: String(e.chainId),
      endpoint: e.url,
      operator: group?.operator ?? "UNKNOWN",
      inventoryGroup: group?.operatorGroup ?? null,
      independentOperatorGroup:
        group?.provenance === "unknown"
          ? null
          : (group?.backingOperatorGroup ?? group?.operatorGroup ?? null),
      operatorEvidence: group?.officialDocsUrl ?? null,
      credentialRequired:
        "NO_CREDENTIAL_IN_CONFIG; provider may require an account for production",
      archiveSupport: {
        snapshotClaim: e.archive ?? null,
        currentVerification: "NOT_PROBED_HISTORICAL_STATE",
      },
      logSupport: {
        snapshotClaim: e.supportsLogs ?? null,
        maxLogRange: e.maxLogRange ?? null,
        currentVerification: "NOT_PROBED_EXCEPT_TARGETED_WITNESSES",
      },
      quota: {
        legacyInventoryClaim: group?.rateLimitNotes || null,
        currentContractQuota: "OWNER_VENDOR_CONFIRMATION_REQUIRED",
      },
      termsUrl: group?.termsUrl ?? null,
      privacyUrl: group?.privacyUrl ?? null,
      termsSource: sourceByUrl.get(group?.termsUrl) ?? null,
      privacySource: sourceByUrl.get(group?.privacyUrl) ?? null,
      commercialUse: {
        inheritedStatus: group?.commercialUseStatus ?? "UNKNOWN",
        inheritedEvidence: group?.commercialUseEvidence ?? null,
        currentApproval: "OWNER_COUNSEL_REVIEW_REQUIRED",
      },
      loggingPrivacy:
        "Owner/vendor must confirm request payload, IP/address logging, region, retention, sub-processors, deletion and DPA for the selected account/tier; fetching a privacy page is not verification",
      previousTermsState: group?.reviewStatus ?? "UNKNOWN",
      productionApproval: "BLOCKED_PENDING_OWNER_LEGAL_REFERENCE",
      health,
      priorOriginOnly: e.previousMatrixOriginOnly ?? false,
      ownerAction: `OWNER ACTION: select or reject ${e.url} for chain ${e.chainId}; supply operator identity/backing group, exact production plan quota and permitted archive/Transfer-topic log depth/range, commercial-use and caching/redistribution permission, privacy/logging/DPA review and dated legalReviewRef; then re-probe the exact endpoint before production admission.`,
    };
  });
  const probes = [];
  for (const [chain, pair] of [
    [
      "42161",
      [
        "https://arb1.arbitrum.io/rpc",
        "https://arbitrum-one-rpc.publicnode.com",
      ],
    ],
    [
      "43114",
      [
        "https://api.avax.network/ext/bc/C/rpc",
        "https://avalanche-c-chain-rpc.publicnode.com",
      ],
    ],
  ]) {
    let block;
    const primary = await rpc(
      pair[0],
      "eth_getBlockByNumber",
      ["finalized", false],
      join(output, "witness"),
      `${chain}-finalized`,
      4000000,
    );
    if (primary.ok && primary.value?.number) block = primary.value.number;
    if (!block) {
      probes.push({ chain, status: "PRIMARY_FINALIZED_UNAVAILABLE", primary });
      continue;
    }
    for (const [j, endpoint] of pair.entries()) {
      const header = await rpc(
        endpoint,
        "eth_getBlockByNumber",
        [block, false],
        join(output, "witness"),
        `${chain}-${j}-header`,
        4000000,
      );
      const logs = await rpc(
        endpoint,
        "eth_getLogs",
        [{ fromBlock: block, toBlock: block, topics: [TRANSFER] }],
        join(output, "witness"),
        `${chain}-${j}-transfer-logs`,
        16000000,
      );
      const filtered = await rpc(
        endpoint,
        "eth_getLogs",
        [
          {
            fromBlock: block,
            toBlock: block,
            address:
              chain === "42161"
                ? "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
                : "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
            topics: [TRANSFER],
          },
        ],
        join(output, "witness"),
        `${chain}-${j}-address-filtered-logs`,
        1000000,
      );
      probes.push({
        chain,
        endpoint,
        block,
        finalizedPrimaryHash: primary.value.hash,
        exactHeaderMatches:
          header.ok && header.value?.hash === primary.value.hash,
        exactTransferTopicRequest:
          logs.ok && Array.isArray(logs.value) ? "PASS" : "FAIL",
        logCount: Array.isArray(logs.value) ? logs.value.length : null,
        logsSha256: logs.ok ? sha256(JSON.stringify(logs.value)) : null,
        logError: logs.ok ? null : logs.error,
        addressFilteredControl:
          filtered.ok && Array.isArray(filtered.value) ? "PASS" : "FAIL",
        controlLogCount: Array.isArray(filtered.value)
          ? filtered.value.length
          : null,
        evidence: [header.record, logs.record, filtered.record],
        note: "One finalized block only. Address-filtered success cannot satisfy complete Transfer-topic witness coverage. No archive depth or sustained quota guarantee follows.",
      });
    }
  }
  const candidates = [
    {
      provider: "Quicknode",
      legalEntity: "Quiknode, Inc. (confirm contracting entity on order form)",
      independentOperatorGroup: "quicknode",
      chains: ["42161", "43114"],
      endpoint:
        "Account-generated private HTTPS URL: obtain exact Arbitrum One Mainnet and Avalanche C-Chain Mainnet endpoint strings from dashboard; do not invent hostname/token",
      accountRequired: true,
      tier: "Paid plan required for >5 block log windows; current per-chain order form must confirm 10,000 block allowance",
      logLimits:
        "Official support: free trial 5 blocks, paid plans 10,000 blocks; chain/account exceptions require written confirmation",
      archive:
        "Official supported-node table lists Arbitrum and Avalanche Mainnet archive=yes, pruning=none",
      technicalStatus:
        "DOCUMENTED_TECHNICALLY_VIABLE; EXACT_OWNER_ENDPOINT_NOT_PROBED",
      independentOf: [
        "offchain-labs-arbitrum",
        "avalanche-public-api",
        "allnodes-publicnode",
        "alchemy",
      ],
      termsUrl: "https://www.quicknode.com/terms",
      privacyUrl: "https://www.quicknode.com/privacy",
      pricingUrl: "https://www.quicknode.com/pricing",
      documentationUrl:
        "https://www.quicknode.com/docs/platform/supported-chains-node-types",
      quotaUrl:
        "https://support.quicknode.com/articles/3261121056-understanding-the-10-000-block-range-limit-for-querying-logs-and-events",
      ownerActionId: "V117-RPC-QUICKNODE-WITNESS",
    },
    {
      provider: "Alchemy",
      legalEntity:
        "Alchemy Insights, Inc. (confirm contracting entity on order form)",
      independentOperatorGroup: "alchemy",
      chains: ["42161", "43114"],
      endpointTemplates: [
        "https://arb-mainnet.g.alchemy.com/v2/<OWNER_SECRET>",
        "https://avax-mainnet.g.alchemy.com/v2/<OWNER_SECRET>",
      ],
      accountRequired: true,
      tier: "Pay As You Go candidate; obtain chain-specific Transfer-topic range, response-size, request throughput/CU and historical-state access confirmation",
      logLimits:
        "Chain-specific API docs govern. Do not apply Ethereum or generic major-chain limits blindly to Avalanche/Arbitrum",
      archive:
        "Owner/vendor must confirm oldest required exact state block and retention on selected plan",
      technicalStatus:
        "DOCUMENTED_TECHNICALLY_VIABLE; EXACT_OWNER_ENDPOINT_NOT_PROBED",
      independentOf: [
        "offchain-labs-arbitrum",
        "avalanche-public-api",
        "allnodes-publicnode",
        "quicknode",
      ],
      termsUrl: "https://legal.alchemy.com/",
      privacyUrl: "https://www.alchemy.com/privacy-policy",
      pricingUrl: "https://www.alchemy.com/pricing",
      documentationUrls: [
        "https://www.alchemy.com/docs/reference/arbitrum-api-quickstart",
        "https://www.alchemy.com/docs/reference/node-supported-chains",
      ],
      quotaUrls: [
        "https://www.alchemy.com/docs/chains/arbitrum/arbitrum-api-endpoints/eth-get-logs",
        "https://www.alchemy.com/docs/chains/avalanche/avalanche-api-endpoints/eth-get-logs",
      ],
      ownerActionId: "V117-RPC-ALCHEMY-WITNESS",
    },
  ];
  const actions = candidates.map((c) => ({
    id: c.ownerActionId,
    owner: "Production owner + vendor account administrator + counsel",
    status: "OWNER ACTION",
    requiredInput: `Create/select ${c.provider} ${c.tier}; provide exact server-only endpoint secret references for chain IDs 42161 and 43114, dated plan/order-form proof of complete Transfer-topic eth_getLogs without address restriction, oldest required finalized historical header/log/state access, range/response cap, sustained RPS/CU quota and monthly spend ceiling; vendor operator/subcontractor attestation excluding reuse of the selected primary/operator group; IP/request/address logging retention/region/DPA and written commercial-use/indexing/cache/redistribution review with legalReviewRef. Do not put secrets in docs or evidence.`,
    successCheck:
      "Read-only chain ID + finalized exact-header agreement + one exact-topic finalized window + one oldest-required window + normalized log-set digest agreement against an independent primary; neither empty success nor address-filtered logs proves complete witness. Release admission is a separate reviewed owner action.",
    evidence: [c.termsUrl, c.privacyUrl, c.pricingUrl],
    noAutomaticActivation: true,
  }));
  actions.push({
    id: "V117-RPC-TERMS-RELEASE",
    owner: "Production owner + counsel",
    status: "OWNER ACTION",
    requiredInput:
      "Choose the exact production RPC subset from rpc-release-matrix.json, reject every unused endpoint, review the selected service/order form and privacy/DPA for commercial wallet/address reads, indexing, caching/redistribution, rate limits and retention; provide dated legalReviewRef and operator/backing-group evidence for EACH admitted endpoint. Missing/unknown terms or operator remains blocked. This evidence does not self-approve any group.",
    successCheck:
      "Existing release provenance validator admits only reviewed exact endpoints and independently attributable operators; no production fallback to staging/unknown groups.",
    noAutomaticActivation: true,
  });
  const result = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    method:
      "Credential-independent read-only identity/latest-head probe over committed snapshot union accepted V1.16 matrix, plus targeted identical finalized one-block Transfer-topic log probes. No accounts purchased, no endpoints activated, no terms self-approved.",
    inventorySource: "src/data/registry/rpc-provenance.json",
    inheritedInventoryObservedAt: inventory.observedAt,
    rows,
    witnessProbes: probes,
    candidates,
    ownerActions: actions,
    termsFetches: sourceResults,
    productionApproved: 0,
    sourceSnapshotSha256: sha256(snapshotBytes),
    sourceProvenanceSha256: sha256(provenanceBytes),
    publicRpcWrites: 0,
    signatures: 0,
    broadcasts: 0,
  };
  writeNew(join(output, "rpc-release-matrix.json"), result);
  writeNew(join(output, "owner-actions.json"), {
    schemaVersion: 1,
    ownerActions: actions,
  });
  return {
    endpoints: rows.length,
    readable: rows.filter((r) => r.health.status === "OBSERVED_READABLE")
      .length,
    blocked: rows.length,
    witnessProbes: probes.map((p) => ({
      chain: p.chain,
      endpoint: p.endpoint,
      status: p.exactTransferTopicRequest ?? p.status,
    })),
  };
}

export async function finalizeEvidence(output) {
  const rpcDir = join(output, "RPC"),
    whirlDir = join(output, "Whirlpool");
  const matrix = JSON.parse(
    readFileSync(join(rpcDir, "rpc-release-matrix.json"), "utf8"),
  );
  const excluded = matrix.rows.filter((r) =>
    [
      "https://mainnet.crosstoken.io",
      "https://mainnet.onechain.nexus",
    ].includes(r.endpoint),
  );
  matrix.rows = matrix.rows.filter((r) => !excluded.includes(r));
  for (const r of matrix.rows)
    if (typeof r.health.status === "number") {
      r.health.httpStatus = r.health.status;
      r.health.status = "UNAVAILABLE";
    }
  const policy = readFileSync(join(ROOT, "src/g7/policy.ts"), "utf8");
  const nodeReal = policy.match(
    /https:\/\/bsc-mainnet\.nodereal\.io\/v1\/[a-z0-9]+/,
  )?.[0];
  const exact = [
    [
      "612055",
      "https://mainnet.crosstoken.io:22001",
      "ONEchain official RPC; contracting legal entity and shared backing operator unverified",
      null,
    ],
    [
      "612055",
      "https://mainnet.onechain.nexus:22001",
      "ONEchain official RPC; contracting legal entity and shared backing operator unverified",
      null,
    ],
    ...(nodeReal
      ? [
          [
            "56",
            nodeReal,
            "NodeReal (G7 logs-only source; contracting entity owner/vendor confirmation required)",
            "nodereal-logs-only",
          ],
        ]
      : []),
  ];
  for (const [i, [chain, endpoint, operator, group]] of exact.entries()) {
    if (matrix.rows.some((r) => r.endpoint === endpoint)) continue;
    const identity = await rpc(
      endpoint,
      "eth_chainId",
      [],
      join(rpcDir, "health"),
      `exact-g7-${i}-identity`,
      100000,
    );
    const head = identity.ok
      ? await rpc(
          endpoint,
          "eth_getBlockByNumber",
          ["latest", false],
          join(rpcDir, "health"),
          `exact-g7-${i}-head`,
          4000000,
        )
      : null;
    const valid =
      identity.ok &&
      /^0x[0-9a-f]+$/i.test(identity.value) &&
      BigInt(identity.value) === BigInt(chain) &&
      head?.ok &&
      head.value?.hash;
    matrix.rows.push({
      chain,
      endpoint: safeEndpoint(endpoint),
      operator,
      independentOperatorGroup: group,
      operatorEvidence:
        "src/g7/policy.ts (accepted runtime role; not legal approval)",
      credentialRequired: group
        ? "Existing public-registry token is redacted; owner must supply production account/secret reference"
        : "No credential in accepted runtime URL",
      archiveSupport: { currentVerification: "NOT_PROBED_HISTORICAL_STATE" },
      logSupport: {
        currentVerification: "NOT_PROBED_HISTORICAL_LOGS",
        runtimeRole: group ? "G7_LOGS_ONLY_NEVER_STATE_VOTE" : "G7_STATE",
      },
      quota: { currentContractQuota: "OWNER_VENDOR_CONFIRMATION_REQUIRED" },
      termsUrl: null,
      privacyUrl: null,
      commercialUse: { currentApproval: "OWNER_COUNSEL_REVIEW_REQUIRED" },
      loggingPrivacy: "OWNER_VENDOR_RETENTION_DPA_CONFIRMATION_REQUIRED",
      productionApproval: "BLOCKED_PENDING_OWNER_LEGAL_REFERENCE",
      health: {
        status: valid ? "OBSERVED_READABLE" : "UNAVAILABLE",
        observedChainId: identity.value ?? null,
        block: head?.value?.number ?? null,
        blockHash: head?.value?.hash ?? null,
        checkedAt: new Date().toISOString(),
        records: [identity.record, head?.record].filter(Boolean),
      },
      ownerAction: `OWNER ACTION: confirm exact ${safeEndpoint(endpoint)} service operator/contracting entity and backing group, production plan/quota, required historical log/header access and commercial indexing/caching permission, privacy/logging retention/DPA, dated legalReviewRef and server-only credential reference if applicable. Re-probe exact runtime endpoint before admission.`,
    });
  }
  const archiveAction = {
    id: "V117-RPC-PUBLICNODE-ARBITRUM",
    owner: "Production owner + Allnodes account administrator + counsel",
    status: "OWNER ACTION",
    requiredInput:
      "Obtain a personal PublicNode token via https://www.allnodes.com/publicnode for Arbitrum One chain 42161. Supply a server-only secret reference and exact token-authenticated archive endpoint; vendor must confirm the selected account tier, complete Transfer-topic eth_getLogs without address restriction for the configured 20,000-block recent-history floor, maximum log range/response size, RPS/monthly quota and commercial indexing/cache/redistribution permission, request/IP/address logging retention/region/DPA. Record dated legalReviewRef. No specific paid tier is invented because the unauthenticated public page does not expose the account-specific archive entitlement.",
    evidence:
      "witness/42161-1-transfer-logs.json: RPC -32602 Archive requests require a personal token",
    successCheck:
      "Same exact safe/finalized header as independent Offchain Labs primary plus matching complete normalized Transfer log set at current window and oldest required window. One successful address-filtered request is insufficient.",
    noAutomaticActivation: true,
  };
  matrix.ownerActions.push(archiveAction);
  const qn = matrix.candidates.find((c) => c.provider === "Quicknode");
  qn.tier =
    "Build candidate: official pricing currently 80M API credits/month, 50 requests/s, 10 endpoints; obtain final account/order form, spend cap and per-chain method weighting before any purchase";
  qn.pricingObservation =
    "2026-10-15 official pricing displayed USD49 monthly or USD34/month billed annually; no account purchased or payment authorized";
  matrix.supersedes =
    "rpc-release-matrix.json remains immutable acquisition evidence. This final matrix normalizes HTTP failure status and replaces two host-only ONE control probes with exact runtime :22001 endpoints, adds accepted NodeReal logs-only role.";
  matrix.excludedHostOnlyControlProbes = excluded;
  matrix.finalizedAt = new Date().toISOString();
  writeNew(join(rpcDir, "rpc-release-matrix-final.json"), matrix);
  writeNew(join(rpcDir, "owner-actions-final.json"), {
    schemaVersion: 1,
    ownerActions: matrix.ownerActions,
  });
  const idl = JSON.parse(
    readFileSync(join(whirlDir, "idl-and-audit-review-final.json"), "utf8"),
  );
  const comparisons = idl.sdkInstructions.map((sdk) => {
    const chain = idl.observations[0]?.instructions.find(
      (ix) => ix.name === sdk.name,
    );
    return {
      instruction: sdk.name,
      discriminatorMatches:
        JSON.stringify(sdk.discriminator) ===
        JSON.stringify(chain?.discriminator),
      argumentsMatch: JSON.stringify(sdk.args) === JSON.stringify(chain?.args),
      sdkAccounts: sdk.accounts,
      onchainAccounts: chain?.accounts ?? null,
      commonPrefixMatches: sdk.accounts.every(
        (a, i) => chain?.accounts[i] === a,
      ),
      extraOnchainAccounts: chain?.accounts.slice(sdk.accounts.length) ?? [],
      conclusion: "IDL_SHAPE_DIFF_REQUIRES_SOURCE_AND_BINARY_SEMANTIC_REVIEW",
    };
  });
  writeNew(join(whirlDir, "instruction-and-audit-comparison.json"), {
    schemaVersion: 1,
    classification: "UNVERIFIED_UPSTREAM_CHANGE",
    routeStatus: "BUILD_REVIEW_REQUIRED",
    comparisons,
    sdkIdlSha256: sha256(readFileSync(join(whirlDir, "sdk-idl.body"))),
    onchainIdlSha256: idl.observations[0]?.decodedSha256 ?? null,
    independentOnchainIdlAgreement:
      idl.observations.length === 2 &&
      idl.observations.every(
        (o) => o.decodedSha256 === idl.observations[0].decodedSha256,
      ),
    auditReview: [
      {
        date: "2026-08-11",
        auditor: "Sec3",
        scope:
          "PR1311 ad183d8..272c70a; PR1317 prepare/commit 8cea584..1fe7341; PR1326 u256 division fix 14d4834..950d7a8",
        result:
          "One informational TransferFee mint reinitialization issue in prepare/commit, resolved. No issue in the other two reviewed PRs.",
        relevance:
          "Prepare/commit is additional instruction surface and not admitted by current swap/swap_v2 route review; preserve rejection of unsupported Token-2022 extensions and unknown CPI families.",
      },
      {
        date: "2026-08-18",
        auditor: "Sec3",
        scope: "PR1366 rent reduction / Agave4.2 e5ee72f..d12f6ac",
        result:
          "Informational possible wSOL reward-collection DoS after rent fallback, acknowledged.",
        relevance:
          "Incremental rent/reward scope; not deployed swap economic compatibility proof.",
      },
      {
        date: "2026-09-30",
        auditor: "Sec3",
        scope:
          "PR1392 SIMD-0460 virtual address space 59f4c4c..b823c8d; PR1396 checkpoint update 90333c1..5207a03",
        result:
          "No issue in PR1392; one informational reward accrual rounding effect acknowledged in PR1396.",
        relevance:
          "Incremental source-only review. Report excludes economic design/algorithm soundness; no mapping to current deployed executable hash.",
      },
    ],
    sourceBinaryBinding: "NOT_PROVEN",
    autoActivated: false,
    publicRpcWrites: 0,
  });
  return {
    endpoints: matrix.rows.length,
    readable: matrix.rows.filter((r) => r.health.status === "OBSERVED_READABLE")
      .length,
    health: matrix.rows.reduce((a, r) => {
      a[r.health.status] = (a[r.health.status] ?? 0) + 1;
      return a;
    }, {}),
    instructionComparisons: comparisons,
  };
}

export async function reviewRpcHistory(output) {
  const matrix = JSON.parse(
    readFileSync(join(output, "rpc-release-matrix.json"), "utf8"),
  );
  const tiers = JSON.parse(
    readFileSync(join(ROOT, "src/data/registry/tiers.json"), "utf8"),
  );
  const depth = tiers.fullIndexedStart.blocks;
  const digest = (logs) =>
    sha256(
      JSON.stringify(
        logs
          .map((l) => ({
            blockHash: l.blockHash,
            transactionHash: l.transactionHash,
            transactionIndex: l.transactionIndex,
            logIndex: l.logIndex,
            address: l.address,
            topics: l.topics,
            data: l.data,
            removed: l.removed,
          }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ),
    );
  const probes = await pooled(matrix.witnessProbes, 2, async (prior, i) => {
    if (!prior.block)
      return { chain: prior.chain, status: "NO_FINALIZED_ANCHOR" };
    const block =
      "0x" + (BigInt(prior.block) - BigInt(depth) + 1n).toString(16);
    const header = await rpc(
      prior.endpoint,
      "eth_getBlockByNumber",
      [block, false],
      join(output, "witness"),
      `history-floor-${i}-header`,
      4000000,
    );
    const logs = await rpc(
      prior.endpoint,
      "eth_getLogs",
      [{ fromBlock: block, toBlock: block, topics: [TRANSFER] }],
      join(output, "witness"),
      `history-floor-${i}-logs`,
      16000000,
    );
    return {
      chain: prior.chain,
      endpoint: prior.endpoint,
      configuredRecentWindowBlocks: depth,
      anchorBlock: prior.block,
      sampledFloorBlock: block,
      headerHash: header.value?.hash ?? null,
      headerStatus: header.ok ? "PASS" : "FAIL",
      logStatus: logs.ok && Array.isArray(logs.value) ? "PASS" : "FAIL",
      logCount: Array.isArray(logs.value) ? logs.value.length : null,
      normalizedDigest: Array.isArray(logs.value) ? digest(logs.value) : null,
      error: logs.ok ? null : logs.error,
      evidence: [header.record, logs.record],
    };
  });
  const agreement = ["42161", "43114"].map((chain) => {
    const pair = probes.filter((p) => p.chain === chain);
    return {
      chain,
      sampledFloorAgreement:
        pair.length === 2 &&
        pair.every(
          (p) =>
            p.headerStatus === "PASS" &&
            p.logStatus === "PASS" &&
            p.headerHash === pair[0].headerHash &&
            p.normalizedDigest === pair[0].normalizedDigest,
        ),
      comparisonScope:
        "One oldest-configured recent-window block only, not all intervening windows or older persisted index windows",
    };
  });
  const result = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    probes,
    agreement,
    allConfiguredWindowsVerified: false,
    noProductionAdmission: true,
    publicRpcWrites: 0,
  };
  writeNew(join(output, "witness-history-floor.json"), result);
  return result;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const mode = process.argv[2],
    out = process.argv[3];
  if (
    ![
      "rpc",
      "whirlpool",
      "whirlpool-supplement",
      "finalize",
      "history",
      "all",
    ].includes(mode) ||
    !out
  )
    throw Error(
      "Usage: node scripts/v117-upstream-review.mjs rpc|whirlpool|whirlpool-supplement|finalize|history|all NEW_OUTPUT_DIRECTORY",
    );
  const output = resolve(ROOT, out);
  if (
    !output.startsWith(resolve(ROOT, "evidence/otherbridge-v1-17") + "/") &&
    !output.startsWith(resolve(ROOT, "evidence/otherbridge-v1-17") + "\\")
  )
    throw Error("V117_EVIDENCE_DIRECTORY_REQUIRED");
  if (mode === "rpc" || mode === "all")
    console.log(JSON.stringify({ rpc: await reviewRpc(join(output, "RPC")) }));
  if (mode === "whirlpool" || mode === "all")
    console.log(
      JSON.stringify({
        whirlpool: await reviewWhirlpool(join(output, "Whirlpool")),
      }),
    );
  if (mode === "whirlpool-supplement" || mode === "all")
    console.log(
      JSON.stringify({
        whirlpoolSupplement: await reviewWhirlpoolSupplement(
          join(output, "Whirlpool"),
        ),
      }),
    );
  if (mode === "finalize" || mode === "all")
    console.log(JSON.stringify({ final: await finalizeEvidence(output) }));
  if (mode === "history" || mode === "all")
    console.log(
      JSON.stringify({ history: await reviewRpcHistory(join(output, "RPC")) }),
    );
}
