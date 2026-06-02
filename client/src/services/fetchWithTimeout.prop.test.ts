import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fc from 'fast-check';
import {
  fetchWithTimeout,
  MAX_REQUEST_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type FetchFn,
  type FetchResult,
  type FetchWithTimeoutOptions,
} from './fetchWithTimeout.ts';

/**
 * Property 40: External requests fail past the timeout.
 *
 * *For any* simulated response delay D, the shared request helper resolves
 * normally when D <= 8000ms and aborts the request and reports failure when
 * D > 8000ms.
 *
 * Validates: Requirements 17.2
 *
 * Test strategy:
 * - We model "a request that would take longer than the (capped) timeout" with
 *   a fake `fetchImpl` that NEVER resolves on its own; it only rejects once its
 *   `AbortController` signal fires. So whatever the effective timeout turns out
 *   to be, the request is always still in flight when the timer trips.
 * - Vitest fake timers make this deterministic and instant (no real waiting):
 *   we advance virtual time to just-before the expected bound (must NOT settle)
 *   and then to the bound itself (must settle with `reason: 'timeout'`).
 * - The effective wait is the helper's contract: `min(requested, 8000)` for a
 *   positive, finite requested timeout, and the default `8000` for any
 *   non-positive / non-finite / missing request. This is always <= the 8000ms
 *   cap, which is the core guarantee of Requirement 17.2.
 * - The cap is exercised directly: when `requested > 8000`, the bound at which
 *   the request settles is asserted to be exactly 8000, not the larger
 *   requested value. If the cap were not enforced, the request would still be
 *   pending at 8000ms and the `settled === true` assertion at the bound would
 *   fail loudly.
 */

/**
 * The helper's effective-timeout contract, expressed independently of the
 * implementation: clamp positive finite requests to the cap, and fall back to
 * the default for anything non-positive or non-finite (or absent).
 */
function expectedEffectiveTimeout(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  return Math.min(requested, MAX_REQUEST_TIMEOUT_MS);
}

/**
 * Requested-timeout generator spanning every regime the contract cares about:
 * above the cap, exactly at the cap, below the cap, zero, negative, the
 * non-finite specials, and an absent value. Finite values are kept integral so
 * fake-timer advancement lands exactly on the bound.
 */
const arbRequestedTimeout: fc.Arbitrary<number | undefined> = fc.oneof(
  fc.integer({ min: MAX_REQUEST_TIMEOUT_MS + 1, max: 1_000_000 }), // above the cap
  fc.constant(MAX_REQUEST_TIMEOUT_MS), // exactly at the cap
  fc.integer({ min: 1, max: MAX_REQUEST_TIMEOUT_MS - 1 }), // below the cap
  fc.constant(0), // zero -> default
  fc.integer({ min: -1_000_000, max: -1 }), // negative -> default
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY), // non-finite -> default
  fc.constant(undefined), // absent -> default
);

/**
 * A fetch that models a never-finishing-in-time request: it only ever rejects
 * once the abort signal fires (mirroring how a real aborted fetch rejects with
 * an `AbortError`).
 */
const neverResolvesUntilAborted: FetchFn = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('fetchWithTimeout — Property 40: external requests fail past the timeout', () => {
  it('never waits longer than the 8000ms cap and reports a timeout failure', async () => {
    await fc.assert(
      fc.asyncProperty(arbRequestedTimeout, async (requested) => {
        vi.useFakeTimers();
        try {
          const effective = expectedEffectiveTimeout(requested);

          // The core Requirement 17.2 guarantee: the wait can never exceed the cap.
          expect(effective).toBeLessThanOrEqual(MAX_REQUEST_TIMEOUT_MS);
          // A request above the cap must be clamped down to exactly the cap.
          if (typeof requested === 'number' && Number.isFinite(requested) && requested > MAX_REQUEST_TIMEOUT_MS) {
            expect(effective).toBe(MAX_REQUEST_TIMEOUT_MS);
          }

          let settled = false;
          let outcome: FetchResult<unknown> | undefined;
          // Build options so `timeoutMs` is OMITTED when absent rather than set
          // to `undefined` (required under `exactOptionalPropertyTypes`). The
          // generator intentionally yields `undefined` for the "absent timeout"
          // regime; the helper then falls back to its default, which is exactly
          // what the property asserts.
          const options: FetchWithTimeoutOptions = {
            fetchImpl: neverResolvesUntilAborted,
          };
          if (requested !== undefined) {
            options.timeoutMs = requested;
          }
          const promise = fetchWithTimeout<unknown>('https://x.test/slow', options).then((result) => {
            settled = true;
            outcome = result;
            return result;
          });

          // Just before the effective bound: the request is still in flight.
          await vi.advanceTimersByTimeAsync(effective - 1);
          expect(settled).toBe(false);

          // Reaching the bound aborts the request and settles it as a timeout.
          await vi.advanceTimersByTimeAsync(1);
          expect(settled).toBe(true);
          expect(outcome).toEqual({ ok: false, reason: 'timeout' });

          await promise;
        } finally {
          vi.useRealTimers();
        }
      }),
    );
  });
});
