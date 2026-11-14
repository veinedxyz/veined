// V1.6 G5 bytecode forensics (JS twin of scripts/g5-v16-compare.py; both are run and must agree).
// Pure functions: no network, no filesystem.
import { keccak256 } from "viem";
import { parseCborFooter } from "./g5-v16-lib.mjs";

const strip = (h) => {
  if (typeof h !== "string" || !/^(0x)?([0-9a-fA-F]{2})*$/.test(h))
    throw new Error("BAD_HEX");
  return h.replace(/^0x/, "").toLowerCase();
};

export function splitCbor(hex) {
  const h = strip(hex);
  const n = parseInt(h.slice(-4), 16);
  if (!Number.isFinite(n) || n * 2 + 4 > h.length)
    return { executable: h, cbor: "" };
  return {
    executable: h.slice(0, h.length - 4 - n * 2),
    cbor: h.slice(h.length - 4 - n * 2),
  };
}

// Replace ONLY the compiler-declared immutable ranges with the live bytes at the same offsets.
export function substituteImmutables(
  compiledHex,
  immutableReferences,
  liveHex,
) {
  const c = strip(compiledHex),
    l = strip(liveHex);
  let out = c;
  const subs = [];
  for (const [astId, refs] of Object.entries(immutableReferences ?? {})) {
    for (const { start, length } of refs) {
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(length) ||
        start < 0 ||
        length <= 0 ||
        (start + length) * 2 > c.length
      )
        throw new Error("BAD_IMMUTABLE_REF");
      const live = l.slice(start * 2, (start + length) * 2);
      if (live.length !== length * 2) throw new Error("LIVE_TOO_SHORT");
      subs.push({
        astId,
        start,
        length,
        placeholder: c.slice(start * 2, (start + length) * 2),
        live,
      });
      out = out.slice(0, start * 2) + live + out.slice((start + length) * 2);
    }
  }
  return { hex: out, substitutions: subs };
}

export function firstMismatch(a, b) {
  const x = strip(a),
    y = strip(b);
  const n = Math.min(x.length, y.length) / 2;
  for (let i = 0; i < n; i++)
    if (x.slice(i * 2, i * 2 + 2) !== y.slice(i * 2, i * 2 + 2)) return i;
  return x.length === y.length ? null : n;
}

export function compareRuntime(
  { object, immutableReferences, linkReferences },
  liveHex,
) {
  if (/__\$/.test(object) || Object.keys(linkReferences ?? {}).length)
    return { result: "UNLINKED_LIBRARIES" };
  const { hex, substitutions } = substituteImmutables(
    object,
    immutableReferences,
    liveHex,
  );
  const live = strip(liveHex);
  const c = splitCbor(hex),
    l = splitCbor(live);
  return {
    FULL_RUNTIME_EQUAL: hex === live,
    executableEqual: c.executable === l.executable,
    cborEqual: c.cbor === l.cbor,
    firstMismatchOffset: firstMismatch(hex, live),
    compiledKeccak256: keccak256(`0x${hex}`),
    liveKeccak256: keccak256(`0x${live}`),
    substitutions,
    liveMetadata: l.cbor ? parseCborFooter(`0x${live}`) : null,
  };
}

// Creation input = compiled creation code || ABI-encoded constructor args. Anything else is a mismatch.
export function extractConstructorArgs(compiledCreationHex, onchainInputHex) {
  const c = strip(compiledCreationHex),
    i = strip(onchainInputHex);
  if (!i.startsWith(c))
    return {
      prefixEqual: false,
      args: null,
      firstMismatchOffset: firstMismatch(c, i),
    };
  return {
    prefixEqual: true,
    args: `0x${i.slice(c.length)}`,
    firstMismatchOffset: null,
  };
}

// timeline: [{ block, implementation }] from Upgraded events (any order). Returns the implementation
// active at `block` (the event block itself already runs the new implementation for later txs).
export function implementationAt(timeline, block, initial = null) {
  const sorted = [...timeline].sort((a, b) => a.block - b.block);
  let impl = initial;
  for (const t of sorted)
    if (t.block <= block) impl = t.implementation.toLowerCase();
  return impl;
}
