import { modeSchema } from "../core/model";
export function currentMode() {
  const requested = modeSchema.parse(
    process.env.OTHERBRIDGE_MODE ?? "mainnet-readonly",
  );
  return process.env.NODE_ENV === "production" ? "mainnet-readonly" : requested;
}
export function localAllowed(host: string) {
  return (
    currentMode() === "local-test" &&
    process.env.NODE_ENV !== "production" &&
    ["127.0.0.1:3100", "localhost:3100"].includes(host)
  );
}
