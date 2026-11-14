// Types for the V1.6 G5 forensic helper (plain ESM, used by scripts and unit tests).
export declare const REPO: string;
export declare const EVIDENCE: string | null;
export declare function sha256(data: string | Uint8Array): string;
export declare function decodeCbor(bytes: Uint8Array): unknown;
export declare function base58(bytes: Uint8Array): string;
export declare function parseCborFooter(hex: string): {
  cborLength: number;
  cborHex: string;
  executableLength: number;
  ipfs?: string;
  solc?: string;
  keys: string[];
};
