/**
 * Abort Utilities
 *
 * Race an async operation against an AbortSignal. Used by the tool loop
 * to let the watchdog/supervisor abort long-running LLM calls or tool
 * executions without leaving dangling promises.
 */

/**
 * Race an async operation against an AbortSignal.
 * If signal fires before the operation completes, rejects with an error.
 * If no signal provided, just runs the operation normally.
 */
export function abortableCall<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return fn();
  if (signal.aborted) return Promise.reject(new Error("Operation aborted by watchdog"));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new Error("Operation aborted by watchdog — task exceeded time limit. Check injection queue for investigator diagnosis."));
    };

    signal.addEventListener("abort", onAbort, { once: true });

    fn().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
