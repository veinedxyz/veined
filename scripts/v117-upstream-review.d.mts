export function sha256(bytes: string | Uint8Array): string;
export function decodeProgramData(bytes: Buffer): {
  upgradeSlot: string;
  upgradeAuthority: string | null;
  metadataBase64: string;
};
export function codeHashes(bytes: Buffer): {
  programDataSha256: string;
  binarySha256: string;
  binaryBytes: number;
  zeroTrimmedBinarySha256: string;
  zeroTrimmedBinaryBytes: number;
  hashDefinition: string;
};
export function decodeAnchorIdl(bytes: Buffer): {
  plain: Buffer;
  idl: unknown;
  authority: string;
};
export function classifyChange(input: {
  metadataMatches: boolean;
  binaryMatches: boolean;
  currentBinaryAvailable: boolean;
  verifiedSourceBinding: boolean;
  instructionCompatible: boolean | null;
}):
  | "METADATA_ONLY"
  | "REVIEWED_COMPATIBLE_UPGRADE"
  | "UNVERIFIED_UPSTREAM_CHANGE"
  | "INCOMPATIBLE";
export function reviewWhirlpool(
  output: string,
): Promise<Record<string, unknown>>;
export function reviewWhirlpoolSupplement(
  output: string,
): Promise<Record<string, unknown>>;
export function reviewRpc(output: string): Promise<Record<string, unknown>>;
export function reviewRpcHistory(
  output: string,
): Promise<Record<string, unknown>>;
export function finalizeEvidence(
  output: string,
): Promise<Record<string, unknown>>;
