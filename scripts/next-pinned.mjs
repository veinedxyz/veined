// All supported Next entrypoints preload the reviewed dependency pins. NODE_OPTIONS
// propagates the preload to Next's spawned workers, including its CSS build worker.
import { fileURLToPath } from "node:url";
const preload = new URL("./runtime-dependency-pins.mjs", import.meta.url).href;
const next = new URL("../node_modules/next/dist/bin/next", import.meta.url);
// Put the preload in NODE_OPTIONS once. Next merges execArgv with NODE_OPTIONS;
// repeating --import in both channels makes its worker formatter concatenate URLs.
// Run Next in this process so shutdown reaches the server without an extra parent.
process.env.NODE_OPTIONS =
  `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`.trim();
await import(preload);
process.argv[1] = fileURLToPath(next);
await import(next.href);
