import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { resolveAudio, type PipedStreamsResponse } from './audioResolver.ts';
import type { FetchFn } from './fetchWithTimeout.ts';

/**
 * Property-based test for Piped fallback resolution outcome (task 2.4).
 *
 * Property 11: Piped fallback returns the first usable URL (preferring proxied)
 * or fails after exhausting instances.
 * **Validates: Requirements 4.2, 4.4, 4.5**
 *
 * Design ("Correctness Properties" / Property 11): *For any* ordered list of
 * Piped_Instances and any sequence of per-instance outcomes (error, timeout,
 * no-streams, or usable), the Audio_Resolver returns the stream URL of the
 * FIRST usable instance and reports no failure; if every instance outcome is a
 * failure, it reports an audio-resolution failure.
 *
 * ----------------------------------------------------------------------------
 * Synthetic-world model
 * ----------------------------------------------------------------------------
 * Each instance is assigned a deterministic, distinct, parseable base URL
 * (`https://piped-{i}.example`). For each instance we generate a "scripted
 * outcome" that the fake `fetchImpl` replays when the resolver requests that
 * instance's `/streams/{videoId}` URL:
 *
 *   - { kind: 'usable' }      -> 200 with one usable (`videoOnly === false`)
 *                                proxied audioStream. selectAudioStream returns
 *                                it; the resolver yields ok:true and STOPS.
 *   - { kind: 'no_streams' }  -> 200 with either an empty `audioStreams` array
 *                                or a `videoOnly`-only stream. selectAudioStream
 *                                returns null -> attempt outcome 'no_streams'.
 *   - { kind: 'http_error' }  -> a non-2xx Response. fetchWithTimeout reports
 *                                `reason: 'http'` -> attempt outcome 'error'.
 *   - { kind: 'network' }     -> fetch rejects (non-abort). fetchWithTimeout
 *                                reports `reason: 'network'` -> outcome 'error'.
 *
 * The fake fetch is keyed on the EXACT requested URL (`{instance}/streams/
 * {videoId}`), which uniquely encodes the instance, so per-instance scripts are
 * replayed independent of call order and never collide (distinct hosts).
 *
 * ----------------------------------------------------------------------------
 * How the 'timeout' instance-outcome is handled
 * ----------------------------------------------------------------------------
 * `resolveAudio` maps ONLY `fetchWithTimeout`'s `reason: 'timeout'` to the
 * `'timeout'` attempt outcome, and the helper only emits that reason from its
 * real `AbortController` timer path (which requires fake timers and a
 * never-resolving fetch to drive deterministically). To keep THIS property
 * deterministic and free of timer manipulation, the generated outcome space is
 * restricted to usable / no_streams / http_error / network (option (b) in the
 * task guidance). The 'timeout' path is covered elsewhere:
 *   - `fetchWithTimeout.prop.test.ts` exhaustively proves the helper aborts and
 *     returns `reason: 'timeout'` past the 8s cap (fake timers), and
 *   - the resolver's single `result.reason === 'timeout' ? 'timeout' : 'error'`
 *     mapping branch is a one-line pass-through over that proven reason.
 * Both 'http_error' and 'network' scripts already exercise the `'error'` arm of
 * that same branch here.
 *
 * numRuns is left at the global default (100, from `vitest.setup.ts`).
 */

// --- Fake Response / fetch plumbing -----------------------------------------

/** Build a fake `Response` good enough for fetchWithTimeout (.ok/.status/.json). */
function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** The deterministic base URL for instance index `i` (distinct + parseable). */
function instanceUrl(i: number): string {
  return `https://piped-${i}.example`;
}

/** The single usable stream a 'usable' instance serves (proxied to its host). */
function usableStreamUrl(instance: string): string {
  return `${instance}/media?itag=140`;
}

// --- Scripted per-instance outcomes -----------------------------------------

type Script =
  | { kind: 'usable' }
  | { kind: 'no_streams'; videoOnlyVariant: boolean }
  | { kind: 'http_error'; status: number }
  | { kind: 'network' };

const arbScript: fc.Arbitrary<Script> = fc.oneof(
  fc.constant<Script>({ kind: 'usable' }),
  fc.record({
    kind: fc.constant<'no_streams'>('no_streams'),
    videoOnlyVariant: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant<'http_error'>('http_error'),
    status: fc.constantFrom(400, 403, 404, 500, 502, 503),
  }),
  fc.constant<Script>({ kind: 'network' }),
);

