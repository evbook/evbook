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

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    const retryAfter = Number(res.headers.get("retry-after") ?? NaN);
    throw new ApiRequestError(
      res.status,
      body.error ?? `http_${res.status}`,
      body.message,
      Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined,
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
