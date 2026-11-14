import { writeFileSync } from "node:fs";
import { z } from "zod";
import {
  securityAuditResultSchema,
  pentestResultSchema,
  legalApprovalSchema,
  ownerEvidenceSchema,
  externalGateManifestSchema,
} from "../src/release/external-gates";
for (const [name, schema] of [
  ["security-audit-result", securityAuditResultSchema],
  ["pentest-result", pentestResultSchema],
  ["legal-approval", legalApprovalSchema],
  ["owner-evidence", ownerEvidenceSchema],
  ["external-gates", externalGateManifestSchema],
] as const)
  writeFileSync(
    `release/${name}.schema.json`,
    JSON.stringify(z.toJSONSchema(schema), null, 2) + "\n",
  );
console.log("FUTURE_RESULT_SCHEMAS_WRITTEN_NO_APPROVAL_CREATED");
