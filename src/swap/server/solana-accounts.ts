import { base58 } from "@scure/base";
import { SwapError } from "../model";
export const SPL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export type RawSolAccount = {
  owner: string;
  executable: boolean;
  data: [string, string];
  lamports: number;
};
function reject(): never {
  throw new SwapError("BUILD_REVIEW_REQUIRED");
}
function option(b: Buffer, at: number) {
  const v = b.readUInt32LE(at);
  if (v !== 0 && v !== 1) reject();
  return v === 1;
}
/** SPL/Token-2022 base layouts and bounded TLV. Economic extensions are not silently treated as ordinary tokens. */
function unpack(a: RawSolAccount, kind: "mint" | "account") {
  if (
    !a ||
    ![SPL, TOKEN_2022].includes(a.owner) ||
    a.executable ||
    !Array.isArray(a.data) ||
    a.data[1] !== "base64" ||
    typeof a.data[0] !== "string" ||
    a.data[0].length > 16384
  )
    reject();
  const b = Buffer.from(a.data[0], "base64"),
    size = kind === "mint" ? 82 : 165;
  if (b.toString("base64") !== a.data[0] || b.length < size || b.length === 355)
    reject();
  if (a.owner === SPL && b.length !== size) reject();
  const extensions: number[] = [];
  if (b.length > size) {
    if (
      a.owner !== TOKEN_2022 ||
      b.length < 166 ||
      b[165] !== (kind === "mint" ? 1 : 2) ||
      (kind === "mint" && b.subarray(82, 165).some((v) => v !== 0))
    )
      reject();
    let offset = 166;
    while (offset < b.length) {
      if (b.subarray(offset).every((v) => v === 0)) break;
      if (offset + 4 > b.length || extensions.length >= 16) reject();
      const type = b.readUInt16LE(offset),
        length = b.readUInt16LE(offset + 2);
      offset += 4;
      if (offset + length > b.length || extensions.includes(type)) reject();
      // ImmutableOwner affects authority only. Metadata is retained as untrusted data and never followed as a URL.
      if (
        kind === "account"
          ? !(type === 7 && length === 0)
          : !(
              (type === 18 && length === 64) ||
              (type === 19 && length >= 80 && length <= 8192)
            )
      )
        reject();
      extensions.push(type);
      offset += length;
    }
  }
  return { b, extensions, program: a.owner };
}
export function decodeSolMint(a: RawSolAccount) {
  const { b, extensions, program } = unpack(a, "mint");
  const mintAuthority = option(b, 0) ? base58.encode(b.subarray(4, 36)) : null;
  const freezeAuthority = option(b, 46)
    ? base58.encode(b.subarray(50, 82))
    : null;
  if (b[45] !== 1 || b[44] > 36) reject();
  return {
    program,
    decimals: b[44],
    supply: b.readBigUInt64LE(36),
    mintAuthority,
    freezeAuthority,
    extensions,
  };
}
export function decodeSolTokenAccount(a: RawSolAccount) {
  const { b, extensions, program } = unpack(a, "account");
  if (b[108] !== 1) reject();
  const delegate = option(b, 72) ? base58.encode(b.subarray(76, 108)) : null;
  const native = option(b, 109),
    closeAuthority = option(b, 129)
      ? base58.encode(b.subarray(133, 165))
      : null;
  return {
    program,
    mint: base58.encode(b.subarray(0, 32)),
    owner: base58.encode(b.subarray(32, 64)),
    amount: b.readBigUInt64LE(64),
    delegate,
    delegatedAmount: b.readBigUInt64LE(121),
    native,
    rentReserve: native ? b.readBigUInt64LE(113) : 0n,
    closeAuthority,
    extensions,
  };
}
