import type { KeyboardEvent, MouseEvent, SyntheticEvent } from "react";
// V1.11 standard behaviour for every Otherbridge <dialog> (modal and mobile sheet): the X button, Escape and a click
// on the backdrop close it; a click inside never does; Tab is trapped inside; focus returns to the element that
// opened it. Closing never creates, signs or sends anything — a financial review simply becomes stale and is
// re-validated (fresh quote) when reopened. Wallet-extension popups are outside Otherbridge and are not touched.
export function trapDialog(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== "Tab") return;
  const elements = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex]:not([tabindex='-1'])",
    ),
  ].filter((el) => el.offsetParent !== null || el === document.activeElement);
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
const returnFocus = new WeakMap<HTMLDialogElement, HTMLElement>();
const pressedOnBackdrop = new WeakMap<HTMLDialogElement, boolean>();
/** Opens a dialog modally and remembers where focus must return. */
export function openModal(
  dialog: HTMLDialogElement | null,
  trigger?: Element | null,
) {
  if (!dialog || dialog.open) return;
  const from = (trigger ?? document.activeElement) as HTMLElement | null;
  if (from && from !== document.body) returnFocus.set(dialog, from);
  dialog.showModal();
}
function onBackdrop(dialog: HTMLDialogElement, event: MouseEvent) {
  if (event.target !== dialog) return false;
  const r = dialog.getBoundingClientRect();
  return (
    event.clientX < r.left ||
    event.clientX > r.right ||
    event.clientY < r.top ||
    event.clientY > r.bottom
  );
}
/**
 * Props for a <dialog>: Escape and a backdrop click close the dialog element itself (the X button calls its own
 * `dialog.close()`); `onClosed` runs once it is closed (after focus returned). Handlers act on the event's dialog,
 * so nothing reads a ref during render. Spread onto the element: <dialog {...modalProps(onClosed)} />.
 */
export function modalProps(onClosed?: () => void) {
  return {
    onCancel(event: SyntheticEvent<HTMLDialogElement>) {
      event.preventDefault();
      event.currentTarget.close();
    },
    onMouseDown(event: MouseEvent<HTMLDialogElement>) {
      pressedOnBackdrop.set(
        event.currentTarget,
        onBackdrop(event.currentTarget, event),
      );
    },
    onClick(event: MouseEvent<HTMLDialogElement>) {
      const dialog = event.currentTarget;
      // Both press and release outside the panel: a text selection dragged out of the panel never closes it.
      if (pressedOnBackdrop.get(dialog) && onBackdrop(dialog, event))
        dialog.close();
      pressedOnBackdrop.delete(dialog);
    },
    onKeyDown: trapDialog,
    onClose(event: SyntheticEvent<HTMLDialogElement>) {
      const dialog = event.currentTarget;
      const target = returnFocus.get(dialog);
      returnFocus.delete(dialog);
      if (target?.isConnected) target.focus();
      onClosed?.();
    },
  };
}
