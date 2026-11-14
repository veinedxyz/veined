import { writeFileSync, mkdirSync } from "node:fs";
import { z } from "zod";
import { productionConfigSchema } from "../src/release/config";
import { releaseReceiptSchema } from "../src/release/receipt";
mkdirSync("release", { recursive: true });
for (const [name, schema] of [
  ["production-config", productionConfigSchema],
  ["release-receipt", releaseReceiptSchema],
] as const)
  writeFileSync(
    `release/${name}.schema.json`,
    JSON.stringify(z.toJSONSchema(schema), null, 2) + "\n",
  );
