import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const sharp = createRequire(require.resolve("next/package.json"))("sharp");
const root = process.cwd();
const evidence = path.join(
  root,
  "evidence/otherbridge-v1-19/v119-2026-10-25T09-38-26-191Z/assets",
);
const output = path.join(root, "public/assets/veined/visuals");
const originals = path.join(evidence, "originals");
const prompts = JSON.parse(
  await readFile(path.join(evidence, "prompts.json"), "utf8"),
);
await mkdir(originals, { recursive: true });
await mkdir(output, { recursive: true });
const slash = (value) => value.split(path.sep).join("/");
const relative = (value) => slash(path.relative(root, value));
const describe = async (filename) => {
  const bytes = await readFile(filename);
  const metadata = await sharp(bytes).metadata();
  return {
    path: relative(filename),
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};

const inventory = {
  schemaVersion: 1,
  collection: "VEINED V1.19 cinematic visual originals",
  generatedOn: prompts.generatedOn,
  generationMethod: prompts.method,
  origin: "AI-generated original artwork",
  rightsNote:
    "Generated using the built-in image tool. No third-party stock license or factual route evidence is claimed.",
  optimization:
    "Sharp resize with Lanczos3, tiny center crop to exact 16:9, WebP effort 6, highest quality from 84 down to 64 satisfying byte budget. 1920 derivatives mildly upscale the 1672-pixel originals; no additional generated detail is claimed.",
  renderingGuidance:
    "Decorative imagery: empty alt text when adjacent to descriptive page headings. Reserve aspect ratio. Eager-load only the landing hero. Use 640/1280/1920 responsive sources; lazy-load later sections.",
  approvedReuse: [
    {
      source: "hero-earth",
      uses: ["Landing hero", "App home overview banner", "Final CTA"],
      treatment:
        "Responsive CSS object-fit crops of one documented original; not independent generated originals.",
    },
  ],
  assets: [],
};

for (const asset of prompts.assets) {
  const original = path.join(originals, `${asset.name}.png`);
  try {
    await readFile(original);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await copyFile(asset.sourcePath, original);
  }
  const record = {
    name: asset.name,
    original: await describe(original),
    provenance: {
      origin: asset.origin,
      tool: asset.tool,
      model: asset.model,
      prompt: asset.prompt,
      promptFile: relative(path.join(evidence, "prompts.json")),
      referenceImages: [],
      review:
        "Visually inspected: subject and palette match request; no typography, logos, shields, UI or neon effects. Concept artwork does not substantiate financial availability or real-world routes.",
    },
    derivatives: [],
  };
  for (const width of [640, 1280, 1920]) {
    const height = Math.round((width * 9) / 16);
    const budget = width === 640 ? 100_000 : width === 1280 ? 180_000 : 300_000;
    let quality = 84;
    let bytes;
    while (true) {
      bytes = await sharp(original)
        .resize(width, height, {
          fit: "cover",
          position: "centre",
          kernel: "lanczos3",
        })
        .webp({ quality, effort: 6 })
        .toBuffer();
      if (bytes.length < budget || quality === 64) break;
      quality -= 2;
    }
    if (bytes.length >= budget)
      throw new Error(`${asset.name} ${width} exceeds ${budget} byte budget`);
    const filename = path.join(output, `${asset.name}-${width}.webp`);
    await writeFile(filename, bytes);
    record.derivatives.push({
      ...(await describe(filename)),
      quality,
      budgetBytes: budget,
      budgetPassed: true,
      source: relative(original),
    });
  }
  inventory.assets.push(record);
}

await writeFile(
  path.join(evidence, "inventory.json"),
  `${JSON.stringify(inventory, null, 2)}\n`,
);
await writeFile(
  path.join(output, "manifest.json"),
  `${JSON.stringify(
    {
      version: "1.19",
      origin: inventory.origin,
      provenance: relative(path.join(evidence, "inventory.json")),
      assets: inventory.assets.map((asset) => ({
        name: asset.name,
        sources: asset.derivatives.map(
          ({ path: file, width, height, bytes, sha256 }) => ({
            src: `/${file.replace(/^public\//, "")}`,
            width,
            height,
            bytes,
            sha256,
          }),
        ),
      })),
    },
    null,
    2,
  )}\n`,
);
console.log(
  JSON.stringify(
    {
      originals: inventory.assets.length,
      derivatives: inventory.assets.reduce(
        (count, asset) => count + asset.derivatives.length,
        0,
      ),
      bytes: inventory.assets
        .flatMap((asset) => asset.derivatives)
        .reduce((sum, asset) => sum + asset.bytes, 0),
      assets: inventory.assets.map((asset) => ({
        name: asset.name,
        bytesByWidth: asset.derivatives.map(({ width, bytes }) => ({
          width,
          bytes,
        })),
      })),
    },
    null,
    2,
  ),
);
