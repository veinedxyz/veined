import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { assertSafeSvg } from "./lib/veined-svg-safety.mjs";
import {
  palette as p,
  concepts,
  recommended,
  rubric,
  markGeometry,
  wordGeometry,
  svgDocument,
  iconSvg,
  lockupSvg,
  wordmarkSvg,
} from "./brand-sources/veined-geometry.mjs";

const require = createRequire(import.meta.url);
const nextRequire = createRequire(require.resolve("next/package.json"));
const sharp = nextRequire("sharp");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "public/assets/veined/brand");
const masters = resolve(root, "scripts/brand-sources/masters");
const records = [];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const slash = (value) => value.replaceAll("\\", "/");
const text = (x, y, value, size = 16, color = p.ivory, extra = "") =>
  `<text x="${x}" y="${y}" fill="${color}" font-family="Arial, sans-serif" font-size="${size}" ${extra}>${value}</text>`;

async function emit(path, bytes, details = {}) {
  const destination = resolve(output, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  records.push({
    path: slash(relative(root, destination)),
    bytes: content.length,
    sha256: sha256(content),
    ...details,
  });
}
async function emitSvg(path, source, details = {}) {
  const safety = assertSafeSvg(source);
  await emit(path, source, { format: "svg", ...safety, ...details });
}
async function emitPng(path, svg, width, height = width, details = {}) {
  assertSafeSvg(svg);
  const bytes = await sharp(Buffer.from(svg), { density: 144 })
    .resize(width, height)
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  const info = await sharp(bytes).metadata();
  if (info.width !== width || info.height !== height)
    throw new Error(`Wrong raster size: ${path}`);
  await emit(path, bytes, { format: "png", width, height, ...details });
  return bytes;
}

function appIcon(size, safe = false) {
  const inset = safe ? size * 0.22 : size * 0.13;
  const markSize = size - 2 * inset;
  return svgDocument(
    size,
    size,
    `<rect width="${size}" height="${size}" fill="${p.graphite}"/><g transform="translate(${inset} ${inset}) scale(${markSize / 128})">${markGeometry(recommended, p.sage)}</g>`,
    "VEINED — Quiet Current — owner-review candidate",
  );
}

function social(width, height, banner = false) {
  const unit = width / 1200;
  const iconSize = banner ? 330 : 440;
  const iconX = banner ? 830 : 780;
  const iconY = banner ? 30 : 80;
  const top = banner ? 125 : 182;
  return svgDocument(
    width,
    height,
    `<defs><radialGradient id="ambient"><stop offset="0" stop-color="${p.sageDeep}" stop-opacity=".27"/><stop offset="1" stop-color="${p.graphite}" stop-opacity="0"/></radialGradient></defs><rect width="${width}" height="${height}" fill="${p.graphite}"/><g transform="scale(${unit})"><ellipse cx="1000" cy="250" rx="500" ry="500" fill="url(#ambient)"/><path d="M700 0C550 190 840 300 700 630M760 0C610 190 900 300 760 630M820 0C670 190 960 300 820 630" fill="none" stroke="${p.sage}" stroke-width="1" opacity=".12"/><g transform="translate(72 ${top}) scale(1.58)">${wordGeometry(p.ivory)}</g>${text(73, top + 120, "Multichain Portfolio, Swap &amp; Bridge", 25, p.sage)}<g transform="translate(${iconX} ${iconY}) scale(${iconSize / 128})">${markGeometry(recommended, p.sage)}</g>${text(73, banner ? 342 : 557, "veined.xyz", 18, p.ivory)}${text(73, banner ? 370 : 587, "OWNER-REVIEW CANDIDATE  /  EXECUTION CLOSED", 11, p.muted, 'letter-spacing="2"')}</g>`,
    "VEINED — multichain portfolio, swap and bridge — owner-review candidate",
  );
}

function comparisonSvg() {
  let body = `<rect width="1600" height="1080" fill="${p.graphite}"/>${text(48, 60, "VEINED / THREE ORIGINAL DIRECTIONS", 22, p.ivory, 'letter-spacing="3"')}${text(48, 93, "V1.20 · Recommended candidate: C / Quiet Current · Owner approval remains open", 17, p.muted)}`;
  for (const [index, concept] of concepts.entries()) {
    const x = 40 + index * 520;
    body += `<g transform="translate(${x} 130)"><rect width="500" height="900" rx="20" fill="${p.surface}" stroke="#2b2c32"/>${text(28, 40, `${concept.letter}  /  ${concept.name}`, 17, p.sage, 'letter-spacing="2"')}<g transform="translate(154 76) scale(1.5)">${markGeometry(concept, p.sage)}</g><g transform="translate(54 300) scale(1.7)">${wordGeometry(p.ivory)}</g><rect x="24" y="404" width="452" height="215" rx="12" fill="${p.paper}"/><g transform="translate(57 448) scale(.9)">${markGeometry(concept, p.sageDeep)}</g><g transform="translate(190 490) scale(1.08)">${wordGeometry(p.ink)}</g>${text(28, 669, "ACTUAL PIXEL SIZES", 11, p.muted, 'letter-spacing="2"')}`;
    let px = 28;
    for (const size of [16, 24, 32, 64, 128]) {
      body += `<g transform="translate(${px} ${820 - size}) scale(${size / 128})">${markGeometry(concept, p.sage)}</g>${text(px, 848, `${size}`, 11, p.muted)}`;
      px += size + 22;
    }
    body += `${text(28, 883, `${concept.scores.reduce((a, b) => a + b, 0)} / 100 · ${concept === recommended ? "RECOMMENDED FOR OWNER REVIEW" : "PRESERVED ALTERNATIVE"}`, 11, p.sage)}</g>`;
  }
  return svgDocument(
    1600,
    1080,
    body,
    "VEINED — three original logo concepts and actual-size comparison",
  );
}

function galleryHtml() {
  const cards = concepts
    .map(
      (c) =>
        `<article class="concept" id="${c.id}"><header><p class="eyebrow">Concept ${c.letter}${c === recommended ? " · Recommended" : ""}</p><h2>${c.name}</h2><p>${c.rationale}</p></header><div class="mark-stage"><img src="concepts/${c.id}/icon.svg" alt="${c.name} icon" width="256" height="256"/></div><div class="lockup-stage"><img src="concepts/${c.id}/lockup.svg" alt="VEINED ${c.name} horizontal lockup" width="376" height="96"/></div><div class="light-stage"><img src="concepts/${c.id}/lockup-light.svg" alt="VEINED ${c.name} on light" width="376" height="96"/></div><div class="monos"><div><img src="concepts/${c.id}/mono-white.svg" alt="White monochrome ${c.name}" width="64" height="64"/><span>White</span></div><div class="paper"><img src="concepts/${c.id}/mono-dark.svg" alt="Dark monochrome ${c.name}" width="64" height="64"/><span>Ink</span></div></div><div class="size-grid">${[16, 24, 32, 64, 128, 256].map((n) => `<figure><img src="concepts/${c.id}/preview-${n}.png" alt="${c.name} at ${n} pixels" width="${n}" height="${n}"/><figcaption>${n}px</figcaption></figure>`).join("")}</div><p class="construction">${c.construction}</p><a href="concepts/${c.id}/icon.svg" download>Editable icon SVG <span aria-hidden="true">↗</span></a><a href="concepts/${c.id}/lockup.svg" download>Editable lockup SVG <span aria-hidden="true">↗</span></a></article>`,
    )
    .join("");
  const rows = rubric
    .map(
      (label, index) =>
        `<tr><th scope="row">${label}</th>${concepts.map((c) => `<td>${c.scores[index]}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="robots" content="noindex,nofollow"/><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'"/><title>VEINED — V1.20 owner brand review</title><link rel="stylesheet" href="review.css"/></head><body><a class="skip" href="#concepts">Skip to concepts</a><main><header class="intro"><p class="eyebrow">VEINED / V1.20 / BRAND REVIEW</p><h1>Intelligent by nature.<br/>Precise by design.</h1><p>Three original vector systems, built on VEINED’s graphite, sage and ivory world. The veined octopus inspires coordination, adaptability and multiple routes; the marks remain abstract.</p><div class="status">Recommended candidate: <strong>C — Quiet Current</strong><span>Owner approval open · Execution closed</span></div><nav aria-label="Review sections"><a href="#concepts">Compare concepts</a><a href="#evaluation">Evaluation</a><a href="#exports">Production exports</a></nav></header><section id="concepts" class="concepts" aria-label="Three original concepts">${cards}</section><section id="evaluation" class="evaluation"><p class="eyebrow">ONE CONSISTENT RUBRIC</p><h2>Small scale. Long-term clarity.</h2><p>Designer assessment out of 10 per factor; this is not market research or trademark clearance. Quiet Current has one solid path and preserves its open V at 16px. A tells the eight-route story most explicitly. B is the most architectural, but its narrow channels soften at favicon scale.</p><div class="table-scroll"><table><caption>Equal-weight logo evaluation, 100 points maximum</caption><thead><tr><th scope="col">Factor</th><th scope="col">A</th><th scope="col">B</th><th scope="col">C</th></tr></thead><tbody>${rows}<tr><th scope="row">Total</th>${concepts.map((c) => `<td><strong>${c.scores.reduce((a, b) => a + b, 0)}</strong></td>`).join("")}</tr></tbody></table></div></section><section id="exports"><p class="eyebrow">RECOMMENDED CANDIDATE / REAL EXPORTS</p><h2>A coherent identity at every scale.</h2><img class="social-preview" src="og-image.png" alt="VEINED social preview with the Quiet Current logo, custom wordmark and multichain portfolio, swap and bridge description" width="1200" height="630"/><div class="export-links">${[
    ["primary-logo.svg", "Primary lockup SVG"],
    ["primary-icon.svg", "Icon SVG"],
    ["wordmark-light.svg", "Light wordmark SVG"],
    ["wordmark-dark.svg", "Dark wordmark SVG"],
    ["favicon.ico", "Favicon ICO"],
    ["icon-192.png", "192px app icon"],
    ["icon-512.png", "512px app icon"],
    ["apple-touch-icon.png", "Apple touch icon"],
    ["maskable-icon-512.png", "Maskable PWA icon"],
    ["social-avatar.png", "Social avatar"],
    ["x-banner.png", "X banner"],
    ["github-avatar.png", "GitHub avatar"],
    ["twitter-card.png", "Twitter/X card"],
    ["comparison.png", "Comparison sheet"],
    ["asset-manifest.json", "SHA-256 asset manifest"],
  ]
    .map(
      ([file, title]) =>
        `<a href="${file}" download>${title} <span aria-hidden="true">↗</span></a>`,
    )
    .join(
      "",
    )}</div><p class="notice">The planned handle @veinedxyz is text only. Account control, owner brand approval, external audit and legal clearance remain open. No public release is authorized.</p></section></main><footer>VEINED · Original vector geometry · Local owner review · V1.20</footer></body></html>\n`;
}

const galleryCss = `:root{color-scheme:dark;--bg:#0b0c0f;--surface:#151619;--line:#2b2c32;--text:#f1f0ec;--muted:#b0afb5;--sage:#bdccb9}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.65 Inter,ui-sans-serif,system-ui,sans-serif}main{max-width:1600px;margin:auto;padding:64px 40px}a{color:var(--sage);text-underline-offset:5px}a:focus-visible{outline:3px solid var(--sage);outline-offset:5px;border-radius:3px}.skip{position:absolute;top:-100px;left:20px;background:var(--surface);padding:12px;z-index:2}.skip:focus{top:12px}.intro{max-width:900px;margin-bottom:70px}.eyebrow{font-size:11px;letter-spacing:.17em;color:var(--sage);font-weight:650;margin:0 0 20px}h1{font-size:clamp(36px,5vw,70px);font-weight:500;letter-spacing:-.055em;line-height:1.08;margin:0 0 28px}h2{font-size:27px;letter-spacing:-.035em;line-height:1.15;font-weight:550;margin:0 0 20px}p{color:var(--muted)}.intro>p:not(.eyebrow){font-size:19px;max-width:730px}.status{display:flex;flex-wrap:wrap;gap:4px 10px;border-top:1px solid var(--line);padding-top:24px;margin-top:28px;font-size:14px}.status span{display:block;width:100%;color:var(--muted)}nav{display:flex;gap:24px;flex-wrap:wrap;margin-top:24px;font-size:13px}.concepts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px}.concept{min-width:0;overflow:hidden;border:1px solid var(--line);border-radius:20px;background:var(--surface)}.concept header{padding:30px 28px 0;min-height:250px}.concept header h2{font-size:20px;letter-spacing:.045em}.concept header .eyebrow{margin-bottom:14px}.concept header p:last-child{font-size:14px;margin:0}.mark-stage{display:grid;place-items:center;min-height:285px}.mark-stage img{width:200px;height:200px}.lockup-stage,.light-stage{display:grid;place-items:center;min-height:125px;padding:18px}.lockup-stage img,.light-stage img{width:100%;height:auto;max-width:376px}.light-stage{background:#f6f4f0}.monos{display:grid;grid-template-columns:1fr 1fr}.monos>div{padding:20px;display:flex;align-items:center;justify-content:center;gap:20px;font-size:12px;color:var(--muted)}.monos .paper{background:#f6f4f0;color:#625d66}.size-grid{display:flex;flex-wrap:wrap;align-items:end;gap:25px 18px;padding:30px 28px;border-bottom:1px solid var(--line)}figure{margin:0;display:flex;align-items:center;flex-direction:column;gap:10px}figure img{display:block;max-width:100%;object-fit:contain}figcaption{font-size:11px;color:var(--muted)}.construction{padding:0 28px;font-size:12px;min-height:100px}.concept>a{display:block;margin:0 28px 18px;font-size:13px}.concept>a:last-child{margin-bottom:28px}.evaluation{margin:90px 0}.evaluation>p{max-width:920px}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}caption{text-align:left;font-size:12px;color:var(--muted);padding:12px 0}th,td{border-bottom:1px solid var(--line);padding:13px 18px;text-align:center}th:first-child{text-align:left;font-weight:450}thead th{color:var(--sage)}tbody tr:last-child{background:var(--surface)}.social-preview{width:100%;height:auto;border:1px solid var(--line);border-radius:16px;margin:20px 0}.export-links{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.export-links a{border:1px solid var(--line);border-radius:8px;padding:14px;font-size:13px;text-decoration:none;display:flex;justify-content:space-between;gap:10px}.export-links a:hover{background:var(--surface)}.notice{margin-top:30px;font-size:13px;max-width:1000px}footer{padding:26px 40px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}@media(max-width:1100px){main{padding:40px 24px}.concepts{grid-template-columns:1fr}.concept header{min-height:0}.mark-stage{min-height:250px}.size-grid{justify-content:center}.construction{min-height:0}.concept>a{display:inline-block}.export-links{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:480px){main{padding:32px 18px}.intro>p:not(.eyebrow){font-size:16px}.export-links{grid-template-columns:1fr}.concept header{padding:24px 20px 0}.size-grid{padding:24px 18px}.concept>a{display:block}.monos>div{padding:12px;gap:10px}th,td{padding:10px 8px}footer{padding:24px 18px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}\n`;

async function main() {
  await mkdir(masters, { recursive: true });
  for (const concept of concepts) {
    const prefix = `concepts/${concept.id}`;
    const options = [
      ["icon.svg", iconSvg(concept, p.sage)],
      ["icon-light.svg", iconSvg(concept, p.sageDeep)],
      ["wordmark.svg", wordmarkSvg(p.ivory)],
      ["wordmark-light.svg", wordmarkSvg(p.ink)],
      ["lockup.svg", lockupSvg(concept, p.sage, p.ivory)],
      ["lockup-light.svg", lockupSvg(concept, p.sageDeep, p.ink)],
      ["mono-white.svg", iconSvg(concept, "#ffffff")],
      ["mono-dark.svg", iconSvg(concept, p.ink)],
      ["dark-background.svg", lockupSvg(concept, p.sage, p.ivory, p.graphite)],
      ["light-background.svg", lockupSvg(concept, p.sageDeep, p.ink, p.paper)],
    ];
    for (const [file, svg] of options)
      await emitSvg(`${prefix}/${file}`, svg, {
        concept: concept.name,
        purpose: "owner comparison",
      });
    const master = svgDocument(
      640,
      360,
      `<desc>Editable original geometry. Icon grid 128 by 128. Lettering is six original outlined glyphs spelling VEINED. No embedded font or raster image.</desc><rect width="640" height="360" fill="${p.paper}"/><g transform="translate(36 32) scale(1.5)">${markGeometry(concept, p.sageDeep)}</g><g transform="translate(282 116) scale(1.3)">${wordGeometry(p.ink)}</g><g transform="translate(36 260) scale(.55)">${markGeometry(concept, p.ink)}</g><g transform="translate(130 275) scale(1.4)">${wordGeometry(p.ink)}</g>`,
      `VEINED ${concept.name} editable master`,
    );
    assertSafeSvg(master);
    await writeFile(resolve(masters, `${concept.id}-master.svg`), master);
    for (const size of [16, 24, 32, 64, 128, 256]) {
      await emitPng(
        `${prefix}/preview-${size}.png`,
        iconSvg(concept, p.sage),
        size,
        size,
        { concept: concept.name, background: "transparent, for dark" },
      );
      await emitPng(
        `${prefix}/preview-light-${size}.png`,
        iconSvg(concept, p.sageDeep),
        size,
        size,
        { concept: concept.name, background: "transparent, for light" },
      );
    }
  }
  for (const [file, svg] of [
    ["primary-logo.svg", lockupSvg(recommended, p.sage, p.ivory)],
    ["logo-on-light.svg", lockupSvg(recommended, p.sageDeep, p.ink)],
    ["primary-icon.svg", iconSvg(recommended, p.sage)],
    ["icon-on-light.svg", iconSvg(recommended, p.sageDeep)],
    ["logo-mono-white.svg", lockupSvg(recommended, "#ffffff", "#ffffff")],
    ["logo-mono-dark.svg", lockupSvg(recommended, p.ink, p.ink)],
    ["wordmark-light.svg", wordmarkSvg(p.ivory)],
    ["wordmark-dark.svg", wordmarkSvg(p.ink)],
    ["favicon.svg", appIcon(64)],
  ])
    await emitSvg(file, svg, {
      concept: recommended.name,
      purpose: "recommended candidate",
    });
  for (const [file, size, safe] of [
    ["icon-192.png", 192, false],
    ["icon-512.png", 512, false],
    ["apple-touch-icon.png", 180, false],
    ["maskable-icon-512.png", 512, true],
    ["social-avatar.png", 1024, false],
    ["github-avatar.png", 512, false],
  ]) {
    await emitPng(file, appIcon(size, safe), size, size, {
      concept: recommended.name,
      maskable: safe,
    });
  }
  const icoImages = [];
  for (const size of [16, 32, 48, 64])
    icoImages.push(
      await sharp(Buffer.from(appIcon(size)))
        .png({ compressionLevel: 9 })
        .toBuffer(),
    );
  const icoHeader = Buffer.alloc(6 + icoImages.length * 16);
  icoHeader.writeUInt16LE(1, 2);
  icoHeader.writeUInt16LE(icoImages.length, 4);
  let offset = icoHeader.length;
  for (const [index, bytes] of icoImages.entries()) {
    const size = [16, 32, 48, 64][index];
    const entry = 6 + index * 16;
    icoHeader[entry] = size;
    icoHeader[entry + 1] = size;
    icoHeader.writeUInt16LE(1, entry + 4);
    icoHeader.writeUInt16LE(32, entry + 6);
    icoHeader.writeUInt32LE(bytes.length, entry + 8);
    icoHeader.writeUInt32LE(offset, entry + 12);
    offset += bytes.length;
  }
  await emit("favicon.ico", Buffer.concat([icoHeader, ...icoImages]), {
    format: "ico",
    frames: [16, 32, 48, 64],
    encoding: "PNG frames",
  });
  await emitPng("og-image.png", social(1200, 630), 1200, 630);
  await emitPng("twitter-card.png", social(1200, 630), 1200, 630);
  await emitPng("x-banner.png", social(1500, 500, true), 1500, 500);
  for (const [file, width, height, banner] of [
    ["social-card-master.svg", 1200, 630, false],
    ["x-banner-master.svg", 1500, 500, true],
  ]) {
    const source = social(width, height, banner);
    assertSafeSvg(source);
    await writeFile(resolve(masters, file), source);
  }
  await emitSvg("comparison.svg", comparisonSvg(), {
    purpose: "owner comparison artboard",
  });
  await emitPng("comparison.png", comparisonSvg(), 1600, 1080, {
    purpose: "owner comparison artboard",
  });
  await emit("review.html", galleryHtml(), {
    format: "html",
    purpose: "local owner review gallery",
  });
  await emit("review.css", galleryCss, {
    format: "css",
    purpose: "gallery stylesheet",
  });
  const sourcePaths = [
    "scripts/v120-brand-assets.mjs",
    "scripts/lib/veined-svg-safety.mjs",
    "scripts/lib/veined-svg-safety.d.mts",
    "scripts/brand-sources/veined-geometry.mjs",
    ...(await readdir(masters)).map(
      (name) => `scripts/brand-sources/masters/${name}`,
    ),
  ];
  const sources = [];
  for (const path of sourcePaths) {
    const bytes = await readFile(resolve(root, path));
    sources.push({
      path,
      bytes: bytes.length,
      sha256: sha256(bytes),
      ...(path.endsWith(".svg") ? assertSafeSvg(bytes.toString()) : {}),
    });
  }
  records.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
    schemaVersion: 1,
    milestone: "VEINED V1.20",
    candidate: recommended.name,
    status: "RECOMMENDED_FOR_OWNER_REVIEW",
    ownerApproved: false,
    legalClearance: "not asserted",
    socialAccountControl: "unconfirmed",
    provenance: {
      date: "2026-10-25",
      method:
        "Original manually authored cubic and polygonal SVG geometry; six custom outlined VEINED glyphs; local sharp rasterization. No generative raster, tracing, stock logo, external font or network request.",
      generator: "node scripts/v120-brand-assets.mjs",
      sharp: sharp.versions.sharp,
      saxes: require("saxes/package.json").version,
      paletteSource: "src/app/globals.css and accepted V1.19 visual-system.css",
      socialSupportingType:
        "Arial/system sans-serif rendered locally; the VEINED wordmark itself is font-independent path geometry",
      manifestSelfHash:
        "excluded to avoid recursive self-reference; covered by RC source/evidence inventory",
    },
    evaluation: {
      type: "designer judgment; equal weights; not market research",
      rubric,
      concepts: concepts.map((c) => ({
        id: c.id,
        name: c.name,
        scores: c.scores,
        total: c.scores.reduce((a, b) => a + b, 0),
        rationale: c.rationale,
        construction: c.construction,
      })),
    },
    palette: p,
    sources,
    assets: records,
  };
  await writeFile(
    resolve(output, "asset-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const table = records
    .map(
      (r) =>
        `| \`${r.path.replace("public/assets/veined/brand/", "")}\` | ${r.bytes} | ${r.width ? `${r.width} × ${r.height}` : r.frames ? r.frames.join(", ") : "—"} | \`${r.sha256}\` |`,
    )
    .join("\n");
  await writeFile(
    resolve(root, "docs/VEINED_ASSET_MANIFEST.md"),
    `# VEINED V1.20 asset manifest\n\nRecommended owner-review candidate: **Quiet Current**. Owner approval is open; execution remains closed.\n\nAll public exports live under \`public/assets/veined/brand/\`. Editable source geometry and SVG masters live under \`scripts/brand-sources/\`, inside the existing source-checkpoint inventory scope. Reproduce with \`node scripts/v120-brand-assets.mjs\`; no dependency or lockfile changes are needed.\n\nThe machine-readable \`asset-manifest.json\` records source SHA-256, output SHA-256, dimensions, SVG sanitization and generator versions. The manifest excludes its own hash to avoid self-reference; the RC inventory covers it. Original, font-independent VEINED lettering is path geometry; supporting social-card copy is locally rendered Arial/system sans-serif. No external resources, raster logo traces, scripts or foreignObject are accepted.\n\nLight/dark wordmark names describe the **ink color**: \`wordmark-light.svg\` is ivory for dark backgrounds; \`wordmark-dark.svg\` is graphite for light backgrounds. The icon/lockup \`*-light.svg\` concept variants describe the **target background**. \`primary-logo.svg\` and \`primary-icon.svg\` target dark surfaces. \`logo-on-light.svg\` and \`icon-on-light.svg\` target light surfaces.\n\nThe PWA maskable mark uses a 22% inset and is wholly inside the centered 80%-diameter safe circle. Favicon ICO has 16, 32, 48 and 64 pixel PNG frames. OG and Twitter/X cards are 1200 × 630; X banner is 1500 × 500; social avatar is 1024 × 1024; GitHub avatar is 512 × 512. Planned @veinedxyz is text only, never an active profile link.\n\n${records.length} exported assets; sizes and hashes below are generated from actual bytes.\n\n| Asset | Bytes | Dimensions / ICO frames | SHA-256 |\n| --- | ---: | --- | --- |\n${table}\n`,
  );
  const evidencePointer = resolve(root, ".otherbridge/v120-evidence-path.txt");
  const evidence = resolve(
    root,
    (await readFile(evidencePointer, "utf8")).trim(),
    "brand",
  );
  await mkdir(evidence, { recursive: true });
  await writeFile(
    resolve(evidence, "asset-validation.json"),
    `${JSON.stringify({ status: "PASS", svgPolicy: "fail-closed saxes allowlist; no external/executable resources", generatedAssets: records.length, svgCount: records.filter((r) => r.format === "svg").length, pngCount: records.filter((r) => r.format === "png").length, sources, assets: records, recommended: recommended.name, ownerApproved: false }, null, 2)}\n`,
  );
  await writeFile(
    resolve(evidence, "comparison.png"),
    await readFile(resolve(output, "comparison.png")),
  );
  await writeFile(
    resolve(evidence, "concept-evaluation.json"),
    `${JSON.stringify(manifest.evaluation, null, 2)}\n`,
  );
  console.log(
    JSON.stringify(
      {
        assets: records.length,
        output,
        recommended: recommended.name,
        evidence,
        manifestSha256: sha256(
          await readFile(resolve(output, "asset-manifest.json")),
        ),
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
