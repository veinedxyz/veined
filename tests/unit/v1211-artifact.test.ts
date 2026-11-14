import { it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  sealArtifact,
  verifyArtifact,
} from "../../scripts/lib/v1211-artifact.mjs";

const require = createRequire(import.meta.url);
const FileSystemCache =
  require("next/dist/server/lib/incremental-cache/file-system-cache").default;
const { nodeFs } = require("next/dist/server/lib/node-fs-methods");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const checkpoint = "a".repeat(64);
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "veined-v1211-artifact-"));
  const put = (p: string, s: string) => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), s);
  };
  put(".next/BUILD_ID", "synthetic-build");
  put(".next/server/entry.js", "export default 1;");
  put(".next/static/app.js", "const app = 1;");
  for (const route of [
    "favicon.ico",
    "icon.svg",
    "manifest.webmanifest",
    "robots.txt",
    "sitemap.xml",
  ]) {
    const sourceRoute = `/${route}/route`;
    put(`.next/server/app/${route}.body`, "synthetic-" + route);
    put(
      `.next/server/app/${route}.meta`,
      JSON.stringify({
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        routeCache: {
          key: `/route-cache/APP_ROUTE/${sha(sourceRoute)}/$/${route}`,
          owner: { kind: "APP_ROUTE", sourceRoute },
          isFallback: false,
        },
      }),
    );
  }
  const manifest = sealArtifact(root, checkpoint),
    bytes = JSON.stringify(manifest),
    digest = sha(bytes);
  const verify = () => verifyArtifact(root, bytes, digest, checkpoint);
  const promote = async () => {
    const cache = new FileSystemCache({
      fs: nodeFs,
      flushToDisk: true,
      serverDistDir: path.join(root, ".next/server"),
      revalidatedTags: [],
      maxMemoryCacheSize: 0,
    });
    for (const rule of Object.values(manifest.runtime) as {
      kind: string;
      metadata?: { routeCache: { key: string } };
    }[])
      if (rule.kind === "metadata")
        expect(
          await cache.get(rule.metadata!.routeCache.key, {
            kind: "APP_ROUTE",
            isFallback: false,
          }),
        ).not.toBeNull();
  };
  const clean = () => {
    if (
      !root.startsWith(path.join(os.tmpdir(), "veined-v1211-artifact-")) ||
      fs.realpathSync(root) !== root
    )
      throw Error("OWNED_TEMP_REQUIRED");
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { root, put, manifest, bytes, digest, verify, promote, clean };
}
it("accepts a sealed build before cache creation", () => {
  const f = fixture();
  try {
    expect(f.verify().runtimeFiles).toBe(0);
  } finally {
    f.clean();
  }
});
it("accepts real Next seed promotion and benign regeneration", async () => {
  const f = fixture();
  try {
    await f.promote();
    expect(f.verify().runtimeFiles).toBe(10);
    for (const p of Object.keys(f.manifest.runtime))
      fs.unlinkSync(path.join(f.root, p));
    expect(f.verify().runtimeFiles).toBe(0);
    await f.promote();
    expect(f.verify().runtimeFiles).toBe(10);
  } finally {
    f.clean();
  }
});
it.each([
  ".next/server/route-cache/APP_ROUTE/unauthorized/route.js",
  ".next/server/other-route.js",
  ".next/cache/new-cache-file",
])("rejects unreviewed extra file %s", (p) => {
  const f = fixture();
  try {
    f.put(p, "x");
    expect(f.verify).toThrow();
  } finally {
    f.clean();
  }
});
it.each([".next/static/app.js", ".next/server/entry.js", ".next/BUILD_ID"])(
  "rejects modified immutable %s",
  (p) => {
    const f = fixture();
    try {
      f.put(p, "tampered");
      expect(f.verify).toThrow();
    } finally {
      f.clean();
    }
  },
);
it("rejects missing artifact", () => {
  const f = fixture();
  try {
    fs.unlinkSync(path.join(f.root, ".next/server/entry.js"));
    expect(f.verify).toThrow();
  } finally {
    f.clean();
  }
});
it("rejects manifest mismatch and source mismatch", () => {
  const f = fixture();
  try {
    expect(() =>
      verifyArtifact(f.root, f.bytes + " ", f.digest, checkpoint),
    ).toThrow("MANIFEST_DIGEST_MISMATCH");
    expect(() =>
      verifyArtifact(f.root, f.bytes, f.digest, "b".repeat(64)),
    ).toThrow("MANIFEST_CONTRACT_MISMATCH");
  } finally {
    f.clean();
  }
});
it("rejects a junction escaping the artifact", () => {
  const f = fixture();
  try {
    fs.symlinkSync(os.tmpdir(), path.join(f.root, ".next/escape"), "junction");
    expect(f.verify).toThrow("ARTIFACT_LINK_ESCAPE");
  } finally {
    f.clean();
  }
});
it("rejects altered cache body, response headers and freshness", async () => {
  const f = fixture();
  try {
    await f.promote();
    const body = Object.keys(f.manifest.runtime).find((p) =>
      p.endsWith(".body"),
    )!;
    const meta = body.replace(/\.body$/, ".meta");
    f.put(body, "hostile");
    expect(f.verify).toThrow("CACHE_BODY_CHANGED");
    fs.unlinkSync(path.join(f.root, body));
    await f.promote();
    const original = fs.readFileSync(path.join(f.root, meta), "utf8"),
      m = JSON.parse(original);
    m.headers["set-cookie"] = "unsafe=1";
    f.put(meta, JSON.stringify(m));
    expect(f.verify).toThrow("CACHE_METADATA_CHANGED");
    const changed = JSON.parse(original);
    changed.routeCacheLastModified += 1;
    f.put(meta, JSON.stringify(changed));
    expect(f.verify).toThrow("CACHE_TIMESTAMP_CHANGED");
  } finally {
    f.clean();
  }
});
