import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
// V1.5 optional backup envelope: AES-256-GCM with an operator-supplied 32-byte key (never stored with
// the backup). Format: "OBBK1" | 12-byte IV | 16-byte tag | ciphertext. Tampering fails decryption.
const MAGIC = Buffer.from("OBBK1");
export function encryptBackup(plain: Buffer, key: Buffer) {
  if (key.length !== 32) throw Error("ENCRYPTION_KEY_INVALID");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}
export function decryptBackup(blob: Buffer, key: Buffer) {
  if (key.length !== 32) throw Error("ENCRYPTION_KEY_INVALID");
  if (blob.length < 33 || !blob.subarray(0, 5).equals(MAGIC))
    throw Error("ENCRYPTED_FORMAT_INVALID");
  const d = createDecipheriv("aes-256-gcm", key, blob.subarray(5, 17));
  d.setAuthTag(blob.subarray(17, 33));
  return Buffer.concat([d.update(blob.subarray(33)), d.final()]);
}
