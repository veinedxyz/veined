// Explicit candidate verification for isolated tests; no accepted-pointer mutation or scanner mock.
import { readFileSync } from "node:fs";
import {
  fixturePreflight as source,
  type FixtureScenario,
} from "../../scripts/g7-pilot/fixture";
import type { CandidateBaseline } from "../../scripts/g7-safety-scan";
export function candidateSelection(): CandidateBaseline | undefined {
  const path = process.env.OTHERBRIDGE_G7_CANDIDATE_SELECTION;
  return path
    ? { ...JSON.parse(readFileSync(path, "utf8")), scope: "fixture-validation" }
    : undefined;
}
export function fixturePreflight(
  scenario: FixtureScenario,
  clock: () => number = Date.now,
) {
  return source(scenario, clock, { candidateBaseline: candidateSelection() });
}
export function fixtureCandidateArgs(args: string[]) {
  const selection = candidateSelection();
  return args.includes("--fixture") && selection
    ? [
        "--candidate-baseline",
        selection.path,
        "--candidate-sha256",
        selection.sha256,
      ]
    : [];
}
