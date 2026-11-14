import type { KeyboardEvent } from "react";
export function trapDialog(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== "Tab") return;
  const elements = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]",
    ),
  ];
  const first = elements[0],
    last = elements.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
