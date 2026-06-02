import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { resolveAudio } from './audioResolver.ts';
import type { FetchFn } from './fetchWithTimeout.ts';

/**
 * Property-based test for single-attempt-per-instance discipline (task 2.5).
 *
 * Property 12: Each Piped instance is attempted at most once per resolution.
 * Validates: Requirements 4.3.
 *
 * Design ("Correctness Properties" / Property 12): *For any* instance list and
 * outcome sequence, each Piped_Instance is requested at most once during a
 * single resolution attempt. Requirement 4.3: "THE Audio_Resolver SHALL attempt
 * each configured Piped_Instance at most once per resolution attempt before
 * reporting failure."
 *
 * Interpretation of "configured Piped_Instance" (4.3):
 * The configured instances are an ORDERED LIST. The resolver attempts each LIST
 * ENTRY at most once. If the same base URL appeared twice in the list it would
 * (correctly) be attempted once per list position, so the total-calls bound is
 * `<= instances.length` in general. To keep this property aligned to the spec's
 * "each instance" wording and unambiguous, the generator produces a list of
 * DISTINCT base URLs (`https://piped{i}.example`). With distinct entries,
 * "per list position" and "per instance URL" coincide, so we can assert BOTH
 * the per-instance bound (each URL fetched at most once: count is 0 or 1) AND
 * the total bound (`<= instances.length`). Duplicate base URLs are intentionally
 * out of scope here; the resolver's per-position discipline already implies the
 * total bound regardless.
 *
 * Strategy: a deterministic, self-contained scripted fake `fetchImpl` (no real
 * network, no shared helper) records EVERY requested URL and maps each instance
 * to one of four per-instance outcomes — `usable` / `no_streams` / `http_error`
 * / `network` — exercising the success, empty-streams, HTTP-failure, and
 * transport-failure advance paths. numRuns is left at the global default (100).
 */

// --- Per-instance outcome model --------------------------------------------

type Outcome = 'usable' | 'no_streams' | 'http_error' | 'network';

/** Build a fake `Response` good enough for fetchWithTimeout (.ok/.status/.json). */
function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/**
 * Build a scripted fetch that records every requested URL into `calls` and
 * responds per the outcome assigned to the matching instance:
 *   - `usable`     -> 200 with one proxied (instance-hosted) audio stream.
 *   - `no_streams` -> 200 with an empty `audioStreams` array.
 *   - `http_error` -> 503 (advances as a per-instance `error`).
 *   - `network`    -> rejects (advances as a per-instance `error`).
 *
 * Matching is by EXACT URL equality against `{instance}/streams/{videoId}`, so
 * any unexpected URL throws loudly rather than being silently misclassified.
 */
function makeScriptedFetch(
  instances: string[],
  outcomes: Outcome[],
  videoId: string,
  calls: string[],
): FetchFn {
  return async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    const idx = instances.findIndex(
      (instance) => url === `${instance}/streams/${videoId}`,
    );
    if (idx === -1) {
      throw new Error(`scripted fetch received an unexpected URL: ${url}`);
    }
    switch (outcomes[idx]) {
      case 'network':
        throw new TypeError('network failure');
      case 'http_error':
        return fakeResponse(503, null);
      case 'no_streams':
        return fakeResponse(200, { audioStreams: [], duration: 0 });
      case 'usable':
      default:
        return fakeResponse(200, {
          // Proxied URL (host === instance host) so selection yields a usable
          // stream with corsReliable: true.
          audioStreams: [
            { url: `${instances[idx]}/proxy/videoplayback?itag=140`, bitrate: 128_000, videoOnly: false },
          ],
          duration: 100,
        });
    }
  };
}

// --- Generators (distinct instance URLs + an outcome per instance) ---------

const outcomeArb: fc.Arbitrary<Outcome> = fc.constantFrom<Outcome>(
  'usable',
  'no_streams',
  'http_error',
  'network',
);

/**
 * Generate an outcome per instance (1..8 instances), then derive a matching
 * list of DISTINCT base URLs from the outcome count. Deriving instances from
 * the outcomes guarantees `instances.length === outcomes.length` and that every
 * base URL is unique.
 */
const scenarioArb = fc
  .array(outcomeArb, { minLength: 1, maxLength: 8 })
  .map((outcomes) => ({
    outcomes,
    instances: outcomes.map((_, i) => `https://piped${i}.example`),
  }));

/** A simple, URL-safe video id; its exact value is irrelevant to the property. */
const videoIdArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,15}$/);

// --- Property 12 ------------------------------------------------------------

describe('Property 12: Each Piped instance is attempted at most once per resolution', () => {
  it('fetches each distinct instance at most once and never exceeds instances.length total', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, videoIdArb, async ({ instances, outcomes }, videoId) => {
        const calls: string[] = [];
        const fetchImpl = makeScriptedFetch(instances, outcomes, videoId, calls);

        const result = await resolveAudio(videoId, instances, { fetchImpl });

        const countFor = (instance: string): number =>
          calls.filter((u) => u === `${instance}/streams/${videoId}`).length;

        // Every recorded call must target a known instance URL (no stray fetches).
        const expectedUrls = new Set(
          instances.map((instance) => `${instance}/streams/${videoId}`),
        );
        for (const u of calls) {
          expect(expectedUrls.has(u)).toBe(true);
        }

        // Core Property 12 invariant: each distinct instance is fetched <= once.
        for (const instance of instances) {
          expect(countFor(instance)).toBeLessThanOrEqual(1);
        }

        // And the total number of fetches never exceeds the configured count.
        expect(calls.length).toBeLessThanOrEqual(instances.length);

        const firstUsable = outcomes.findIndex((o) => o === 'usable');

        if (firstUsable === -1) {
          // All instances fail: each is attempted EXACTLY once, total === length
          // (combined with advance-on-failure — Requirements 4.2, 4.3, 4.5).
          expect(result.ok).toBe(false);
          for (const instance of instances) {
            expect(countFor(instance)).toBe(1);
          }
          expect(calls.length).toBe(instances.length);
        } else {
          // An early instance is usable: the resolver stops there (4.4). Every
          // instance up to and including it is attempted exactly once; every
          // instance AFTER it is attempted ZERO times.
          expect(result.ok).toBe(true);
          for (let i = 0; i < instances.length; i++) {
            expect(countFor(instances[i]!)).toBe(i <= firstUsable ? 1 : 0);
          }
          expect(calls.length).toBe(firstUsable + 1);
        }
      }),
    );
  });
});
