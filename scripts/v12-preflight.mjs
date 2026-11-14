import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
const root = `evidence/otherbridge-v1-2/v12-${new Date().toISOString().replace(/[-:.]/g, "")}-${randomBytes(3).toString("hex")}`;
await mkdir(root, { recursive: true });
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const files = git("ls-files", "--cached", "--others", "--exclude-standard")
  .split("\n")
  .filter(Boolean);
const hashes = {};
for (const file of files)
  hashes[file] = createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
const accepted = JSON.parse(
  await readFile(
    "evidence/otherbridge-v1-1/public-brand-20261003T071538Z-4bd6d4/source-inventory.json",
    "utf8",
  ),
);
await writeFile(
  `${root}/preflight.json`,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      cwd: process.cwd(),
      head: git("rev-parse", "HEAD"),
      branch: git("branch", "--show-current"),
      status: git("status", "--short"),
      remotes: git("remote", "-v"),
      runtime: process.version,
      package: JSON.parse(await readFile("package.json", "utf8")),
      hashes,
      acceptedInventory: accepted,
    },
    null,
    2,
  ),
  { flag: "wx" },
);
await writeFile(".otherbridge/v12-evidence-path.txt", root, { flag: "wx" });
console.log(root);
