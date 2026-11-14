import { portfolioSchema, type PortfolioResult } from "../portfolio/model";
import {
  parseWalletLine,
  type ProgressLine,
  type WalletReceipt,
} from "../portfolio/stream";
// V1.14.2 progressive wallet round: an NDJSON response delivers schema-validated progress lines (plan, native fast
// path, settled networks, first page, DeFi start) before the final `result` line, which is the complete reconciled
// round. A plain JSON response is the complete round at once (accepted V1.14.1 behaviour and test doubles).
export async function readWalletRound(
  r: Response,
  onLine: (line: ProgressLine) => void,
): Promise<{ result: PortfolioResult; receipt?: WalletReceipt }> {
  if (
    !/application\/x-ndjson/.test(r.headers.get("content-type") ?? "") ||
    !r.body
  )
    return { result: portfolioSchema.parse(await r.json()) };
  const reader = r.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    if (buffer.length > 8_000_000) throw Error("LINE_TOO_LARGE");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const text = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!text) continue;
      const line = parseWalletLine(JSON.parse(text));
      if (line.type === "result")
        return { result: line.result, receipt: line.receipt };
      if (line.type === "error") throw Error(line.error);
      onLine(line);
    }
    if (done) throw Error("INCOMPLETE_ROUND");
  }
}
