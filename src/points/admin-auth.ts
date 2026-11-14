import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
// Admin authentication. No identities are built in: principals and roles come only from the owner-approved
// VEINED_ADMIN_PRINCIPALS configuration (JSON). Unset or invalid configuration closes the admin surface.
//   [{ "id": "ops-a", "roles": ["viewer", "operator"], "tokenSha256": "<64 hex>" }, …]
// Tokens are 256-bit random bearer secrets of the form vpa.<id>.<43 base64url chars>, generated offline with
// scripts/points-admin-token.mjs; only their SHA-256 is configured. A high-entropy secret needs no slow KDF.
// Bearer headers are never attached by browsers on their own, so the admin API carries no CSRF surface.

export const ROLES = ["viewer", "operator", "approver"] as const;
export type Role = (typeof ROLES)[number];
export interface Principal {
  id: string;
  roles: Role[];
  tokenSha256: string;
}
const principalSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,31}$/),
    roles: z.array(z.enum(ROLES)).min(1).max(3),
    tokenSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export const TOKEN = /^vpa\.([a-z0-9][a-z0-9-]{2,31})\.([A-Za-z0-9_-]{43})$/;

export function parsePrincipals(raw: string | undefined): {
  principals: Principal[];
  errors: string[];
} {
  if (!raw?.trim()) return { principals: [], errors: ["ADMIN_NOT_CONFIGURED"] };
  try {
    const list = z.array(principalSchema).min(1).max(20).parse(JSON.parse(raw));
    if (new Set(list.map((p) => p.id)).size !== list.length)
      return { principals: [], errors: ["ADMIN_DUPLICATE_ID"] };
    if (new Set(list.map((p) => p.tokenSha256)).size !== list.length)
      return { principals: [], errors: ["ADMIN_DUPLICATE_TOKEN"] };
    return {
      principals: list.map((p) => ({ ...p, roles: [...new Set(p.roles)] })),
      errors: [],
    };
  } catch {
    return { principals: [], errors: ["ADMIN_CONFIG_INVALID"] };
  }
}

const sha = (text: string) =>
  createHash("sha256").update(text, "utf8").digest();
const DUMMY = sha("veined-admin-dummy");

/** Constant-time over the secret; unknown ids cost the same comparison. */
export function authenticate(
  header: string | null,
  principals: readonly Principal[],
): Principal | null {
  const match = /^Bearer (\S{1,120})$/.exec(header ?? "");
  const token = match?.[1] ?? "";
  const parts = TOKEN.exec(token);
  const principal = parts
    ? principals.find((p) => p.id === parts[1])
    : undefined;
  const expected = principal
    ? Buffer.from(principal.tokenSha256, "hex")
    : DUMMY;
  const ok = timingSafeEqual(sha(token), expected) && !!principal && !!parts;
  return ok ? principal! : null;
}

export type AdminAction =
  | "dashboard"
  | "explain"
  | "calculate"
  | "reject"
  | "finalize"
  | "publish"
  | "retain-undistributed"
  | "flag"
  | "task-create"
  | "task-approve"
  | "task-cancel"
  | "completion-review"
  | "correction-propose"
  | "correction-decide"
  | "sim-ingest"
  | "sim-finality"
  | "sim-reverse"
  | "sim-clock";
// Least privilege: viewers read; operators prepare; approvers (owner-assigned) approve, finalize and publish.
// Four-eyes rules (calculator ≠ finalizer, task author ≠ approver, correction proposer ≠ approver) are enforced
// by the engine on principal ids, independent of roles.
export const PERMISSIONS: Readonly<Record<AdminAction, Role>> = Object.freeze({
  dashboard: "viewer",
  explain: "viewer",
  calculate: "operator",
  reject: "approver",
  finalize: "approver",
  publish: "approver",
  "retain-undistributed": "approver",
  flag: "operator",
  "task-create": "operator",
  "task-approve": "approver",
  "task-cancel": "operator",
  "completion-review": "approver",
  "correction-propose": "operator",
  "correction-decide": "approver",
  "sim-ingest": "operator",
  "sim-finality": "operator",
  "sim-reverse": "operator",
  "sim-clock": "operator",
});
export const permitted = (principal: Principal, action: AdminAction) =>
  principal.roles.includes(PERMISSIONS[action]);
