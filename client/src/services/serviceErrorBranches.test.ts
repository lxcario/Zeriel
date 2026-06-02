import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchSynced } from './lyricsService.ts';
import { resolveAudio } from './audioResolver.ts';
import { mapExternalError, type LyricsFailure } from './errorMessages.ts';
import type { FetchFn } from './fetchWithTimeout.ts';
import type { TrackSignature } from '@glitch/core';

/**
 * Task 2.11 — Unit tests for service error branches.
 *
 * Focused, example-based coverage (no fast-check) of the three operator-facing
 * failure paths that wire external-service results into actionable UI:
 *
 *   1. NO-LYRICS branch          — Requirements 6.4, 17.3
 *   2. LYRICS-RETRIEVAL-FAILURE  — Requirement 6.5 (retryable error state)
 *   3. AUDIO-RESOLUTION-FAILURE  — Requirements 4.5 (pick a different track),
 *                                   4.6 (retry resolution)
 *
 * Each path is driven end-to-end: the real service (`fetchSynced` /
 * `resolveAudio`) classifies an injected fake-`fetch` outcome, and the
 * resulting typed failure is fed straight into `mapExternalError` to assert the
 * next-step actions the Client offers. There is NO real network — `fetchImpl`
 * is injected and returns fake `Response` objects ({ ok, status, json }) so
 * behavior is deterministic.
 *
 * Timeout handling (documented choice): the `retrieval_failed` branch is
 * primarily exercised via a network reject and a non-404 HTTP error (500),
 * which are fully deterministic. A dedicated `timeout` case is ALSO included
 * using `vi.useFakeTimers` + a never-resolving-until-abort fetch so the real
 * 8s `AbortController` path inside `fetchWithTimeout` is driven through
 * `fetchSynced`. (The timeout mechanics themselves are covered in depth by
 * `fetchWithTimeout.test.ts`; here we confirm `fetchSynced` maps a timed-out
 * `/api/get` to `retrieval_failed`.)
 */

// ---------------------------------------------------------------------------
// Fakes / helpers
// ---------------------------------------------------------------------------

/** Build a fake `Response` good enough for fetchWithTimeout (.ok/.status/.json). */
function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/**
 * Route a fake fetch by the LRCLIB endpoint it hits. `fetchSynced` requests
 * `/api/get` first and only calls `/api/search` on the no-lyrics-miss path, so
 * routing on the path lets each test script both legs independently.
 */
function lrclibRouter(handlers: {
  get: () => Response | Promise<Response>;
  search?: () => Response | Promise<Response>;
}): FetchFn {
  return vi.fn(async (input: string | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/search')) {
      if (!handlers.search) {
        throw new Error(`unexpected /api/search call: ${url}`);
      }
      return handlers.search();
    }
    return handlers.get();
  });
}

const SIG: TrackSignature = {
  trackName: 'Glitch Anthem',
  artistName: 'The Ropes',
  albumName: 'Tangle',
  durationSec: 211,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1) NO-LYRICS branch (Requirements 6.4, 17.3)
// ---------------------------------------------------------------------------

