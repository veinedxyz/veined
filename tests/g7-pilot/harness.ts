// Starts one isolated fixture-mode G7 pilot harness process (own port, own state dir, no network).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_PRIVY_APP_ID } from "../e2e/privy-mock";
import { fixtureCandidateArgs } from "../fixtures/g7-candidate";

export const REPO = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
export const TS_NODE = [
  "--experimental-transform-types",
  "--disable-warning=ExperimentalWarning",
  "--import",
  "./scripts/ts-hooks.mjs",
];
export interface HarnessOptions {
  // Reuse a state directory (runtime record, lock) across launcher runs; it is then not removed on stop.
  stateDir?: string;
  port?: number;
  // Start the launcher through an intermediate wrapper process (like pnpm), to test the orphan guard.
  wrapped?: boolean;
}
export interface Harness {
  url: string;
  origin: string;
  stateDir: string;
  startup: Record<string, unknown>;
  output: string[];
  pid: number;
  stopped: Promise<number | null>;
  stop(): void;
}
export const newStateDir = () => mkdtempSync(join(tmpdir(), "g7-e2e-"));
function launch(
  args: string[],
  script: string,
  stateDir: string,
  port: number,
  wrapped = false,
): ChildProcess {
  const launcher = [
    ...TS_NODE,
    script,
    ...args,
    ...fixtureCandidateArgs(args),
    "--state-dir",
    stateDir,
    "--port",
    String(port),
  ];
  const env = { ...process.env, NEXT_PUBLIC_PRIVY_APP_ID: TEST_PRIVY_APP_ID };
  return wrapped
    ? spawn(
        process.execPath,
        [
          "-e",
          // detached: outside this wrapper's kill-on-close job object (Windows), like a shell-started launcher,
          // so the launcher's own orphan guard is what reacts when the wrapper dies.
          "const c=require('node:child_process').spawn(process.execPath,JSON.parse(process.argv[1]),{stdio:'inherit',detached:true,windowsHide:true});c.on('exit',(x)=>process.exit(x??1));",
          JSON.stringify(launcher),
        ],
        { cwd: REPO, stdio: ["ignore", "pipe", "pipe"], env },
      )
    : // V1.9: the in-product pilot connects through the Privy layer; tests use the test-only App ID whose
      // Privy/WalletConnect traffic is answered by tests/e2e/privy-mock.ts in the browser.
      spawn(process.execPath, launcher, {
        cwd: REPO,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
}
export async function startHarness(
  args: string[],
  script = "scripts/g7-pilot.ts",
  startupTimeoutMs = 60000,
  options: HarnessOptions = {},
): Promise<Harness> {
  const stateDir = options.stateDir ?? newStateDir();
  const proc = launch(
    args,
    script,
    stateDir,
    options.port ?? 0,
    options.wrapped,
  );
  const output: string[] = [];
  let url = "";
  const stopped = new Promise<number | null>((r) =>
    proc.once("exit", (code) => r(code)),
  );
  const startup = await new Promise<Record<string, unknown>>(
    (resolveStart, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`harness did not start:\n${output.join("\n")}`)),
        startupTimeoutMs,
      );
      let buffer = "";
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let i: number;
        while ((i = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, i).trim();
          buffer = buffer.slice(i + 1);
          output.push(line);
          if (line.startsWith("G7PILOT_URL "))
            url = line.slice("G7PILOT_URL ".length);
          const m = /^G7PILOT_(READY|STOPPED) (.*)$/.exec(line);
          if (m) {
            clearTimeout(timer);
            resolveStart(JSON.parse(m[2]));
          }
        }
      };
      proc.stdout!.on("data", onData);
      proc.stderr!.on("data", (c: Buffer) =>
        output.push(`[stderr] ${c.toString("utf8").trim()}`),
      );
      proc.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`harness exited ${code}:\n${output.join("\n")}`));
      });
    },
  );
  const runtime = startup.runtime as { pid?: number } | undefined;
  return {
    url,
    origin: new URL(url).origin,
    stateDir,
    startup,
    output,
    pid: runtime?.pid ?? proc.pid!,
    stopped,
    stop() {
      proc.kill();
      if (!options.stateDir)
        try {
          rmSync(stateDir, { recursive: true, force: true });
        } catch {
          // Windows may still hold the journal briefly; the temp dir is disposable
        }
    },
  };
}
// Runs a launcher (or the stop command) to completion: for refused starts and stop results.
export function runToExit(
  script: string,
  args: string[],
  timeoutMs = 90000,
): Promise<{ code: number | null; output: string[] }> {
  const proc = spawn(
    process.execPath,
    [...TS_NODE, script, ...args, ...fixtureCandidateArgs(args)],
    {
      cwd: REPO,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NEXT_PUBLIC_PRIVY_APP_ID: TEST_PRIVY_APP_ID },
    },
  );
  const output: string[] = [];
  const collect = (c: Buffer) =>
    output.push(...c.toString("utf8").split(/\r?\n/).filter(Boolean));
  proc.stdout!.on("data", collect);
  proc.stderr!.on("data", collect);
  return new Promise((resolveRun, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`timeout:\n${output.join("\n")}`));
    }, timeoutMs);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolveRun({ code, output });
    });
  });
}
