export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    /** Seconds until a 429 may be retried, from the Retry-After header. */
    public retryAfter?: number,
  ) {
    super(message ?? code);
  }
}

/**
 * Seconds from a `Retry-After` header, or undefined when it is missing, empty,
 * not a number or not positive (`Number("")` would read an empty one as 0).
 */
export function retryAfterHeader(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiRequestError(
      res.status,
      body.error ?? `http_${res.status}`,
      body.message,
      retryAfterHeader(res.headers.get("retry-after")),
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
