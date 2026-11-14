"use client";
// G12: Swap and Bridge each offer two kinds of route — VEINED's own route search on the selected networks, or the
// reviewed NEAR Intents route to a NEAR account. A two-button switch (aria-pressed), mirrored in `?to=near` so the
// NEAR route can be linked directly; the URL is only read after hydration.
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../i18n/provider";

export type RouteKind = "network" | "near";

/** `page` (the pathname, when one component serves several pages) re-reads the URL after client navigation, so the
 * switch never disagrees with the address bar (and a Portfolio or Guardian prefill arriving on a new page is shown). */
export function useRouteKind(page?: string) {
  const [kind, setKind] = useState<RouteKind>("network");
  useEffect(() => {
    const timer = setTimeout(() => {
      setKind(
        new URLSearchParams(window.location.search).get("to") === "near"
          ? "near"
          : "network",
      );
    }, 0);
    return () => clearTimeout(timer);
  }, [page]);
  const choose = useCallback((next: RouteKind) => {
    setKind(next);
    const url = new URL(window.location.href);
    if (next === "near") url.searchParams.set("to", "near");
    else url.searchParams.delete("to");
    window.history.replaceState(window.history.state, "", url);
  }, []);
  return [kind, choose] as const;
}

export function RouteKindSwitch({
  kind,
  onChange,
  mode,
}: {
  kind: RouteKind;
  onChange: (kind: RouteKind) => void;
  mode: "bridge" | "swap";
}) {
  const { t } = useI18n();
  return (
    <div
      className="route-kind"
      role="group"
      aria-label={t("g12.nr.kindLabel")}
      data-testid="route-kind"
    >
      {(["network", "near"] as const).map((k) => (
        <button
          key={k}
          type="button"
          className={`route-kind-option${kind === k ? " is-active" : ""}`}
          aria-pressed={kind === k}
          data-kind={k}
          onClick={() => onChange(k)}
        >
          <strong>
            {t(
              k === "near"
                ? "g12.nr.kindNear"
                : mode === "swap"
                  ? "g12.nr.kindSwap"
                  : "g12.nr.kindBridge",
            )}
          </strong>
          <small>
            {t(
              k === "near"
                ? "g12.nr.kindNearHint"
                : mode === "swap"
                  ? "g12.nr.kindSwapHint"
                  : "g12.nr.kindBridgeHint",
            )}
          </small>
        </button>
      ))}
    </div>
  );
}
