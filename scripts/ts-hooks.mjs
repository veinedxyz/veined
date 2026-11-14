// Lets Node 24 (type transform) run the repository's extensionless TypeScript imports for services.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
registerHooks({
  resolve(specifier, context, next) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.(m?[jt]sx?|json|cjs|sql)$/.test(specifier) &&
      context.parentURL?.startsWith("file:")
    )
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        const url = new URL(specifier + ext, context.parentURL);
        if (existsSync(fileURLToPath(url))) return next(url.href, context);
      }
    return next(specifier, context);
  },
});
