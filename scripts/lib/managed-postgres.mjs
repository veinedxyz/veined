// Offline managed-PostgreSQL preparation primitives. No credential loading or connection side effects.
import { createHash, createCipheriv, randomBytes } from "node:crypto";
import { open, mkdir, link, unlink } from "node:fs/promises";
import { realpathSync, lstatSync } from "node:fs";
import { resolve, dirname, sep, isAbsolute } from "node:path";

export const APPLICATION_ROLES = Object.freeze([
  "otherbridge_api",
  "otherbridge_indexer",
  "otherbridge_monitor",
  "otherbridge_backup",
]);
export function bootstrapSql() {
  const roles = ["otherbridge_migrator", ...APPLICATION_ROLES];
  return (
    `-- Run as a separately authorized DBA in the selected VEINED database.\n-- Passwords are provisioned by the vault/DBA outside this SQL; no password is embedded.\n` +
    roles
      .map(
        (role) =>
          `DO $$ BEGIN\n IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN\n  CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;\n END IF;\n IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}' AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='${role}')) THEN\n  RAISE EXCEPTION 'UNSAFE_EXISTING_ROLE';\n END IF;\nEND $$;`,
      )
      .join("\n") +
    `\nREVOKE CREATE ON SCHEMA public FROM PUBLIC;\nGRANT USAGE,CREATE ON SCHEMA public TO otherbridge_migrator;\nGRANT USAGE ON SCHEMA public TO ${APPLICATION_ROLES.join(",")};\n`
  );
}
export function managedGrants(acceptedSql, acceptedSha256) {
  if (createHash("sha256").update(acceptedSql).digest("hex") !== acceptedSha256)
    throw Error("GRANTS_SOURCE_HASH_MISMATCH");
  const needle = "GRANT pg_read_all_data TO otherbridge_backup;";
  if (acceptedSql.split(needle).length !== 2)
    throw Error("GRANTS_SHAPE_CHANGED");
  // Database/schema-local privileges replace a cluster-wide predefined role.
  const backupSequenceGrant =
    "GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO otherbridge_backup;";
  if (acceptedSql.split(backupSequenceGrant).length !== 2)
    throw Error("BACKUP_SEQUENCE_GRANTS_SHAPE_CHANGED");
  const sql = acceptedSql
    .replace(
      needle,
      "GRANT SELECT ON ALL TABLES IN SCHEMA public TO otherbridge_backup;\n    GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO otherbridge_backup;",
    )
    .replace(
      backupSequenceGrant,
      "REVOKE USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA public FROM otherbridge_backup;\n    GRANT USAGE ON SEQUENCE ops_backup_events_id_seq TO otherbridge_backup;",
    );
  return (
    sql +
    "\nALTER DEFAULT PRIVILEGES FOR ROLE otherbridge_migrator IN SCHEMA public GRANT SELECT ON TABLES TO otherbridge_backup;\nALTER DEFAULT PRIVILEGES FOR ROLE otherbridge_migrator IN SCHEMA public GRANT SELECT ON SEQUENCES TO otherbridge_backup;\n"
  );
}
export async function assertMigrator(sql) {
  const [r] =
    await sql`SELECT current_user AS name, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname=current_user`;
  const memberships =
    await sql`SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)`;
  if (
    !r ||
    r.name !== "otherbridge_migrator" ||
    r.rolsuper ||
    r.rolcreatedb ||
    r.rolcreaterole ||
    r.rolreplication ||
    r.rolbypassrls ||
    memberships.length
  )
    throw Error("DEDICATED_UNPRIVILEGED_MIGRATOR_REQUIRED");
}
export function backupClientPlan(serviceName = "veined_backup") {
  if (!/^[a-z][a-z0-9_]{2,40}$/.test(serviceName))
    throw Error("SERVICE_NAME_INVALID");
  return {
    executable: "pg_dump",
    args: [
      "--format=custom",
      "--no-owner",
      "--no-acl",
      "--dbname=service=" + serviceName + " sslmode=verify-full",
    ],
    requiredSecretFileEnvironment: [
      "PGSERVICEFILE",
      "PGPASSFILE",
      "PGSSLROOTCERT",
    ],
    requiredEnvironment: {
      PGSSLMODE: "verify-full",
      PGCONNECT_TIMEOUT: "10",
      PGSERVICE: serviceName,
    },
    sourceRole: "otherbridge_backup",
    clientMajor: 17,
    restrictions:
      "External managed host requires approved exact hostname, trusted CA, private credential files and owner authorization. No URL/password arguments; application and migration identities are not backup identities.",
  };
}
// Wrap an owned native pg_dump child. A successful stdout EOF is insufficient:
// a nonzero process exit must abort publication of the encrypted envelope.
export async function* successfulDumpStream(child) {
  const exited = new Promise((done) => {
    child.once("error", () => done(false));
    child.once("close", (code) => done(code === 0));
  });
  child.stderr.resume(); // Driver diagnostics may contain secrets; never copy them to receipts.
  child.stdin.end();
  try {
    for await (const chunk of child.stdout) yield chunk;
    if (!(await exited)) throw Error("NATIVE_DUMP_FAILED");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }
}
// Compatible with existing protected OBBK1 AES-256-GCM envelope; plaintext never lands on disk.
// Use successfulDumpStream for a native client so its exit status gates atomic publication.
export async function encryptDumpStream(source, outputFile, key, repository) {
  if (!Buffer.isBuffer(key) || key.length !== 32)
    throw Error("ENCRYPTION_KEY_INVALID");
  if (!isAbsolute(outputFile)) throw Error("ABSOLUTE_BACKUP_PATH_REQUIRED");
  const repo = resolve(repository),
    file = resolve(outputFile),
    parent = dirname(file);
  const comparisonFile =
      process.platform === "win32" ? file.toLowerCase() : file,
    comparisonRepo = process.platform === "win32" ? repo.toLowerCase() : repo;
  if (
    comparisonFile === comparisonRepo ||
    comparisonFile.startsWith(comparisonRepo + sep)
  )
    throw Error("BACKUP_INSIDE_REPOSITORY");
  await mkdir(parent, { recursive: true });
  if (realpathSync(parent) !== parent || lstatSync(parent).isSymbolicLink())
    throw Error("BACKUP_DIRECTORY_LINK");
  const temporary = file + ".partial-" + randomBytes(12).toString("hex");
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  let handle,
    bytes = 0;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(
      Buffer.concat([Buffer.from("OBBK1"), iv, Buffer.alloc(16)]),
    );
    for await (const chunk of source) {
      bytes += chunk.length;
      await handle.writeFile(cipher.update(chunk));
    }
    await handle.writeFile(cipher.final());
    const tag = cipher.getAuthTag();
    for (let offset = 0; offset < tag.length;) {
      const result = await handle.write(
        tag,
        offset,
        tag.length - offset,
        17 + offset,
      );
      if (!result.bytesWritten) throw Error("BACKUP_TAG_WRITE_FAILED");
      offset += result.bytesWritten;
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, file); // Atomic publish, refuses to overwrite an existing backup.
    return {
      plaintextBytes: bytes,
      format: "OBBK1",
      encryption: "AES-256-GCM",
      plaintextPersisted: false,
    };
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => {});
  }
}
