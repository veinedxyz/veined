import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";

// Independent acceptance rule, including hidden DOM text and case variants.
export const brandDenylist =
  /(?<![\p{L}\p{N}])li[ .-]?fi(?![\p{L}\p{N}])|jumper(?:\.exchange)?|defillama|llama\.fi|goldrush|covalent|routing\s+infrastructure|rota\s+altyap[ıi]s[ıi]|powered\s+by|mevcut[^.!?\n]{0,60}altyap[ıi]/iu;

export async function checkPublicPage(page, base, name) {
  const textContent = await page.evaluate(
    () => document.body.textContent ?? "",
  );
  const match = textContent.match(brandDenylist);
  await mkdir(`${base}/public-text`, { recursive: true });
  await writeFile(`${base}/public-text/${name}.txt`, textContent, {
    flag: "wx",
  });
  const result = {
    name,
    url: page.url(),
    at: new Date().toISOString(),
    language: await page.evaluate(() => document.documentElement.lang),
    textContentLength: textContent.length,
    matches: match ? [match[0]] : [],
    result: match ? "FAIL" : "PASS",
  };
  await writeFile(
    `${base}/public-text/${name}.json`,
    JSON.stringify(result, null, 2),
    { flag: "wx" },
  );
  assert.equal(match, null, `Public brand leak in ${name}: ${match?.[0]}`);
  return result;
}

export async function checkPublicDocs(base) {
  async function documents(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const lists = await Promise.all(
      entries.map((entry) => {
        const path = `${dir}/${entry.name}`;
        return entry.isDirectory()
          ? entry.name === "INTERNAL"
            ? []
            : documents(path)
          : /\.md$/i.test(path)
            ? [path]
            : [];
      }),
    );
    return lists.flat();
  }
  const files = [
    "README.md",
    "OTHERBRIDGE_V1_HANDOFF.md",
    ...(await documents("docs")),
  ];
  const results = await Promise.all(
    files.map(async (path) => {
      const text = await readFile(path, "utf8");
      const match = text.match(brandDenylist);
      return {
        path,
        matches: match ? [match[0]] : [],
        result: match ? "FAIL" : "PASS",
      };
    }),
  );
  const report = {
    at: new Date().toISOString(),
    result: results.every((r) => r.result === "PASS") ? "PASS" : "FAIL",
    results,
    exclusions: [
      "docs/INTERNAL (technical/legal records and verbatim historical archive)",
      "package/lock/import/internal adapter and raw fixture/evidence identities",
      "Original user goal/review instructions and internal execution state",
    ],
  };
  if (base) {
    await mkdir(base, { recursive: true });
    await writeFile(
      `${base}/public-docs-denylist.json`,
      JSON.stringify(report, null, 2),
      { flag: "wx" },
    );
  }
  assert.equal(
    report.result,
    "PASS",
    JSON.stringify(results.filter((r) => r.result === "FAIL")),
  );
  return report;
}

if (
  process.argv[1]?.replaceAll("\\", "/").endsWith("/public-brand-check.mjs")
) {
  const base = process.env.OTHERBRIDGE_EVIDENCE_ROOT;
  if (!base) throw Error("Use a unique evidence directory");
  console.log(JSON.stringify(await checkPublicDocs(base), null, 2));
}
