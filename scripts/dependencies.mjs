import { readFile, readdir, writeFile } from "node:fs/promises";
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const direct = { ...pkg.dependencies, ...pkg.devDependencies };
const packages = [];
for (const dir of await readdir("node_modules/.pnpm", {
  withFileTypes: true,
})) {
  if (!dir.isDirectory() || dir.name === "node_modules") continue;
  const nested = `node_modules/.pnpm/${dir.name}/node_modules`;
  try {
    for (const item of await readdir(nested)) {
      const names = item.startsWith("@")
        ? (await readdir(`${nested}/${item}`)).map((n) => `${item}/${n}`)
        : [item];
      for (const name of names) {
        try {
          const p = JSON.parse(
            await readFile(`${nested}/${name}/package.json`, "utf8"),
          );
          if (
            packages.some((v) => v.name === p.name && v.version === p.version)
          )
            continue;
          packages.push({
            name: p.name,
            version: p.version,
            license:
              typeof p.license === "string"
                ? p.license
                : (p.license?.type ?? p.licenses?.[0]?.type ?? "UNKNOWN"),
            direct: name in direct,
            scripts: p.scripts?.postinstall ?? null,
          });
        } catch {}
      }
    }
  } catch {}
}
packages.sort((a, b) => a.name.localeCompare(b.name));
await writeFile(
  "evidence/otherbridge-v1/dependency-licenses.json",
  JSON.stringify(
    {
      at: new Date().toISOString(),
      packages,
      unknown: packages.filter((p) => p.license === "UNKNOWN"),
      buildPolicy: {
        "unrs-resolver":
          "postinstall reviewed, denied; prebuilt optional binary works",
      },
      sdkCandidate: {
        name: "@nexus-cross/connect-kit-react",
        version: "1.4.2",
        license: "MIT",
        installed: false,
        reason: "requires owned project IDs; expands financial surface",
      },
    },
    null,
    2,
  ),
);
console.log({
  packages: packages.length,
  unknown: packages.filter((p) => p.license === "UNKNOWN").map((p) => p.name),
});
