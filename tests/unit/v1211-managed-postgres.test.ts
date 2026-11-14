import { it, expect } from "vitest";
import { readFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bootstrapSql,
  managedGrants,
  backupClientPlan,
  encryptDumpStream,
  successfulDumpStream,
} from "../../scripts/lib/managed-postgres.mjs";
import { decryptBackup } from "../../src/data/backup/crypto";
it("separates role bootstrap and eliminates cluster-wide backup grant", () => {
  const source = readFileSync("src/data/store/grants.sql", "utf8"),
    digest = createHash("sha256").update(source).digest("hex");
  const grants = managedGrants(source, digest);
  expect(grants).not.toMatch(/GRANT pg_read_all_data/);
  expect(grants).toContain(
    "GRANT SELECT ON ALL TABLES IN SCHEMA public TO otherbridge_backup",
  );
  expect(bootstrapSql()).toContain("NOCREATEROLE");
  expect(bootstrapSql()).toContain("pg_auth_members");
  const service = readFileSync("services/managed-data.ts", "utf8");
  const literal = /await sql`(-- Idempotent[\s\S]*?)`\.simple\(\)/.exec(
    service,
  );
  expect(literal?.[1].replaceAll("\\`", "`")).toBe(grants);
  expect(service).not.toMatch(/\.unsafe\(/);
  expect(() => managedGrants(source + "x", digest)).toThrow(
    "GRANTS_SOURCE_HASH_MISMATCH",
  );
});
it("uses native pg_dump with service credentials and verified TLS", () => {
  const p = backupClientPlan();
  expect(p.executable).toBe("pg_dump");
  expect(p.requiredEnvironment.PGSSLMODE).toBe("verify-full");
  expect(p.args.join(" ")).not.toContain("postgres://");
  expect(() => backupClientPlan("host=evil")).toThrow();
});
it("streams an existing authenticated envelope and rejects tampering, failed streams and overwrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "veined-v1211-backup-"));
  try {
    const key = randomBytes(32),
      plain = Buffer.from("synthetic-only".repeat(1000)),
      file = join(dir, "backup.enc");
    await encryptDumpStream(
      Readable.from([plain.subarray(0, 4000), plain.subarray(4000)]),
      file,
      key,
      process.cwd(),
    );
    const blob = await readFile(file);
    expect(decryptBackup(blob, key)).toEqual(plain);
    blob[blob.length - 1] ^= 1;
    expect(() => decryptBackup(blob, key)).toThrow();
    await expect(
      encryptDumpStream(Readable.from([plain]), file, key, process.cwd()),
    ).rejects.toThrow();
    async function* broken() {
      yield plain;
      throw Error("dump failed");
    }
    await expect(
      encryptDumpStream(broken(), join(dir, "failed.enc"), key, process.cwd()),
    ).rejects.toThrow("dump failed");
    expect(await readdir(dir)).toEqual(["backup.enc"]);
    const failed = spawn(
      process.execPath,
      ["-e", "process.stdout.write('synthetic');process.exitCode=7"],
      { windowsHide: true },
    );
    await expect(
      encryptDumpStream(
        successfulDumpStream(failed),
        join(dir, "native-failed.enc"),
        key,
        process.cwd(),
      ),
    ).rejects.toThrow("NATIVE_DUMP_FAILED");
    expect(await readdir(dir)).toEqual(["backup.enc"]);
    await expect(
      encryptDumpStream(
        Readable.from([plain]),
        join(process.cwd(), "forbidden.enc"),
        key,
        process.cwd(),
      ),
    ).rejects.toThrow("BACKUP_INSIDE_REPOSITORY");
    if (process.platform === "win32")
      await expect(
        encryptDumpStream(
          Readable.from([plain]),
          join(process.cwd().toUpperCase(), "forbidden-case.enc"),
          key,
          process.cwd(),
        ),
      ).rejects.toThrow("BACKUP_INSIDE_REPOSITORY");
  } finally {
    if (!dir.startsWith(join(tmpdir(), "veined-v1211-backup-")))
      throw Error("OWNED_TEMP_REQUIRED");
    await rm(dir, { recursive: true });
  }
});
