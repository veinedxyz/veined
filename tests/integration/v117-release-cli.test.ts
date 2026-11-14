import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
const invoke = (command: string, args: string[] = []) =>
  spawnSync(
    process.execPath,
    ["scripts/release-command.mjs", command, ...args],
    {
      encoding: "utf8",
      timeout: 30000,
      env: {
        ...process.env,
        UNISWAP_API_KEY: "",
        JUPITER_API_KEY: "",
        TITAN_AUTH_TOKEN: "",
        TITAN_WS_ENDPOINT: "",
        PCSX_INTEGRATOR_KEY: "",
        SWAP_DISABLED_PROVIDERS: "",
        PCSX_QUOTE_ENABLED: "false",
      },
    },
  );
describe("V1.17 operator commands", () => {
  it("offline credential check needs no credentials or network", () => {
    const r = invoke("release-credentials", ["--offline"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).execution).toBe("CLOSED");
    expect(r.stderr).toBe("");
  });
  it("incomplete external gates have explicit exit2 and closed output", () => {
    const r = invoke("release-external-gates");
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({
      status: "EXTERNAL_GATES_INCOMPLETE",
      execution: "CLOSED",
      authorization: false,
    });
  });
  it("malformed input produces redacted failure without a raw error", () => {
    const r = invoke("release-external-gates", ["--credentials=package.json"]);
    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain("at ");
    expect(JSON.parse(r.stdout).authorization).toBe(false);
  });
});
