/**
 * Lazy, feature-detected loading of an optional client library. The package name
 * is passed through a variable so bundlers keep it as a runtime `import()` and
 * never try to resolve it at build time. A load failure (package not installed)
 * becomes a {@link DriverUnavailableError} the tool layer renders as a friendly
 * "X not installed (npm i <pkg>)" instead of crashing.
 */

import { DriverUnavailableError } from "../driver.js";

export async function lazyImport<T>(pkg: string, dialect: string): Promise<T> {
  try {
    const spec = pkg;
    return (await import(spec)) as T;
  } catch {
    throw new DriverUnavailableError(pkg, dialect);
  }
}

/** Race a promise against an advisory deadline / abort signal. */
export async function withDeadline<T>(
  op: Promise<T>,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!timeoutMs && !signal) return op;
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = timeoutMs
      ? setTimeout(() => done(() => reject(new Error(`query timed out after ${timeoutMs}ms`))), timeoutMs)
      : undefined;
    const onAbort = signal ? (): void => done(() => reject(new Error("query aborted"))) : undefined;
    if (signal && onAbort) {
      if (signal.aborted) {
        done(() => reject(new Error("query aborted")));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    op.then(
      (v) => done(() => resolve(v)),
      (e) => done(() => reject(e instanceof Error ? e : new Error(String(e)))),
    );
  });
}
