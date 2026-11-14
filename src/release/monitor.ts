import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { registry } from "../data/observability/metrics";
import { MODES } from "../swap/model";
import { swapConfig } from "../swap/server/config";

export function protectedBaselineMismatch(root = process.cwd()) {
  try {
    const pointer = readFileSync(
      resolve(root, ".otherbridge/g7-protected-baseline.txt"),
      "utf8",
    ).trim();
    if (
      !/^evidence\/otherbridge-v1-12-1\/[A-Za-z0-9._-]+\/preflight\/protected-hashes\.json$/.test(
        pointer,
      )
    )
      return 1;
    const baseline = readFileSync(resolve(root, pointer));
    if (
      createHash("sha256").update(baseline).digest("hex") !==
      "621555523eb3a3e150de49ef3fd3efc23b99de1c492453d9a4d9dc406adc1959"
    )
      return 1;
    const hashes = JSON.parse(baseline.toString()) as Record<string, string>;
    if (Object.keys(hashes).length !== 107) return 1;
    return Object.entries(hashes).every(
      ([path, expected]) =>
        !path.split(/[\\/]/).includes("..") &&
        createHash("sha256")
          .update(readFileSync(resolve(root, path)))
          .digest("hex") === expected,
    )
      ? 0
      : 1;
  } catch {
    return 1;
  }
}
export function releaseMetrics(root = process.cwd()) {
  const r = registry();
  r.set(
    "security_protected_baseline_mismatch",
    {},
    protectedBaselineMismatch(root),
  );
  try {
    const c = swapConfig();
    for (const mode of MODES)
      r.set("swap_provider_killed", { mode }, Number(c.killed.has(mode)));
    r.set("swap_build_killed", {}, Number(!c.build));
    r.set("swap_review_killed", {}, Number(!c.review));
    r.set(
      "security_execution_flag_anomaly",
      {},
      Number(
        [
          "OTHERBRIDGE_EXECUTION_ENABLED",
          "SWAP_EXECUTION_ENABLED",
          "BRIDGE_EXECUTION_ENABLED",
          "G7_EXECUTION_ENABLED",
        ].some((k) => process.env[k] && process.env[k] !== "false"),
      ),
    );
  } catch {
    r.set("security_execution_flag_anomaly", {}, 1);
  }
  try {
    const audit = JSON.parse(
      readFileSync(
        resolve(root, "release/dependency-audit-status.json"),
        "utf8",
      ),
    );
    const age = (Date.now() - Date.parse(audit.at)) / 1000;
    const bound = ["root", "provider"].every((name) => {
      const b = audit.bindings?.[name];
      const expectedLock =
        name === "root" ? "pnpm-lock.yaml" : "swap-providers/pnpm-lock.yaml";
      if (
        !b ||
        b.lock !== expectedLock ||
        b.file !== `release/dependency-audits/${name}-production.json`
      )
        return false;
      const raw = readFileSync(resolve(root, b.file));
      if (
        createHash("sha256").update(raw).digest("hex") !== b.sha256 ||
        createHash("sha256")
          .update(readFileSync(resolve(root, b.lock)))
          .digest("hex") !== b.lockSha256
      )
        return false;
      const counts = JSON.parse(raw.toString()).metadata?.vulnerabilities;
      return ["critical", "high", "moderate"].every(
        (key) => counts?.[key] === 0 && audit[name]?.[key] === counts[key],
      );
    });
    const valid =
      bound &&
      Number.isFinite(age) &&
      age >= 0 &&
      age < 7 * 86400 &&
      [audit.root, audit.provider].every(
        (a) => a && ["critical", "high", "moderate"].every((k) => a[k] === 0),
      );
    r.set("security_dependency_audit_regression", {}, Number(!valid));
    r.set(
      "dependency_audit_age_seconds",
      {},
      Number.isFinite(age) ? Math.max(0, age) : 7 * 86400,
    );
  } catch {
    r.set("security_dependency_audit_regression", {}, 1);
  }
}
