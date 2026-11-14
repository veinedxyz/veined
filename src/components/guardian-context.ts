"use client";
// Page context for the Guardian assistant: each VEINED surface publishes the few facts it already shows (a quote's
// summary and Guardian's verdict on Swap and Bridge, Portfolio counts, Networks coverage) and withdraws them when it
// unmounts. Memory only, never persisted, never sent anywhere by itself; no addresses beyond what the page displays.
import { useSyncExternalStore } from "react";
import type { PageFacts } from "../guardian/chat/engine";

let facts: PageFacts = {};
const listeners = new Set<() => void>();
const EMPTY: PageFacts = {};

export function publishGuardianFacts<K extends keyof PageFacts>(
  key: K,
  value: PageFacts[K] | undefined,
) {
  if (facts[key] === value) return;
  facts = { ...facts, [key]: value };
  for (const l of listeners) l();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useGuardianFacts(): PageFacts {
  return useSyncExternalStore(
    subscribe,
    () => facts,
    () => EMPTY,
  );
}
/** The page key the assistant reasons about, from the app path. */
export function guardianPage(path: string) {
  const first = path.split("/")[1] ?? "";
  return first === "app"
    ? ("overview" as const)
    : ((
        [
          "swap",
          "bridge",
          "portfolio",
          "points",
          "activity",
          "networks",
          "help",
          "guardian",
        ] as const
      ).find((p) => p === first) ?? ("other" as const));
}
