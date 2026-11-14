import schema from "./jupiter-idl.generated.json" with { type: "json" };
import { SwapError } from "../model";
type Type =
  | string
  | {
      vec?: Type;
      option?: Type;
      array?: [Type, number];
      defined?: { name: string };
    };
type Field = { name: string; type: Type };
type Definition = {
  name: string;
  type: {
    kind: string;
    fields?: Field[];
    variants?: { name: string; fields?: Field[] }[];
  };
};
const definitions = new Map(
  (schema.types as Definition[]).map((t) => [t.name, t.type]),
);
function reject(): never {
  throw new SwapError("BUILD_REVIEW_REQUIRED");
}
/** Bounded Borsh decoder generated from the actual mainnet IDL, including current V2 field order/discriminators. */
export function decodeJupiterInstruction(data: Buffer) {
  const ix = schema.instructions.find((x) =>
    Buffer.from(x.discriminator).equals(data.subarray(0, 8)),
  );
  if (!ix || data.length > 1232) reject();
  let at = 8,
    nodes = 0;
  function bytes(n: number) {
    if (at + n > data.length) reject();
    const b = data.subarray(at, at + n);
    at += n;
    return b;
  }
  function read(type: Type, depth = 0): unknown {
    if (depth > 12 || ++nodes > 1024) reject();
    if (typeof type === "string") {
      if (type === "u8") return bytes(1)[0];
      if (type === "bool") {
        const v = bytes(1)[0];
        if (v > 1) reject();
        return v === 1;
      }
      if (type === "u16") return bytes(2).readUInt16LE();
      if (type === "u32") return bytes(4).readUInt32LE();
      if (type === "u64") return bytes(8).readBigUInt64LE();
      if (type === "u128") {
        const b = bytes(16);
        return b.readBigUInt64LE() + (b.readBigUInt64LE(8) << 64n);
      }
      reject();
    }
    if (type.vec) {
      const count = bytes(4).readUInt32LE();
      if (count > 32) reject();
      return Array.from({ length: count }, () => read(type.vec!, depth + 1));
    }
    if (type.option) {
      const tag = bytes(1)[0];
      if (tag > 1) reject();
      return tag === 0 ? null : read(type.option, depth + 1);
    }
    if (type.array) {
      if (type.array[1] > 64) reject();
      return Array.from({ length: type.array[1] }, () =>
        read(type.array![0], depth + 1),
      );
    }
    if (type.defined) {
      const d = definitions.get(type.defined.name);
      if (!d) reject();
      if (d.kind === "struct")
        return Object.fromEntries(
          d.fields!.map((f) => [f.name, read(f.type, depth + 1)]),
        );
      if (d.kind === "enum") {
        const v = d.variants![bytes(1)[0]];
        if (!v) reject();
        return {
          variant: v.name,
          ...Object.fromEntries(
            (v.fields ?? []).map((f) => [f.name, read(f.type, depth + 1)]),
          ),
        };
      }
    }
    reject();
  }
  const args = Object.fromEntries(
    (ix.args as Field[]).map((f) => [f.name, read(f.type)]),
  );
  if (at !== data.length) reject();
  return {
    name: ix.name,
    accounts: ix.accounts as {
      name: string;
      signer?: boolean;
      writable?: boolean;
      optional?: boolean;
      address?: string;
    }[],
    args,
    idl: schema.source,
  };
}
