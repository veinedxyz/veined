// V1.5 plaintext-secret scan for backups. Table data in a custom-format dump is compressed, so the scan
// runs over the decompressed SQL rendering (`pg_restore -f -`) as a stream; a bounded carry keeps a
// match that straddles two chunks detectable without buffering the whole rendering.
const PATTERNS = [
  /ob_(live|test)_[a-z0-9]{12}_[A-Za-z0-9_-]{30,}/g,
  /postgres(ql)?:\/\/[^\s'"]{1,256}:[^\s'"@]{1,256}@/g,
  /-----BEGIN (RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g,
];
const CARRY = 1024;
export function createSecretScanner() {
  let carry = "";
  let offset = 0; // absolute stream position of carry[0]
  let hits = 0;
  // A secret is counted once, at its absolute start: re-seeing it in the carry, or seeing it grow
  // across chunks, never counts it again.
  const lastStart = PATTERNS.map(() => -1);
  return {
    push(chunk: Buffer | string) {
      const text =
        carry + (typeof chunk === "string" ? chunk : chunk.toString("latin1"));
      PATTERNS.forEach((p, i) => {
        for (const m of text.matchAll(p)) {
          const start = offset + m.index;
          if (start > lastStart[i]!) {
            hits++;
            lastStart[i] = start;
          }
        }
      });
      const keep = Math.min(CARRY, text.length);
      offset += text.length - keep;
      carry = text.slice(text.length - keep);
    },
    get hits() {
      return hits;
    },
  };
}
export function countSecrets(bytes: Buffer | string) {
  const s = createSecretScanner();
  s.push(bytes);
  return s.hits;
}
