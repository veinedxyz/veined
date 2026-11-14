// Disposable V1.20.1 reproduction database. Never selects an existing service.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function cleanupReproductionDatabase(directory, since) {
  const path = join(directory, "owned-postgres.json");
  if (!existsSync(path)) return { pass: true, created: false };
  if (existsSync(join(directory, "postgres-cleanup.json")))
    return JSON.parse(
      readFileSync(join(directory, "postgres-cleanup.json"), "utf8"),
    );
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  if (
    !/^[a-f0-9]{64}$/.test(receipt.id) ||
    Date.parse(receipt.created) < Date.parse(since) - 2000
  )
    throw Error("CURRENT_RUN_DATABASE_REQUIRED");
  const docker = (args) => {
    const result = spawnSync("docker", args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 60000,
    });
    if (result.status !== 0)
      throw Error(`OWNED_DATABASE_CLEANUP_FAILED:${args[0]}`);
    return result.stdout;
  };
  const actual = JSON.parse(docker(["inspect", receipt.id]))[0];
  if (
    actual.Id !== receipt.id ||
    actual.Created !== receipt.created ||
    actual.Name !== `/${receipt.name}` ||
    actual.Config.Labels["veined.v1201.run"] !== receipt.token ||
    (receipt.startedAt && actual.State.StartedAt !== receipt.startedAt) ||
    JSON.stringify(actual.Mounts.map((m) => m.Name)) !==
      JSON.stringify(receipt.volumes)
  )
    throw Error("OWNED_DATABASE_IDENTITY_CHANGED");
  if (
    actual.Mounts.some(
      (m) => m.Type !== "volume" || !/^[a-f0-9]{64}$/.test(m.Name),
    )
  )
    throw Error("OWNED_ANONYMOUS_VOLUME_REQUIRED");
  if (actual.State.Running) docker(["stop", "--time", "10", receipt.id]);
  docker(["rm", "-v", receipt.id]);
  const result = {
    at: new Date().toISOString(),
    id: receipt.id,
    created: receipt.created,
    removedOwnedContainer: true,
    removedOwnedVolumes: receipt.volumes,
    existingServicesTouched: 0,
    pass: true,
  };
  writeFileSync(
    join(directory, "postgres-cleanup.json"),
    JSON.stringify(result, null, 2),
  );
  return result;
}

