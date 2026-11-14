import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

export async function privyStyleInventory(directory: string) {
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".mjs"))
    .sort();
  const hashes = new Set<string>();
  let cursor = 0,
    dynamic = 0,
    bytes = 0;
  // Bound both concurrent I/O and retained module text; every installed ESM file
  // is read on every invocation. There is no cached or precomputed acceptance.
  await Promise.all(
    Array.from({ length: Math.min(4, files.length) }, async () => {
      while (cursor < files.length) {
        const file = files[cursor++];
        const source = await readFile(join(directory, file), "utf8");
        bytes += Buffer.byteLength(source);
        for (const match of source.matchAll(
          /\("style",\{children:("(?:[^"\\]|\\.)*"|`[^`$]*`)\}/g,
        )) {
          const css = match[1].startsWith("`")
            ? match[1].slice(1, -1)
            : JSON.parse(match[1]);
          hashes.add(
            `'sha256-${createHash("sha256").update(css).digest("base64")}'`,
          );
        }
        dynamic += (source.match(/\("style",\{children:(?!"|`)/g) ?? []).length;
      }
    }),
  );
  return { hashes: [...hashes].sort(), dynamic, files, bytes };
}
