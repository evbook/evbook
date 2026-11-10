/**
 * Run `work` with an abort signal that fires after `ms`, and clear the timer
 * the moment `work` settles.
 *
 * Use this instead of `AbortSignal.timeout(ms)` for anything that runs inside
 * a Durable Object. That signal's timer is never cancelled: it stays pending
 * after the response has arrived, and a pending timer keeps the object from
 * becoming eligible for hibernation — so the object is billed for the whole
 * deadline, not for the request. In production that was every parked-car probe
 * billed 10.3 s (its 10 s deadline) for ~300 ms of work, and every token refresh
 * billed exactly 60 s.
 *
 * `work` must finish reading the body before it resolves: the deadline covers
 * the body too, and a timer cleared after the headers would not.
 */
export async function withDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("The operation timed out", "TimeoutError")), ms);
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether `error` is the rejection `withDeadline` (or any timeout signal) causes. */
export function isTimeout(error: unknown): boolean {
  if (error instanceof DOMException || error instanceof Error) {
    return error.name === "TimeoutError" || error.message.includes("timed out");
  }
  return false;
}
