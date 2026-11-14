import type { Sql } from "postgres";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
export const APPLICATION_ROLES: readonly string[];
export function bootstrapSql(): string;
export function managedGrants(
  acceptedSql: string,
  acceptedSha256: string,
): string;
export function assertMigrator(sql: Sql): Promise<void>;
export function backupClientPlan(serviceName?: string): {
  executable: string;
  args: string[];
  requiredSecretFileEnvironment: string[];
  requiredEnvironment: {
    PGSSLMODE: string;
    PGCONNECT_TIMEOUT: string;
    PGSERVICE: string;
  };
  sourceRole: string;
  clientMajor: number;
  restrictions: string;
};
export function successfulDumpStream(
  child: ChildProcessWithoutNullStreams,
): AsyncGenerator<Buffer>;
export function encryptDumpStream(
  source: AsyncIterable<Uint8Array>,
  outputFile: string,
  key: Buffer,
  repository: string,
): Promise<{
  plaintextBytes: number;
  format: string;
  encryption: string;
  plaintextPersisted: false;
}>;
