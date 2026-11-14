// Canonical-hash checkpoints. Unfinalized windows may be rewound; finalized history never is.
export interface WindowAnchor {
  fromBlock: bigint;
  toBlock: bigint;
  toBlockHash: string;
  finalized: boolean;
}
export type RewindPlan =
  | { kind: "NONE" }
  | {
      kind: "REWIND";
      keepThrough: bigint;
      anchorHash: string | null;
      dropWindows: number;
    }
  | { kind: "FINALIZED_CONFLICT"; block: bigint };
// windows: newest first. canonical(block) returns the current canonical hash or null when unknown.
export async function planRewind(
  windows: WindowAnchor[],
  canonical: (block: bigint) => Promise<string | null>,
  baseBlock: bigint,
  maxChecks = 64,
): Promise<RewindPlan> {
  let checks = 0,
    dropped = 0;
  for (const w of windows) {
    if (checks++ >= maxChecks) break;
    const hash = await canonical(w.toBlock);
    if (hash === null) throw Error("CANONICAL_UNKNOWN");
    if (hash.toLowerCase() === w.toBlockHash.toLowerCase())
      return dropped === 0
        ? { kind: "NONE" }
        : {
            kind: "REWIND",
            keepThrough: w.toBlock,
            anchorHash: w.toBlockHash,
            dropWindows: dropped,
          };
    if (w.finalized) return { kind: "FINALIZED_CONFLICT", block: w.toBlock };
    dropped++;
  }
  if (dropped < windows.length) throw Error("REWIND_DEPTH_EXCEEDED");
  // Every stored window was replaced: return to the start anchor and re-read its canonical hash.
  return {
    kind: "REWIND",
    keepThrough: baseBlock,
    anchorHash: null,
    dropWindows: dropped,
  };
}
