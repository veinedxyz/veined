// Seeded deterministic PRNG (mulberry32) for reproducible property/fuzz loops. SYNTHETIC_TEST_ONLY.
export function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (max: number) => Math.floor(next() * max);
  const hex = (bytes: number) =>
    `0x${Array.from({ length: bytes * 2 }, () => "0123456789abcdef"[int(16)]).join("")}`;
  const pick = <T>(items: readonly T[]) => items[int(items.length)];
  const shuffle = <T>(items: T[]) => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  // Flip one hex nibble somewhere after the 0x prefix (always a different, still-valid hex string).
  const flipNibble = (value: string) => {
    const i = 2 + int(value.length - 2);
    const c = value[i].toLowerCase();
    const alt = "0123456789abcdef".replace(c, "");
    return value.slice(0, i) + alt[int(alt.length)] + value.slice(i + 1);
  };
  return { next, int, hex, pick, shuffle, flipNibble };
}
export const SEEDS = [1, 7, 42, 1337, 20261004];
