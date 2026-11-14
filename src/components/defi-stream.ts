import {
  deploymentCoverageSchema,
  positionSchema,
  scanSchema,
  type DefiScan,
} from "../defi/model";
// V1.14.1 progressive round: an NDJSON response delivers each finished deployment (validated here with the same
// schemas as the final round) before the round ends; a plain JSON response is the complete round at once.
export async function readRound(
  r: Response,
  wallet: string,
  onPartial: (partial: DefiScan) => void,
): Promise<DefiScan> {
  if (
    !/application\/x-ndjson/.test(r.headers.get("content-type") ?? "") ||
    !r.body
  )
    return scanSchema.parse(await r.json());
  const partial: DefiScan = {
    version: 2,
    wallet,
    scanId: "progressive",
    observedAt: Date.now(),
    positions: [],
    coverage: [],
    replacedWalletAssets: [],
    replacementOwners: {},
    continuation: [],
    nonEvm: "NOT_CHECKED",
    elapsedMs: 0,
    peakConcurrency: 0,
  };
  const reader = r.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    if (buffer.length > 8_000_000) throw Error("LINE_TOO_LARGE");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as { type?: unknown };
      if (msg.type === "scan")
        return scanSchema.parse((msg as { scan: unknown }).scan);
      if (msg.type !== "progress") throw Error("FAILED");
      const m = msg as {
        coverage: unknown;
        positions: unknown;
        replaced: unknown;
      };
      const coverage = deploymentCoverageSchema.parse(m.coverage);
      const positions = positionSchema.array().max(5000).parse(m.positions);
      const replaced = scanSchema.shape.replacedWalletAssets.parse(m.replaced);
      if (
        positions.some(
          (p) =>
            p.wallet !== wallet || p.deploymentId !== coverage.deploymentId,
        )
      )
        throw Error("WALLET_SCOPE_MISMATCH");
      partial.coverage = [
        ...partial.coverage.filter(
          (c) => c.deploymentId !== coverage.deploymentId,
        ),
        coverage,
      ];
      partial.positions = [
        ...partial.positions.filter(
          (p) => p.deploymentId !== coverage.deploymentId,
        ),
        ...positions,
      ];
      partial.replacementOwners = {
        ...partial.replacementOwners,
        [coverage.deploymentId]: replaced,
      };
      partial.replacedWalletAssets = [
        ...new Set(Object.values(partial.replacementOwners).flat()),
      ];
      onPartial(scanSchema.parse(partial));
    }
    if (done) throw Error("INCOMPLETE_ROUND");
  }
}
