import { test } from "vitest";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import {
  decodeProgramData,
  codeHashes,
  classifyChange,
  sha256,
  decodeAnchorIdl,
} from "../../scripts/v117-upstream-review.mjs";

test("loader metadata decode distinguishes deployment slot, authority and immutable header", () => {
  const bytes = Buffer.alloc(50);
  bytes.writeUInt32LE(3);
  bytes.writeBigUInt64LE(1234n, 4);
  bytes[12] = 1;
  bytes.fill(1, 13, 45);
  const result = decodeProgramData(bytes);
  assert.equal(result.upgradeSlot, "1234");
  assert.ok(result.upgradeAuthority);
  assert.equal(Buffer.from(result.metadataBase64, "base64").length, 45);
  bytes[12] = 0;
  assert.equal(decodeProgramData(bytes).upgradeAuthority, null);
  bytes[12] = 2;
  assert.throws(() => decodeProgramData(bytes));
  assert.throws(() => decodeProgramData(Buffer.alloc(44)));
  bytes[12] = 0;
  bytes.writeUInt32LE(2);
  assert.throws(() => decodeProgramData(bytes));
});
test("full executable hash excludes metadata but retains code allocation padding", () => {
  const a = Buffer.concat([Buffer.alloc(45), Buffer.from([1, 2, 0, 0])]);
  const b = Buffer.from(a);
  b[4] = 9;
  const x = codeHashes(a),
    y = codeHashes(b);
  assert.equal(x.binarySha256, sha256(Buffer.from([1, 2, 0, 0])));
  assert.equal(x.zeroTrimmedBinarySha256, sha256(Buffer.from([1, 2])));
  assert.equal(x.binarySha256, y.binarySha256);
  assert.notEqual(x.programDataSha256, y.programDataSha256);
});
test("identical source shape or header is insufficient to approve a deployed upgrade", () => {
  const base = {
    metadataMatches: false,
    binaryMatches: false,
    currentBinaryAvailable: true,
    verifiedSourceBinding: false,
    instructionCompatible: true,
  };
  assert.equal(classifyChange(base), "UNVERIFIED_UPSTREAM_CHANGE");
  assert.equal(
    classifyChange({ ...base, metadataMatches: true }),
    "UNVERIFIED_UPSTREAM_CHANGE",
  );
  assert.equal(
    classifyChange({ ...base, binaryMatches: true }),
    "METADATA_ONLY",
  );
  assert.equal(
    classifyChange({
      ...base,
      binaryMatches: true,
      currentBinaryAvailable: false,
    }),
    "UNVERIFIED_UPSTREAM_CHANGE",
  );
  assert.equal(
    classifyChange({ ...base, verifiedSourceBinding: true }),
    "REVIEWED_COMPATIBLE_UPGRADE",
  );
  assert.equal(
    classifyChange({
      ...base,
      verifiedSourceBinding: true,
      instructionCompatible: false,
    }),
    "INCOMPATIBLE",
  );
});
test("Anchor legacy IDL uses the internal account namespace and bounded compressed length", () => {
  const body = deflateSync(Buffer.from('{"instructions":[]}'));
  const bytes = Buffer.alloc(44 + body.length);
  Buffer.from("184662bf3a907b9e", "hex").copy(bytes);
  bytes.writeUInt32LE(body.length, 40);
  body.copy(bytes, 44);
  assert.deepEqual(decodeAnchorIdl(bytes).idl, { instructions: [] });
  const invalid = Buffer.from(bytes);
  invalid[0] ^= 1;
  assert.throws(() => decodeAnchorIdl(invalid), /DISCRIMINATOR/);
  bytes.writeUInt32LE(2000001, 40);
  assert.throws(() => decodeAnchorIdl(bytes), /LENGTH/);
});
