import { AsyncLocalStorage } from "node:async_hooks";
type Span = { operation: string; durationMs: number; failed: boolean };
const spans = new AsyncLocalStorage<Span[]>();
export async function measuredRead<T>(
  operation: string,
  read: () => Promise<T>,
) {
  const started = performance.now();
  let failed = false;
  try {
    return await read();
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    const active = spans.getStore();
    if (active && active.length < 256)
      active.push({
        operation,
        durationMs: Math.round(performance.now() - started),
        failed,
      });
  }
}
export async function profileManual<T>(work: () => Promise<T>) {
  const reads: Span[] = [];
  const started = performance.now();
  const value = await spans.run(reads, work);
  return {
    value,
    timing: { durationMs: Math.round(performance.now() - started), reads },
  };
}
