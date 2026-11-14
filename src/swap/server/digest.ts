import { createHash } from "node:crypto";
import { canonical } from "../model";
export const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
