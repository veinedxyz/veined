// Reproducible derivative of the accepted V1.19 artwork, not a new generation.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url);
const sharp = createRequire(require.resolve("next/package.json"))("sharp");
const source = "public/assets/veined/visuals/portfolio-nodes-640.webp";
const destination = "public/assets/veined/visuals/portfolio-ambient-640.webp";
const input = readFileSync(source);
const output = await sharp(input).webp({ quality: 54, effort: 6 }).toBuffer();
writeFileSync(destination, output);
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
console.log(
  JSON.stringify({
    source,
    sourceSha256: sha256(input),
    destination,
    sha256: sha256(output),
    bytes: output.length,
    width: 640,
    height: 360,
    method:
      "Re-encode accepted 640px V1.19 derivative at WebP quality 54, effort 6. Painted under existing 0.22 dark / 0.08 light opacity; original retained.",
  }),
);
