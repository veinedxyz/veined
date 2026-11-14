import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { safeSvg, safeLogoUrl } from "../src/routing/asset-security.ts";
const base = process.env.OTHERBRIDGE_EVIDENCE_ROOT;
if (!base)
  throw Error("Set OTHERBRIDGE_EVIDENCE_ROOT to a unique evidence directory");
await mkdir(base, { recursive: true });
await mkdir("public/networks/catalog", { recursive: true });
const url = "https://li.quest/v1/chains?chainTypes=EVM,SVM,UTXO,MVM,TVM,STL";
async function bounded(url, limit = 262144) {
  const r = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw Error(`HTTP_${r.status}`);
  const reader = r.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw Error("TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes: Buffer.concat(chunks), type: r.headers.get("content-type") };
}
const response = await bounded(url, 4000000);
const raw = JSON.parse(response.bytes.toString());
const records = [],
  assets = {};
const now = new Date().toISOString();
let previous = {};
try {
  previous = JSON.parse(
    await readFile("src/routing/generated-assets.json", "utf8"),
  );
} catch {}
for (const c of raw.chains) {
  const id = String(c.id),
    record = { id, name: c.name, url: c.logoURI, observedAt: now };
  try {
    if (!safeLogoUrl(c.logoURI)) throw Error("URL_REJECTED");
    const { bytes, type } = await bounded(c.logoURI);
    const svg = type?.split(";")[0] === "image/svg+xml";
    const png =
      type?.split(";")[0] === "image/png" &&
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (
      png &&
      (bytes.length < 24 ||
        bytes.readUInt32BE(16) > 1024 ||
        bytes.readUInt32BE(20) > 1024)
    )
      throw Error("IMAGE_DIMENSIONS_REJECTED");
    if (!svg && !png) throw Error("CONTENT_TYPE_REJECTED");
    const text = bytes.toString("utf8");
    if (svg && !safeSvg(text)) throw Error("SVG_REJECTED");
    const hash = createHash("sha256").update(bytes).digest("hex"),
      ext = svg ? "svg" : "png",
      logo = `/networks/catalog/${id}-${hash.slice(0, 16)}.${ext}`;
    try {
      await access(`public${logo}`);
      if (
        createHash("sha256")
          .update(await readFile(`public${logo}`))
          .digest("hex") !== hash
      )
        throw Error("CACHED_ASSET_HASH_MISMATCH");
    } catch {
      await writeFile(`public${logo}`, bytes, { flag: "wx" });
    }
    const colors = svg
      ? [...text.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)].map((m) =>
          m[1].length === 3 ? "#" + [...m[1]].map((c) => c + c).join("") : m[0],
        )
      : [];
    const primary =
      colors.find((c) => !/^#(000000|ffffff)$/i.test(c)) ?? "#90938d";
    const rgb = [1, 3, 5].map((i) => parseInt(primary.slice(i, i + 2), 16));
    const palettes = colors.map((c) =>
      [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)),
    );
    const logoSurface =
      svg && (!palettes.length || palettes.every((c) => Math.max(...c) < 70))
        ? "#e8e9e5"
        : palettes.length && palettes.every((c) => Math.min(...c) > 220)
          ? "#25272b"
          : "transparent";
    assets[id] = {
      logo,
      primary,
      accent: primary,
      glow: rgb.join(" "),
      badgeDark: "#d0d1cc",
      badgeLight: "#43453f",
      logoSurface,
      provenance: `Catalog repository; ${hash}`,
    };
    Object.assign(record, {
      status: "CACHED",
      logo,
      sha256: hash,
      bytes: bytes.length,
      primary,
      logoSurface,
      colorSource: colors.length
        ? "SVG palette; ambient derived, not brand claim"
        : "Neutral; no palette inferred",
    });
  } catch (e) {
    assets[id] = previous[id] ?? {
      logo: "/networks/neutral.svg",
      primary: "#90938d",
      accent: "#b7baaf",
      glow: "144 147 141",
      badgeDark: "#d0d1cc",
      badgeLight: "#43453f",
      logoSurface: "transparent",
      provenance: "Neutral geometry; reviewed asset unavailable",
    };
    Object.assign(record, { status: "UNAVAILABLE", reason: e.message });
  }
  records.push(record);
  console.log(c.name, record.status);
}
await writeFile(
  `${base}/asset-sync.json`,
  JSON.stringify(
    {
      at: now,
      url,
      chainsSha256: createHash("sha256").update(response.bytes).digest("hex"),
      records,
      diff: {
        added: Object.keys(assets).filter((k) => !previous[k]),
        changed: Object.keys(assets).filter(
          (k) =>
            previous[k] &&
            JSON.stringify(previous[k]) !== JSON.stringify(assets[k]),
        ),
        removed: Object.keys(previous).filter((k) => !assets[k]),
      },
      nonDestructive: true,
    },
    null,
    2,
  ),
  { flag: "wx" },
);
// Generated manifest is the sole intended update. Versioned files and curated logos stay.
await writeFile(
  "src/routing/generated-assets.json",
  JSON.stringify({ ...previous, ...assets }, null, 2) + "\n",
);
