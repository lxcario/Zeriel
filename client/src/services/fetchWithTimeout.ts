/**
 * Shared request-discipline helper for all external service clients.
 *
 * Design references:
 * - design.md "Request Discipline (shared)": every external request (Piped,
 *   LRCLIB, search) goes through one `fetchWithTimeout` helper using an
 *   `AbortController` with an 8000ms cap; any request exceeding the cap is
 *   aborted and treated as failed (Requirement 17.2). Failures bubble up as
 *   typed results that the UI later maps to actionable, retryable messages
 *   (Requirements 17.1, 17.5 — handled by task 2.9, not here).
 *
 * This helper lives in the client package (not `@glitch/core`) because it
 * touches `fetch`/`AbortController` (web APIs). `core` must stay free of
 * network/DOM. Later service-client tasks (2.3 Audio_Resolver, 2.6
 * Lyrics_Service, 10.1 search) consume this from `client/src/services/`.
 *
 * Design notes for downstream composition:
 * - Returns a discriminated union (never throws for timeout/HTTP/network/parse
 *   failures), so callers can `switch (result.reason)` to map outcomes.
 * - Non-OK HTTP responses are reported distinctly (`reason: 'http'` with the
 *   `status`) so the Lyrics_Service can tell a 404 (no-lyrics, Requirement 6.4)
 *   apart from a network/timeout failure (retrieval-failed, Requirement 6.5).
 * - The fetch implementation is injectable (`fetchImpl`) so tests — including
 *   the optional property test in task 2.2 — can drive it deterministically
 *   with fake timers and a fake fetch, with no real network.
 */

/** Hard cap on any external request, per Requirement 17.2 ("at most 8 seconds"). */
export const MAX_REQUEST_TIMEOUT_MS = 8000;

/** Default request timeout. Equal to the hard cap by design. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 8000;

/**
 * The shape of the `fetch` function this helper depends on. Global `fetch` is
 * assignable to this type; tests can supply a compatible fake.
 */
export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Why a request did not yield parsed JSON data:
 * - `timeout`  — the request exceeded the (capped) timeout and was aborted.
 * - `network`  — `fetch` itself rejected (DNS/connection/CORS-style failure).
 * - `http`     — the server responded with a non-2xx status (`status` is set).
 * - `parse`    — a 2xx response body could not be parsed as JSON (`status` set).
 */
export type FetchFailureReason = 'timeout' | 'network' | 'http' | 'parse';

/**
 * Typed result of {@link fetchWithTimeout}. A discriminated union so callers
 * branch on `ok` first, then on `reason` for failures. `status` is present for
 * `http` and `parse` failures (and always on success).
 */
export type FetchResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; reason: FetchFailureReason; status?: number };

/** Optional configuration for {@link fetchWithTimeout}. */
export interface FetchWithTimeoutOptions {
  /**
   * Requested timeout in milliseconds. Clamped to {@link MAX_REQUEST_TIMEOUT_MS};
   * a value above the cap is never honored (Requirement 17.2). Non-finite or
   * non-positive values fall back to {@link DEFAULT_REQUEST_TIMEOUT_MS}.
   */
  timeoutMs?: number;
  /** Extra fetch options (method, headers, body, etc.). Any `signal` is replaced. */
  init?: RequestInit;
  /** Injected fetch implementation; defaults to the global `fetch`. */
  fetchImpl?: FetchFn;
}

/**
 * Clamp a requested timeout to the allowed range. Never exceeds the 8000ms cap.
 */
function resolveTimeoutMs(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  return Math.min(requested, MAX_REQUEST_TIMEOUT_MS);
}

/**
 * Perform a JSON `fetch` guarded by an `AbortController` timeout.
 *
 * Resolves to a {@link FetchResult}; it does not throw for timeout, network,
 * HTTP, or JSON-parse failures. The timeout timer is always cleared in a
 * `finally` block so it can never leak. On a timeout-triggered abort, the
 * result is `{ ok: false, reason: 'timeout' }`.
 *
 * @typeParam T - Expected shape of the parsed JSON payload on success.
 */
export async function fetchWithTimeout<T>(
  url: string,
  options: FetchWithTimeoutOptions = {},
): Promise<FetchResult<T>> {
  const { init, timeoutMs } = options;
  const doFetch: FetchFn = options.fetchImpl ?? fetch;
  const effectiveTimeoutMs = resolveTimeoutMs(timeoutMs);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, effectiveTimeoutMs);

  try {
    const response = await doFetch(url, { ...init, signal: controller.signal });

    if (!response.ok) {
      // Non-2xx is a distinct, recoverable outcome (e.g. 404 => no-lyrics).
      return { ok: false, reason: 'http', status: response.status };
    }

    try {
      const data = (await response.json()) as T;
      return { ok: true, status: response.status, data };
    } catch {
      // 2xx but the body was not valid JSON.
      return { ok: false, reason: 'parse', status: response.status };
    }
  } catch {
    // Distinguish a timeout-triggered abort from any other fetch rejection.
    if (timedOut) {
      return { ok: false, reason: 'timeout' };
    }
    return { ok: false, reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}
