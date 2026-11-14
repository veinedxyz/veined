export function exactUsd(value: string | null) {
  if (value === null) return "—";
  const neg = value.startsWith("-"),
    [w, f = ""] = (neg ? value.slice(1) : value).split(".");
  if (w === "0" && /^00/.test(f.padEnd(2, "0")) && /[1-9]/.test(f))
    return (neg ? "−" : "") + "<$0.01";
  return (
    (neg ? "−" : "") +
    "$" +
    w.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    "." +
    f.padEnd(2, "0").slice(0, 2)
  );
}
// Trim only fractional precision; never shorten a native risk metric's integer magnitude.
export const nativeRatio = (value: string) =>
  value.replace(/(\.\d{3})\d+$/, "$1");
