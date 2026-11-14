import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("V1.15.1 frozen root dependency remediation", () => {
  const preload = pathToFileURL(
    resolve("scripts/runtime-dependency-pins.mjs"),
  ).href;
  it("uses upstream patched packages through actual PostCSS and query-string consumer contexts", () => {
    const code = `
      const assert = require('node:assert/strict');
      const { createRequire } = require('node:module');
      const { readdirSync } = require('node:fs');
      const { resolve } = require('node:path');
      const fromNext = createRequire(require.resolve('next/package.json'));
      const fromPostcss = createRequire(fromNext.resolve('postcss'));
      const sourceMap = fromPostcss('source-map-js');
      assert.match(fromPostcss.resolve('source-map-js'), /source-map-js@1\\.2\\.2/);
      const map = new sourceMap.SourceMapGenerator({ file: 'compiled.css' });
      map.addMapping({ generated: { line: 1, column: 0 }, original: { line: 1, column: 0 }, source: 'input.css' });
      const consumer = new sourceMap.SourceMapConsumer(map.toJSON());
      assert.equal(consumer.originalPositionFor({ line: 1, column: 0 }).source, 'input.css');
      for (const line of [-1, Infinity, Number.MAX_SAFE_INTEGER]) {
        assert.throws(() => new sourceMap.SourceMapConsumer({ version: 3, sections: [{ offset: { line, column: 0 }, map: map.toJSON() }] }), /offset/);
      }
      const queryStringPackages = readdirSync('node_modules/.pnpm').filter(x => x.startsWith('query-string@'));
      assert.ok(queryStringPackages.length > 0);
      for (const installed of queryStringPackages) {
        const fromQuery = createRequire(resolve('node_modules/.pnpm', installed, 'node_modules/query-string/index.js'));
        const decode = fromQuery('decode-uri-component');
        assert.equal(typeof decode, 'function');
        assert.match(fromQuery.resolve('decode-uri-component'), /security[\\\\/]decode-uri-component\\.cjs$/);
        assert.equal(decode('hello%20world'), 'hello world');
        assert.equal(decode('%C3%A5'), 'å');
        const hostile = '%FF'.repeat(8192);
        assert.equal(decode(hostile), hostile);
        const query = fromQuery('./index.js');
        assert.equal(query.parse('valid=hello%20world&hostile=' + hostile).valid, 'hello world');
      }
      console.log(JSON.stringify({ postcss: 'source-map-js@1.2.2', queryStringConsumers: queryStringPackages.length, decode: 'decode-uri-component@0.5.1' }));
    `;
    const output = execFileSync(
      process.execPath,
      ["--import", preload, "-e", code],
      { timeout: 15_000, encoding: "utf8" },
    );
    expect(JSON.parse(output.trim())).toMatchObject({
      postcss: "source-map-js@1.2.2",
      decode: "decode-uri-component@0.5.1",
    });
  });
  it("preloads the same pins for child Node processes via NODE_OPTIONS", () => {
    const output = execFileSync(
      process.execPath,
      [
        "-e",
        "const { createRequire } = require('node:module'); const r=createRequire(require.resolve('next/package.json')); const p=createRequire(r.resolve('postcss')); console.log(p.resolve('source-map-js'));",
      ],
      {
        timeout: 15_000,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_OPTIONS:
            `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`.trim(),
        },
      },
    );
    expect(output).toMatch(/source-map-js@1\.2\.2/);
    const launcher = readFileSync("scripts/next-pinned.mjs", "utf8");
    expect(launcher).toContain("process.env.NODE_OPTIONS =");
    expect(readFileSync("scripts/dev-test.mjs", "utf8")).toContain(
      "scripts/next-pinned.mjs",
    );
  });
});
