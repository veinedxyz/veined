"use client";
// The Guardian assistant across VEINED: a small King Octopus button at the inline-end corner that opens a compact
// conversation panel. Nothing loads, polls or calls the network until the user opens it and asks something; the
// panel's code is fetched on first open (or when the button is hovered or focused). Keyboard: the button toggles, Esc
// closes and returns focus, Tab stays in normal document order (non-modal). The button can be hidden; the choice is a
// local display preference (no conversation or wallet data is stored). Hidden on the Guardian page, which has the
// full conversation. gf1 G04: the button never rests on a control (wide screens keep a column for it; phones tuck it to
// the edge), and on wide screens the open panel takes its own column instead of covering the page.
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useI18n } from "../i18n/provider";
import { KingAvatar } from "./guardian-king";
import { Icon } from "./icons";
import type { GuardianChatProps } from "./guardian-chat";
import type { PageKey } from "../guardian/chat/engine";

const load = () => import("./guardian-chat");
const GuardianChat = dynamic(load, { ssr: false });

const PREF = "veined.guardian.dock";
/** gf1 G04: what counts as a control under the closed button (links, fields, disclosures and widget roles). `:has()`
 * sits inside the forgiving `:is()`, so a browser without it skips that part instead of rejecting the whole list. */
const CONTROLS =
  "a[href], button, input, select, textarea, summary, :is(label:has(> input)), [role=button], [role=link], [role=tab], [role=checkbox], [role=switch], [tabindex]:not([tabindex='-1'])";
const prefListeners = new Set<() => void>();
function readPref() {
  try {
    return localStorage.getItem(PREF) === "hidden" ? "hidden" : "shown";
  } catch {
    return "shown";
  }
}
export function setDockPreference(value: "hidden" | "shown") {
  try {
    if (value === "hidden") localStorage.setItem(PREF, "hidden");
    else localStorage.removeItem(PREF);
  } catch {}
  for (const l of prefListeners) l();
}
function subscribePref(l: () => void) {
  prefListeners.add(l);
  const storage = (e: StorageEvent) => e.key === PREF && l();
  window.addEventListener("storage", storage);
  return () => {
    prefListeners.delete(l);
    window.removeEventListener("storage", storage);
  };
}
export function useDockPreference() {
  return useSyncExternalStore(subscribePref, readPref, () => "shown" as const);
}

export default function GuardianDock({
  page,
  ...chat
}: { page: PageKey } & Omit<
  GuardianChatProps,
  "variant" | "page" | "titleId"
>) {
  const { t } = useI18n();
  const tx = (key: string) => t(key as never);
  const preference = useDockPreference();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const shown = preference !== "hidden" && page !== "guardian";
  // gf1 G04: on wide screens the open panel takes its own column (the page narrows instead of being covered).
  useEffect(() => {
    const html = document.documentElement;
    html.toggleAttribute("data-gdock-open", open && shown);
    return () => html.removeAttribute("data-gdock-open");
  }, [open, shown]);
  // gf1 G04: on narrow screens the closed button never rests on a control. When a link, button or field lies under its
  // place, it tucks to the screen edge as a full-height tab (keyboard focus or a tap brings it back; hover does not, so it
  // never slides away from the pointer). Checked on
  // scroll and resize at most once per frame, by hit-testing five points; nothing is polled.
  const [tucked, setTucked] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open || !shown) return;
    const narrow = window.matchMedia("(max-width: 1023px)");
    let frame = 0;
    const check = () => {
      frame = 0;
      const box = root.current?.getBoundingClientRect();
      if (!narrow.matches || !box || !box.width) return setTucked(false);
      // VWP G08: any overlap counts, not only five sample points: a control whose box meets the button's box and that
      // is really on top at the centre of the overlap (not hidden under another layer) makes the button tuck.
      const covers = (e: Element) => {
        if (root.current?.contains(e) || !e.getClientRects().length)
          return false;
        const r = e.getBoundingClientRect();
        const x0 = Math.max(r.left, box.left),
          x1 = Math.min(r.right, box.right),
          y0 = Math.max(r.top, box.top),
          y1 = Math.min(r.bottom, box.bottom);
        if (x1 <= x0 || y1 <= y0) return false;
        return document
          .elementsFromPoint((x0 + x1) / 2, (y0 + y1) / 2)
          .some(
            (h) => !root.current?.contains(h) && (h === e || e.contains(h)),
          );
      };
      setTucked([...document.querySelectorAll(CONTROLS)].some(covers));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    schedule();
    // The page's own content arrives after navigation: a change in the document's size is checked too.
    const sized = new ResizeObserver(schedule);
    sized.observe(document.body);
    window.addEventListener("scroll", schedule, { passive: true });
    // Lists that draw their rows while scrolling are checked once more when the scroll has ended (no timer).
    window.addEventListener("scrollend", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    narrow.addEventListener("change", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      sized.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("scrollend", schedule);
      window.removeEventListener("resize", schedule);
      narrow.removeEventListener("change", schedule);
    };
  }, [open, page, shown]);
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // gf1 G04: the page stays usable beside the open panel, so an Esc that belongs to the page (a field, a picker or
      // another dialog) stays with the page; only Esc from the assistant itself, or with nothing focused, closes it.
      const target = event.target as Node | null;
      const inside =
        !!target &&
        (!!panel.current?.contains(target) ||
          !!trigger.current?.contains(target));
      const nowhere =
        target === document.body || target === document.documentElement;
      if (!inside && !nowhere) return;
      if (
        !inside &&
        document.querySelector("dialog[open], [aria-modal='true']")
      )
        return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("keydown", key);
    // Focus the message field once the panel is there (first open waits for its chunk).
    const focus = setTimeout(
      () =>
        panel.current
          ?.querySelector<HTMLInputElement>(
            "[data-testid='guardian-chat-input']",
          )
          ?.focus(),
      60,
    );
    return () => {
      document.removeEventListener("keydown", key);
      clearTimeout(focus);
    };
  }, [open]);
  if (!shown) return null;
  return (
    <div
      ref={root}
      className="gdock"
      data-open={open ? "true" : undefined}
      data-tucked={tucked && !open ? "true" : undefined}
    >
      {mounted && (
        <section
          ref={panel}
          id="guardian-dock-panel"
          className="gdock-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="guardian-dock-title"
          hidden={!open}
          data-testid="guardian-dock-panel"
        >
          <div className="gdock-bar">
            <Link
              href="/guardian"
              className="gdock-full"
              onClick={() => setOpen(false)}
            >
              {tx("guardian.chat.dock.full")}
            </Link>
            <button
              type="button"
              className="gdock-hide"
              onClick={() => {
                setOpen(false);
                setDockPreference("hidden");
              }}
            >
              {tx("guardian.chat.dock.hide")}
            </button>
            <button
              type="button"
              className="icon-button gdock-close"
              aria-label={tx("guardian.chat.dock.close")}
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
          <GuardianChat
            {...chat}
            variant="dock"
            page={page}
            titleId="guardian-dock-title"
          />
        </section>
      )}
      <button
        ref={trigger}
        type="button"
        className="gdock-trigger"
        aria-label={tx(
          open ? "guardian.chat.dock.close" : "guardian.chat.dock.open",
        )}
        aria-expanded={open}
        aria-controls={mounted ? "guardian-dock-panel" : undefined}
        data-testid="guardian-dock-trigger"
        onPointerEnter={() => void load()}
        onFocus={() => void load()}
        onClick={() => {
          setMounted(true);
          setOpen((v) => !v);
        }}
      >
        <KingAvatar size={44} />
      </button>
    </div>
  );
}
