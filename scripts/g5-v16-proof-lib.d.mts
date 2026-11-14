// Types for the V1.6 G5 proof primitives (plain ESM).
export declare const MPT_VERSION: string;
export declare function encodeReceipt(receipt: Record<string, unknown>): string;
export declare function headerHash(block: Record<string, string>): string;
export declare function istanbulFilteredExtra(extraHex: string): string;
export declare function verifyStoredProof(p: {
  expectedRoot: string;
  key: string;
  proofNodes: string[];
  encodedReceipt: string;
}): Promise<boolean>;
export declare function recoverFinalizeSigners(
  input: string,
  chainId: number,
  proxy: string,
  index: bigint,
): Promise<{
  signers: string[];
  digest: string;
  domainSeparator: string;
  structHash: string;
  batchSize: number;
}>;
