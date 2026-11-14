// Types for the V1.6 G5 bytecode forensics twin (plain ESM).
type Ref = { start: number; length: number };
export declare function splitCbor(hex: string): {
  executable: string;
  cbor: string;
};
export declare function substituteImmutables(
  compiledHex: string,
  immutableReferences: Record<string, Ref[]>,
  liveHex: string,
): {
  hex: string;
  substitutions: {
    astId: string;
    start: number;
    length: number;
    placeholder: string;
    live: string;
  }[];
};
export declare function firstMismatch(a: string, b: string): number | null;
export declare function compareRuntime(
  compiled: {
    object: string;
    immutableReferences?: Record<string, Ref[]>;
    linkReferences?: Record<string, unknown>;
  },
  liveHex: string,
): {
  result?: string;
  FULL_RUNTIME_EQUAL: boolean;
  executableEqual: boolean;
  cborEqual: boolean;
  firstMismatchOffset: number | null;
  compiledKeccak256: string;
  liveKeccak256: string;
  substitutions: {
    astId: string;
    start: number;
    length: number;
    placeholder: string;
    live: string;
  }[];
};
export declare function extractConstructorArgs(
  compiledCreationHex: string,
  onchainInputHex: string,
): {
  prefixEqual: boolean;
  args: string | null;
  firstMismatchOffset: number | null;
};
export declare function implementationAt(
  timeline: { block: number; implementation: string }[],
  block: number,
  initial?: string | null,
): string | null;
