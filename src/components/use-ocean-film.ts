import { useSyncExternalStore } from "react";
import {
  browserFilmEnvironment,
  filmEligible,
  filmVariant,
  type FilmVariant,
} from "./ocean-film";

// The visitor's film decision, read from the browser without a hydration mismatch: the server (and the first client
// render) say "pending"; once the page has loaded (the hero and the interface come first) it is the derivative for
// this viewport, or "still". Device facts and the viewport are read once per visit, so a resize never swaps the film
// (nothing is downloaded twice); reduced motion is followed live.
const REDUCE = "(prefers-reduced-motion: reduce)";
let base: FilmVariant | "still" | null = null;
function decision(): FilmVariant | "still" {
  if (matchMedia(REDUCE).matches) return "still";
  base ??=
    filmEligible(browserFilmEnvironment()) === "film"
      ? filmVariant(window.innerWidth, window.innerHeight, devicePixelRatio)
      : "still";
  return base;
}
function subscribe(change: () => void) {
  const motion = matchMedia(REDUCE);
  motion.addEventListener("change", change);
  window.addEventListener("load", change);
  return () => {
    motion.removeEventListener("change", change);
    window.removeEventListener("load", change);
  };
}
export function useOceanFilm(): FilmVariant | "still" | "pending" {
  return useSyncExternalStore(
    subscribe,
    () => (document.readyState === "complete" ? decision() : "pending"),
    () => "pending",
  );
}
