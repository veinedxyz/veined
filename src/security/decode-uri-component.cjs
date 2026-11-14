// Preserve the legacy CommonJS callable API while using upstream's patched decoder.
/* eslint-disable @typescript-eslint/no-require-imports -- Preserve the callable CommonJS consumer API with the upstream ESM default export. */
module.exports =
  require("../../swap-providers/node_modules/decode-uri-component/index.js").default;
