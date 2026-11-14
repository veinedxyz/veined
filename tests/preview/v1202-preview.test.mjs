import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { checkpoint } from "../../scripts/v117-source.mjs";
import {
  previewEnvironment,
  previewPort,
  choosePreviewPort,
  verifySourcePair,
  verifyBuildPair,
  buildInventory,
} from "../../scripts/lib/v1202-preview.mjs";

test("preview environment drops credentials, inherited flags and Node injection", () => {
  const env = previewEnvironment(
    {
      PATH: "runtime-path",
      DATABASE_URL: "secret",
      NEXT_PUBLIC_PRIVY_APP_ID: "real-app",
      OTHERBRIDGE_EXECUTION_ENABLED: "true",
      OTHERBRIDGE_ENABLE_MAINNET_SUBMISSION: "true",
      NODE_OPTIONS: "--import=untrusted",
      PORT: "3100",
    },
    3134,
  );
  assert.equal(env.PATH, "runtime-path");
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.PORT, undefined);
  assert.equal(env.NEXT_PUBLIC_PRIVY_APP_ID, "");
  assert.equal(env.NODE_OPTIONS, "--max-old-space-size=1536");
  assert.equal(env.OTHERBRIDGE_APP_ORIGINS, "http://127.0.0.1:3134");
  assert.equal(env.OTHERBRIDGE_EXECUTION_ENABLED, "false");
  assert.equal(env.OTHERBRIDGE_ENABLE_MAINNET_SUBMISSION, "false");
  assert.equal(env.OTHERBRIDGE_PUBLIC_DEPLOYMENT, "false");
});

function buildFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "veined-preview-"));
  t.after(() => {
    assert.ok(
      resolve(directory).startsWith(
        resolve(tmpdir()) + sep + "veined-preview-",
      ),
    );
    rmSync(directory, { recursive: true, force: true });
  });
  mkdirSync(join(directory, ".next/node_modules"), { recursive: true });
  mkdirSync(join(directory, "node_modules/postgres"), { recursive: true });
  writeFileSync(join(directory, ".next/BUILD_ID"), "fixture");
  writeFileSync(join(directory, "node_modules/postgres/index.js"), "reviewed");
  return directory;
}

test("Turbopack's own package link is content-hashed and drift is rejected", (t) => {
  const directory = buildFixture(t);
  const link = join(directory, ".next/node_modules/postgres-fixture");
  symlinkSync(join(directory, "node_modules/postgres"), link, "junction");
  try {
    const hashes = buildInventory(directory);
    assert.ok(hashes[".next/node_modules/postgres-fixture/index.js"]);
    const build = { buildHashes: hashes, buildCheckpoint: checkpoint(hashes) };
    writeFileSync(join(directory, "node_modules/postgres/index.js"), "mutated");
    assert.throws(
      () => verifyBuildPair(build, buildInventory(directory)),
      /BUILD_ARTIFACT_CHANGED/,
    );
  } finally {
    unlinkSync(link);
  }
});

test("package links outside the artifact's own dependencies are rejected", (t) => {
  const directory = buildFixture(t);
  const outside = buildFixture(t);
  const link = join(directory, ".next/node_modules/postgres-fixture");
  symlinkSync(join(outside, "node_modules/postgres"), link, "junction");
  try {
    assert.throws(() => buildInventory(directory), /BUILD_SYMLINK_FORBIDDEN/);
  } finally {
    unlinkSync(link);
  }
});

test("links from arbitrary build directories are rejected", (t) => {
  const directory = buildFixture(t);
  const link = join(directory, ".next/server");
  symlinkSync(join(directory, "node_modules/postgres"), link, "junction");
  try {
    assert.throws(() => buildInventory(directory), /BUILD_SYMLINK_FORBIDDEN/);
  } finally {
    unlinkSync(link);
  }
});
test("port 3100 and malformed ports are refused", () => {
  for (const port of [3100, 0, 80, 65536, -1, 3130.5, "3130"])
    assert.throws(() => previewPort(port), /PREVIEW_PORT_FORBIDDEN/);
});
test("a busy foreign listener remains serving while a different port is selected", async () => {
  const foreign = createServer();
  foreign.listen({ host: "127.0.0.1", port: 0 });
  await once(foreign, "listening");
  const busy = foreign.address().port;
  try {
    const selected = await choosePreviewPort([
      busy,
      ...Array.from({ length: 20 }, (_, i) => 3130 + i),
    ]);
    assert.notEqual(selected, busy);
    assert.equal(foreign.listening, true);
    assert.equal(foreign.address().port, busy);
  } finally {
    await new Promise((done) => foreign.close(done));
  }
});
const source = { "src/app.ts": "accepted", "docs/decision.md": "approved" };
const manifest = { sourceHashes: source, sourceCheckpoint: checkpoint(source) };
test("only matching full current and frozen source is accepted", () =>
  assert.doesNotThrow(() => verifySourcePair(manifest, source, source)));
test("current source drift including approval docs is refused", () =>
  assert.throws(
    () =>
      verifySourcePair(
        manifest,
        { ...source, "docs/decision.md": "changed" },
        source,
      ),
    /CURRENT_AND_FROZEN_SOURCE_MUST_MATCH/,
  ));
test("frozen source drift is refused", () =>
  assert.throws(
    () =>
      verifySourcePair(manifest, source, {
        ...source,
        "src/app.ts": "changed",
      }),
    /CURRENT_AND_FROZEN_SOURCE_MUST_MATCH/,
  ));
test("edited source manifest without a matching checkpoint is refused", () =>
  assert.throws(
    () => verifySourcePair({ ...manifest, sourceHashes: {} }, source, source),
    /CURRENT_AND_FROZEN_SOURCE_MUST_MATCH/,
  ));
test("changed production artifact is refused even when source is unchanged", () => {
  const buildHashes = {
    ".next/BUILD_ID": "one",
    ".next/server/app.js": "reviewed",
  };
  const build = { buildHashes, buildCheckpoint: checkpoint(buildHashes) };
  assert.doesNotThrow(() => verifyBuildPair(build, buildHashes));
  assert.throws(
    () =>
      verifyBuildPair(build, {
        ...buildHashes,
        ".next/server/app.js": "changed",
      }),
    /BUILD_ARTIFACT_CHANGED_REBUILD_REQUIRED/,
  );
});
