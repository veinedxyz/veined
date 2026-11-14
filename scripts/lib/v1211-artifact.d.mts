export type RuntimeRule =
  | { kind: "body"; seed: string; sha256: string }
  | {
      kind: "metadata";
      seed: string;
      metadata: { routeCache: { key: string }; [key: string]: unknown };
      lastModified: number;
    };
export interface ArtifactManifest {
  schemaVersion: number;
  execution: "CLOSED";
  sourceCheckpoint: string;
  buildId: string;
  immutable: Record<string, { kind: string; sha256: string; bytes?: number }>;
  immutableDirectories: string[];
  runtime: Record<string, RuntimeRule>;
  policy: string;
}
export function sealArtifact(
  directory: string,
  sourceCheckpoint: string,
): ArtifactManifest;
export function verifyArtifact(
  directory: string,
  manifestBytes: string | Buffer,
  expectedSha256: string,
  expectedSourceCheckpoint: string,
): {
  pass: true;
  immutableFiles: number;
  runtimeFiles: number;
  sourceCheckpoint: string;
  execution: "CLOSED";
};