/** The InstanceAttempt outcome the resolver must record for a failure script. */
function expectedFailureOutcome(script: Script): 'error' | 'no_streams' {
  switch (script.kind) {
    case 'no_streams':
      return 'no_streams';
    case 'http_error':
    case 'network':
      return 'error';
    case 'usable':
      throw new Error('usable is not a failure outcome');
  }
}

/** Build the response body a 'no_streams' instance returns for its variant. */
function noStreamsBody(videoOnlyVariant: boolean): PipedStreamsResponse {
  return videoOnlyVariant
    ? { audioStreams: [{ url: 'https://cdn.example/v', bitrate: 128_000, videoOnly: true }], duration: 5 }
    : { audioStreams: [], duration: 5 };
}

/**
 * Build a fake `fetchImpl` that replays the per-instance script keyed on the
 * exact requested URL. Returns the spy so the test can assert call count and
 * which instance URLs were (not) requested.
 */
function makeFetchImpl(
  instances: string[],
  scripts: Script[],
  videoId: string,
): FetchFn & ReturnType<typeof vi.fn> {
  const urlToScript = new Map<string, Script>();
  instances.forEach((instance, i) => {
    urlToScript.set(`${instance}/streams/${videoId}`, scripts[i]!);
  });

  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    const script = urlToScript.get(url);
    if (script === undefined) {
      // Should never happen: the resolver only ever requests scripted URLs.
      throw new Error(`unexpected fetch URL: ${url}`);
    }
    switch (script.kind) {
      case 'usable':
        return fakeResponse(200, {
          audioStreams: [
            { url: usableStreamUrl(url.replace(`/streams/${videoId}`, '')), bitrate: 128_000, videoOnly: false },
          ],
          duration: 123,
        } satisfies PipedStreamsResponse);
      case 'no_streams':
        return fakeResponse(200, noStreamsBody(script.videoOnlyVariant));
      case 'http_error':
        return fakeResponse(script.status, null);
      case 'network':
        throw new TypeError('simulated network failure');
    }
  }) as FetchFn & ReturnType<typeof vi.fn>;
}

// --- Property 11 ------------------------------------------------------------

describe('Property 11: Piped fallback first-usable-or-exhaust (Requirements 4.2, 4.4, 4.5)', () => {
  it('returns the first usable instance and stops, or fails after exhausting all', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbScript, { minLength: 0, maxLength: 8 }),
        fc.string({ maxLength: 16 }),
        async (scripts, videoId) => {
          const instances = scripts.map((_, i) => instanceUrl(i));
          const fetchImpl = makeFetchImpl(instances, scripts, videoId);

          const result = await resolveAudio(videoId, instances, { fetchImpl });

          const firstUsable = scripts.findIndex((s) => s.kind === 'usable');

          // Helper: the exact URL the resolver requests for instance index `i`.
          const requestedUrls = fetchImpl.mock.calls.map((call) => String(call[0]));

          if (firstUsable >= 0) {
            // ---- A usable instance exists (Requirement 4.4) ----
            const usableInstance = instances[firstUsable]!;
            expect(result).toEqual({
              ok: true,
              streamUrl: usableStreamUrl(usableInstance),
              instanceUsed: usableInstance,
              corsReliable: true,
              durationSec: 123,
            });

            // Exactly (firstUsable + 1) instances were fetched: early stop.
            expect(fetchImpl).toHaveBeenCalledTimes(firstUsable + 1);

            // No instance AFTER the first usable one was ever requested.
            for (let i = firstUsable + 1; i < instances.length; i += 1) {
              expect(requestedUrls).not.toContain(`${instances[i]}/streams/${videoId}`);
            }
            // Every instance up to and including the first usable WAS requested, in order.
            for (let i = 0; i <= firstUsable; i += 1) {
              expect(requestedUrls[i]).toBe(`${instances[i]}/streams/${videoId}`);
            }
          } else {
            // ---- No usable instance: all_instances_failed (Requirements 4.2, 4.5) ----
            expect(result.ok).toBe(false);
            if (result.ok) {
              throw new Error('expected failure');
            }
            expect(result.reason).toBe('all_instances_failed');

            // One attempt per instance, IN ORDER, each matching its scripted kind.
            expect(result.attempts).toHaveLength(instances.length);
            instances.forEach((instance, i) => {
              expect(result.attempts[i]).toEqual({
                instance,
                outcome: expectedFailureOutcome(scripts[i]!),
              });
            });

            // Every instance was attempted exactly once (Requirement 4.2).
            expect(fetchImpl).toHaveBeenCalledTimes(instances.length);
          }
        },
      ),
    );
  });
});
