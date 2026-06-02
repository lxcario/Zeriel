import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchWithTimeout,
  MAX_REQUEST_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type FetchFn,
} from './fetchWithTimeout.ts';

/**
 * Build a fake `Response`-like object good enough for fetchWithTimeout, which
 * only reads `.ok`, `.status`, and `.json()`.
 */
function fakeResponse(status: number, body: unknown, jsonThrows = false): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (jsonThrows) throw new SyntaxError('bad json');
      return body;
    },
  } as unknown as Response;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('fetchWithTimeout', () => {
  it('returns ok with parsed data on a 2xx JSON response', async () => {
    const payload = { hello: 'world' };
    const fetchImpl: FetchFn = vi.fn(async () => fakeResponse(200, payload));

    const result = await fetchWithTimeout<typeof payload>('https://x.test/api', {
      fetchImpl,
    });

    expect(result).toEqual({ ok: true, status: 200, data: payload });
  });

  it('reports a non-2xx response as an http failure with the status (e.g. 404)', async () => {
    const fetchImpl: FetchFn = vi.fn(async () => fakeResponse(404, null));

    const result = await fetchWithTimeout('https://x.test/api', { fetchImpl });

    expect(result).toEqual({ ok: false, reason: 'http', status: 404 });
  });

  it('reports a parse failure when a 2xx body is not valid JSON', async () => {
    const fetchImpl: FetchFn = vi.fn(async () => fakeResponse(200, null, true));

    const result = await fetchWithTimeout('https://x.test/api', { fetchImpl });

    expect(result).toEqual({ ok: false, reason: 'parse', status: 200 });
  });

  it('reports a network failure when fetch rejects for a non-timeout reason', async () => {
    const fetchImpl: FetchFn = vi.fn(async () => {
      throw new TypeError('connection refused');
    });

    const result = await fetchWithTimeout('https://x.test/api', { fetchImpl });

    expect(result).toEqual({ ok: false, reason: 'network' });
  });

  it('aborts and reports a timeout when the request exceeds the cap', async () => {
    vi.useFakeTimers();

    // A fetch that only rejects once its abort signal fires.
    const fetchImpl: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });

    const promise = fetchWithTimeout('https://x.test/slow', {
      fetchImpl,
      timeoutMs: 8000,
    });

    await vi.advanceTimersByTimeAsync(MAX_REQUEST_TIMEOUT_MS);
    const result = await promise;

    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });

  it('clamps a requested timeout above the cap down to 8000ms', async () => {
    vi.useFakeTimers();

    const fetchImpl: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });

    const promise = fetchWithTimeout('https://x.test/slow', {
      fetchImpl,
      timeoutMs: 60_000, // far above the cap
    });

    // Just before the cap, nothing has aborted yet.
    await vi.advanceTimersByTimeAsync(MAX_REQUEST_TIMEOUT_MS - 1);
    // Advancing to the cap triggers the abort -> timeout result.
    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;

    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });

  it('exposes the cap and default as the same 8000ms value', () => {
    expect(MAX_REQUEST_TIMEOUT_MS).toBe(8000);
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(8000);
  });
});
