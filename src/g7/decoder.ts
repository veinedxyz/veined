// Independent bridgeToken calldata codec for the G7 preparation (second path, deliberately NOT viem):
// hand-written word-level ABI encoding/decoding with strict canonical checks and a selector derived with
// @noble/hashes keccak-256. The viem encoder in the preparation tool must agree byte-for-byte with this one.
import { keccak_256 } from "@noble/hashes/sha3.js";

export const BRIDGE_TOKEN_SIGNATURE =
  "bridgeToken(uint256,address,address,uint256,uint256,uint256,bytes)";

export interface BridgeTokenArgs {
  toChainID: bigint;
  fromToken: string;
  to: string;
  value: bigint;
  networkFee: bigint;
  exFee: bigint;
  extraData: string;
}
export interface DecodedBridgeToken extends BridgeTokenArgs {
  selector: string;
}

export class CalldataError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const HEX = /^0x(?:[0-9a-f]{2})*$/;
const MAX_UINT = (1n << 256n) - 1n;

export function keccakHex(bytesHex: string) {
  if (!HEX.test(bytesHex.toLowerCase()))
    throw new CalldataError("NON_HEX_INPUT");
  const clean = bytesHex.slice(2);
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return "0x" + toHex(keccak_256(bytes));
}
function toHex(bytes: Uint8Array) {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
export function selectorOf(signature: string) {
  return (
    "0x" + toHex(keccak_256(new TextEncoder().encode(signature))).slice(0, 8)
  );
}
export const BRIDGE_TOKEN_SELECTOR = selectorOf(BRIDGE_TOKEN_SIGNATURE);

const word = (n: bigint) => {
  if (n < 0n || n > MAX_UINT) throw new CalldataError("UINT_OUT_OF_RANGE");
  return n.toString(16).padStart(64, "0");
};
const addressWord = (a: string) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new CalldataError("BAD_ADDRESS");
  return a.slice(2).toLowerCase().padStart(64, "0");
};

export function encodeBridgeTokenIndependent(args: BridgeTokenArgs) {
  const extra = args.extraData.toLowerCase();
  if (!HEX.test(extra)) throw new CalldataError("BAD_EXTRA_DATA");
  const extraBytes = (extra.length - 2) / 2;
  const padded = extra.slice(2).padEnd(Math.ceil(extraBytes / 32) * 64, "0");
  return (
    BRIDGE_TOKEN_SELECTOR +
    word(args.toChainID) +
    addressWord(args.fromToken) +
    addressWord(args.to) +
    word(args.value) +
    word(args.networkFee) +
    word(args.exFee) +
    word(7n * 32n) +
    word(BigInt(extraBytes)) +
    padded
  );
}

// Strict canonical decoding: exact selector, zero-padded address words, the single dynamic argument at the
// canonical offset, zero padding and no trailing bytes. Anything else is rejected, not "best-effort" parsed.
export function decodeBridgeTokenIndependent(data: string): DecodedBridgeToken {
  if (typeof data !== "string" || !HEX.test(data))
    throw new CalldataError("NON_CANONICAL_HEX");
  const body = data.slice(10);
  const selector = data.slice(0, 10);
  if (selector !== BRIDGE_TOKEN_SELECTOR)
    throw new CalldataError("SELECTOR_MISMATCH");
  if (body.length < 64 * 8 || body.length % 64 !== 0)
    throw new CalldataError("BAD_LENGTH");
  const words = body.match(/.{64}/g) as string[];
  const uint = (i: number) => BigInt("0x" + words[i]);
  const address = (i: number) => {
    if (!/^0{24}/.test(words[i])) throw new CalldataError("DIRTY_ADDRESS");
    return "0x" + words[i].slice(24);
  };
  if (uint(6) !== 7n * 32n) throw new CalldataError("NON_CANONICAL_OFFSET");
  const length = uint(7);
  if (length > 32768n) throw new CalldataError("EXTRA_DATA_TOO_LONG");
  const len = Number(length);
  const tailWords = Math.ceil(len / 32);
  if (words.length !== 8 + tailWords) throw new CalldataError("TRAILING_DATA");
  const tail = words.slice(8).join("");
  if (/[^0]/.test(tail.slice(len * 2)))
    throw new CalldataError("DIRTY_PADDING");
  return {
    selector,
    toChainID: uint(0),
    fromToken: address(1),
    to: address(2),
    value: uint(3),
    networkFee: uint(4),
    exFee: uint(5),
    extraData: "0x" + tail.slice(0, len * 2),
  };
}
