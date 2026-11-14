// Generates one VEINED points admin principal for owner-approved configuration. Prints the bearer token ONCE (hand
// it to that operator through a secure channel) and the VEINED_ADMIN_PRINCIPALS entry, which holds only its SHA-256.
// Nothing is written to disk and no identity is built into the application.
//   node scripts/points-admin-token.mjs <id> <role>[,<role>…]     roles: viewer, operator, approver
import { createHash, randomBytes } from "node:crypto";

const [id, rolesArg] = process.argv.slice(2);
const roles = [...new Set((rolesArg ?? "").split(",").filter(Boolean))];
if (
  !/^[a-z0-9][a-z0-9-]{2,31}$/.test(id ?? "") ||
  !roles.length ||
  roles.some((r) => !["viewer", "operator", "approver"].includes(r))
) {
  console.error(
    "usage: node scripts/points-admin-token.mjs <id> <viewer|operator|approver>[,...]",
  );
  process.exit(2);
}
const token = `vpa.${id}.${randomBytes(32).toString("base64url")}`;
const entry = {
  id,
  roles,
  tokenSha256: createHash("sha256").update(token).digest("hex"),
};
console.log(
  JSON.stringify(
    {
      token,
      principal: entry,
      note: "Store the token only with its holder. Add `principal` to the VEINED_ADMIN_PRINCIPALS JSON array. Use separate principals for calculation and approval (four-eyes).",
    },
    null,
    2,
  ),
);