describe('no-lyrics branch (Requirements 6.4, 17.3)', () => {
  it('classifies a 404 /api/get with an empty search fallback as no_lyrics', async () => {
    const fetchImpl = lrclibRouter({
      get: () => fakeResponse(404, null),
      search: () => fakeResponse(200, []),
    });

    const result = await fetchSynced(SIG, { fetchImpl });

    expect(result).toEqual({ ok: false, reason: 'no_lyrics' });
    // The fallback runs only on the no-lyrics-miss path: /api/get then /api/search.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('classifies a 404 /api/get with fallback candidates lacking syncedLyrics as no_lyrics', async () => {
    const fetchImpl = lrclibRouter({
      get: () => fakeResponse(404, null),
      search: () =>
        fakeResponse(200, [
          { trackName: 'Glitch Anthem', artistName: 'The Ropes', syncedLyrics: null },
          { trackName: 'Glitch Anthem (Live)', artistName: 'The Ropes' },
        ]),
    });

    const result = await fetchSynced(SIG, { fetchImpl });

    expect(result).toEqual({ ok: false, reason: 'no_lyrics' });
  });

  it('classifies a 200 /api/get with syncedLyrics: null and an empty fallback as no_lyrics', async () => {
    const fetchImpl = lrclibRouter({
      get: () => fakeResponse(200, { syncedLyrics: null }),
      search: () => fakeResponse(200, []),
    });

    const result = await fetchSynced(SIG, { fetchImpl });

    expect(result).toEqual({ ok: false, reason: 'no_lyrics' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('maps a no_lyrics failure to continue-lyrics-free + pick-different-track, no retry, not recoverable', async () => {
    const fetchImpl = lrclibRouter({
      get: () => fakeResponse(404, null),
      search: () => fakeResponse(200, []),
    });

    const result = await fetchSynced(SIG, { fetchImpl });
    expect(result.ok).toBe(false);

    // Feed the real service failure straight into the UI mapping (no adapter).
    const presentation = mapExternalError(result as LyricsFailure);
    const kinds = presentation.actions.map((a) => a.kind);

    expect(presentation.message.trim().length).toBeGreaterThan(0);
    expect(kinds).toContain('continue_lyrics_free');
    expect(kinds).toContain('pick_different_track');
    expect(kinds).not.toContain('retry');
    expect(presentation.recoverable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2) LYRICS-RETRIEVAL-FAILURE retry state (Requirement 6.5)
// ---------------------------------------------------------------------------

describe('lyrics-retrieval-failure retry state (Requirement 6.5)', () => {
  it('classifies a network reject on /api/get as retrieval_failed (no fallback)', async () => {
    const fetchImpl = lrclibRouter({
      get: () => {
        throw new TypeError('connection refused');
      },
    });

    const result = await fetchSynced(SIG, { fetchImpl });

    expect(result).toEqual({ ok: false, reason: 'retrieval_failed' });
    // A transport failure must NOT trigger the /api/search fallback.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('classifies a non-404 HTTP error (500) on /api/get as retrieval_failed (no fallback)', async () => {
    const fetchImpl = lrclibRouter({
      get: () => fakeResponse(500, null),
    });

    const result = await fetchSynced(SIG, { fetchImpl });

    expect(result).toEqual({ ok: false, reason: 'retrieval_failed' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('classifies a timed-out /api/get as retrieval_failed via the real 8s abort path', async () => {
    vi.useFakeTimers();

    // A fetch that only rejects once its abort signal fires (real timeout path).
    const fetchImpl: FetchFn = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );

    const promise = fetchSynced(SIG, { fetchImpl });
    // Advance to the 8s cap so fetchWithTimeout aborts the request.
    await vi.advanceTimersByTimeAsync(8000);
    const result = await promise;

    expect(result).toEqual({ ok: false, reason: 'retrieval_failed' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps a retrieval_failed failure to a recoverable retry state', async () => {
    const fetchImpl = lrclibRouter({
      get: () => fakeResponse(500, null),
    });

    const result = await fetchSynced(SIG, { fetchImpl });
    expect(result.ok).toBe(false);

    const presentation = mapExternalError(result as LyricsFailure);
    const kinds = presentation.actions.map((a) => a.kind);

    expect(presentation.message.trim().length).toBeGreaterThan(0);
    expect(kinds).toContain('retry');
    expect(presentation.recoverable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3) AUDIO-RESOLUTION-FAILURE "pick a different track" branch (Reqs 4.5, 4.6)
// ---------------------------------------------------------------------------

describe('audio-resolution-failure pick-a-different-track branch (Requirements 4.5, 4.6)', () => {
  const INSTANCES = [
    'https://piped.a.example',
    'https://piped.b.example',
    'https://piped.c.example',
  ];

  it('reports all_instances_failed with one attempt per instance (http error, network reject, no_streams)', async () => {
    // a -> 503 (http error), b -> network reject, c -> 200 with empty streams.
    const fetchImpl: FetchFn = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(503, null))
      .mockRejectedValueOnce(new TypeError('connection refused'))
      .mockResolvedValueOnce(fakeResponse(200, { audioStreams: [], duration: 0 }));

    const result = await resolveAudio('vidX', INSTANCES, { fetchImpl });

    expect(result).toEqual({
      ok: false,
      reason: 'all_instances_failed',
      attempts: [
        { instance: INSTANCES[0], outcome: 'error' },
        { instance: INSTANCES[1], outcome: 'error' },
        { instance: INSTANCES[2], outcome: 'no_streams' },
      ],
    });
    // One attempt per instance, exhausting the list (Requirement 4.3 / 4.5).
    expect(fetchImpl).toHaveBeenCalledTimes(INSTANCES.length);
  });

  it('maps all_instances_failed to a recoverable state with retry AND pick-different-track', async () => {
    const fetchImpl: FetchFn = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(404, null))
      .mockResolvedValueOnce(fakeResponse(200, { audioStreams: [], duration: 0 }));

    const result = await resolveAudio('vidX', INSTANCES.slice(0, 2), { fetchImpl });
    expect(result.ok).toBe(false);

    if (result.ok) {
      throw new Error('expected an audio-resolution failure');
    }
    const presentation = mapExternalError(result);
    const kinds = presentation.actions.map((a) => a.kind);

    expect(presentation.message.trim().length).toBeGreaterThan(0);
    // Requirement 4.5: offer to select a different track.
    expect(kinds).toContain('pick_different_track');
    // Requirement 4.6: offer to retry resolution.
    expect(kinds).toContain('retry');
    expect(presentation.recoverable).toBe(true);
  });
});