export function createReproductionDatabase(directory) {
  const token = randomBytes(12).toString("hex");
  const name = `veined-v1201-${token}`;
  const passwords = Object.fromEntries(
    ["owner", "api", "indexer", "monitor", "backup"].map((role) => [
      role,
      randomBytes(24).toString("hex"),
    ]),
  );
  const docker = (args, extraEnv = {}) => {
    const result = spawnSync("docker", args, {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, ...extraEnv },
      timeout: 60000,
    });
    if (result.status !== 0)
      throw Error(
        `OWNED_DATABASE_COMMAND_FAILED:${args[0]}:${result.stderr.slice(0, 500)}`,
      );
    return result.stdout;
  };
  // Use the already installed local PostgreSQL image; never pull or alter one.
  const image = docker([
    "image",
    "inspect",
    "postgres:17-alpine",
    "--format",
    "{{.Id}}",
  ]).trim();
  const id = docker(
    [
      "create",
      "--name",
      name,
      "--label",
      `veined.v1201.run=${token}`,
      "--memory",
      "768m",
      "--memory-swap",
      "768m",
      "--cpus",
      "1",
      "--publish",
      "127.0.0.1::5432",
      "--env",
      "POSTGRES_PASSWORD",
      "--env",
      "POSTGRES_USER=otherbridge_owner",
      "--env",
      "POSTGRES_DB=otherbridge_data",
      "--env",
      "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256",
      image,
      "postgres",
      "-c",
      "max_connections=60",
      "-c",
      "statement_timeout=30000",
    ],
    { POSTGRES_PASSWORD: passwords.owner },
  ).trim();
  if (!/^[a-f0-9]{64}$/.test(id)) throw Error("OWNED_CONTAINER_ID_REQUIRED");
  const inspect = () => JSON.parse(docker(["inspect", id]))[0];
  const initial = inspect();
  const receipt = {
    id,
    name,
    created: initial.Created,
    token,
    image,
    volumes: initial.Mounts.map((m) => m.Name),
    startedAt: null,
    pid: null,
    port: null,
  };
  const save = () =>
    writeFileSync(
      join(directory, "owned-postgres.json"),
      JSON.stringify(receipt, null, 2),
    );
  save();
  const verify = () => {
    const actual = inspect();
    if (
      actual.Id !== id ||
      actual.Created !== receipt.created ||
      actual.Name !== `/${name}` ||
      actual.Config.Labels["veined.v1201.run"] !== token ||
      JSON.stringify(actual.Mounts.map((m) => m.Name)) !==
        JSON.stringify(receipt.volumes)
    )
      throw Error("OWNED_DATABASE_IDENTITY_CHANGED");
    return actual;
  };
  async function start() {
    docker(["start", id]);
    const running = verify();
    receipt.startedAt = running.State.StartedAt;
    receipt.pid = running.State.Pid;
    const binding = running.NetworkSettings.Ports["5432/tcp"];
    if (binding?.length !== 1 || binding[0].HostIp !== "127.0.0.1")
      throw Error("LOOPBACK_DATABASE_REQUIRED");
    receipt.port = Number(binding[0].HostPort);
    save();
    let ready = false;
    const readiness = {
      protocol: "tcp",
      host: "127.0.0.1",
      port: 5432,
      observations: [],
      pass: false,
    };
    for (let i = 0; i < 30; i++) {
      const check = spawnSync(
        "docker",
        [
          "exec",
          id,
          "pg_isready",
          // The official image starts a socket-only temporary server during
          // initdb. Only TCP readiness identifies its final server.
          "-h",
          "127.0.0.1",
          "-p",
          "5432",
          "-U",
          "otherbridge_owner",
          "-d",
          "otherbridge_data",
        ],
        { windowsHide: true, stdio: "ignore", timeout: 5000 },
      );
      readiness.observations.push({
        at: new Date().toISOString(),
        code: check.status,
      });
      readiness.pass = check.status === 0;
      writeFileSync(
        join(directory, "postgres-readiness.json"),
        JSON.stringify(readiness, null, 2),
      );
      if (check.status === 0) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!ready) throw Error("OWNED_DATABASE_NOT_READY");
    const url = (role) =>
      `postgresql://otherbridge_${role}:${passwords[role]}@127.0.0.1:${receipt.port}/otherbridge_data`;
    return {
      OTHERBRIDGE_DATA_MIGRATOR_URL: url("owner"),
      OTHERBRIDGE_DATA_DATABASE_URL: url("api"),
      OTHERBRIDGE_DATA_INDEXER_URL: url("indexer"),
      OTHERBRIDGE_DATA_MONITOR_URL: url("monitor"),
      OTHERBRIDGE_DATA_BACKUP_URL: url("backup"),
      OTHERBRIDGE_DATA_PSEUDONYM_KEY: randomBytes(32).toString("hex"),
      ...Object.fromEntries(
        ["api", "indexer", "monitor", "backup"].map((role) => [
          `OTHERBRIDGE_PG_${role.toUpperCase()}_PASSWORD`,
          passwords[role],
        ]),
      ),
    };
  }
  function close() {
    const actual = verify();
    if (receipt.startedAt && actual.State.StartedAt !== receipt.startedAt)
      throw Error("OWNED_DATABASE_RESTARTED_EXTERNALLY");
    if (actual.State.Running) docker(["stop", "--time", "10", id]);
    verify();
    // -v removes only anonymous volumes created with this exact new container.
    if (
      actual.Mounts.some(
        (m) => m.Type !== "volume" || !/^[a-f0-9]{64}$/.test(m.Name),
      )
    )
      throw Error("OWNED_ANONYMOUS_VOLUME_REQUIRED");
    docker(["rm", "-v", id]);
    writeFileSync(
      join(directory, "postgres-cleanup.json"),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          id,
          created: receipt.created,
          removedOwnedContainer: true,
          removedOwnedVolumes: receipt.volumes,
          existingServicesTouched: 0,
          pass: true,
        },
        null,
        2,
      ),
    );
  }
  return { start, close };
}
