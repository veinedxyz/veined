import { z } from "zod";

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const releaseIdentitySchema = z
  .object({
    rcId: z.string().regex(/^OTHERBRIDGE_RC_V1_16_[A-Za-z0-9-]+$/),
    sourceCheckpoint: sha256Schema,
    sourceManifest: sha256Schema,
    buildHash: sha256Schema,
    protectedBaseline: sha256Schema,
  })
  .strict();

/** Contract for a future owner decision. Parsing is never approval or authorization. */
export const releaseReceiptSchema = releaseIdentitySchema
  .extend({
    schemaVersion: z.literal(1),
    environment: z.literal("production"),
    domain: z.literal("veined.xyz"),
    externalAuditHashes: z.array(sha256Schema).min(1),
    legalApprovalReferences: z.array(z.string().min(8).max(300)).min(1),
    ownerApproval: z
      .object({
        reference: z.string().min(8).max(300),
        signerKeyId: z.string().min(8).max(100),
        signature: z.string().regex(/^[a-f0-9]{128}$/),
      })
      .strict(),
    surface: z.enum(["G7", "SWAP", "BRIDGE"]),
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    revocation: z
      .object({ id: z.string().min(8).max(100), revoked: z.literal(false) })
      .strict(),
    feeBps: z.literal(0),
    globalKill: z.literal(false),
  })
  .strict();

export type ReleaseIdentity = z.infer<typeof releaseIdentitySchema>;
export function inspectReleaseReceipt(
  receipt: unknown,
  expected: ReleaseIdentity,
  surface: "G7" | "SWAP" | "BRIDGE",
  now = Date.now(),
) {
  const parsed = releaseReceiptSchema.safeParse(receipt);
  const errors: string[] = [];
  if (!parsed.success) errors.push("RECEIPT_SCHEMA_INVALID");
  else {
    for (const key of Object.keys(expected) as (keyof ReleaseIdentity)[])
      if (parsed.data[key] !== expected[key])
        errors.push(`RECEIPT_MISMATCH_${key}`);
    if (parsed.data.surface !== surface)
      errors.push("RECEIPT_SURFACE_MISMATCH");
    const issued = Date.parse(parsed.data.issuedAt),
      expires = Date.parse(parsed.data.expiresAt);
    if (
      !Number.isFinite(now) ||
      issued > now ||
      expires <= now ||
      expires <= issued
    )
      errors.push("RECEIPT_TIME_INVALID");
  }
  // V1.16 does not provision an approval trust root or an execution implementation.
  // A fabricated JSON document must NEVER be treated as a verified owner signature.
  errors.push("OWNER_SIGNATURE_NOT_VERIFIED", "V116_EXECUTION_CLOSED");
  return { allowed: false as const, errors };
}
