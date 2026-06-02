import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { TrackCandidate } from '@glitch/core';
import { SongPickerController } from './songPickerController.ts';
import type { SearchBackend, SongSearchResult } from './searchBackend.ts';
import type { SearchFailure } from '../services/errorMessages.ts';

/**
 * Property-based test for single-in-flight search (task 10.4).
 *
 * Property 9: At most one search is in flight.
 * Validates: Requirements 3.5.
 *
 * Design ("Correctness Properties" / Property 9): *For any* sequence of
 * search-submit events, no new search is started while a previous search
 * remains pending (the picker admits at most one in-flight search at a time).
 * Requirement 3.5: "WHILE a search request is pending, THE Song_Picker SHALL
 * display a loading indicator and SHALL block submission of a new query until
 * the current search completes."
 *
 * The controller (`SongPickerController.search`) enforces this by returning the
 * existing in-flight promise when `inFlight !== null`, so a second concurrent
 * call can never launch a second backend request. We verify the property end to
 * end against a CONTROLLABLE deferred backend whose resolution we drive
 * manually, so "time" is modelled deterministically with microtask flushes — no
 * real timers and no real network.
 *
 * ## Controllable deferred-backend model
 *
 * `makeControllableBackend()` returns a `SearchBackend` that, on each
 * invocation:
 *   - increments a monotonic `callCount` (how many times the backend was
 *     entered across the whole scenario),
 *   - increments a live `concurrent` counter and updates `maxConcurrent` (the
 *     peak number of backend executions running at the same instant), and
 *   - returns a fresh deferred promise that stays pending until the test calls
 *     `settleOldest(result)`, at which point `concurrent` is decremented (the
 *     backend execution has finished) and the controller's `await` resumes.
 *
 * Because the backend never resolves on its own, the controller is held in its
 * "searching" state for as long as the test wants, letting us fire many rapid
 * `search()` calls strictly BEFORE the first request settles and observe that
 * `concurrent` (and therefore `maxConcurrent`) never exceeds 1.
 */

// --- Deferred-backend model -------------------------------------------------

interface ControllableBackend {
  /** The injectable backend handed to the controller. */
  backend: SearchBackend;
  /** Total number of times the backend has been invoked so far. */
  callCount(): number;
  /** Number of backend calls invoked but not yet settled. */
  pendingCount(): number;
  /** Peak number of backend executions observed running concurrently. */
  maxConcurrent(): number;
  /** Number of backend executions currently running (entered, not settled). */
  concurrent(): number;
  /** Settle the OLDEST still-pending backend call with the given result. */
  settleOldest(result: SongSearchResult): void;
}

function makeControllableBackend(): ControllableBackend {
  let calls = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  // Resolvers for each pending backend call, in invocation order. Each resolver
  // decrements `concurrent` before resolving so the live count tracks exactly
  // the backend executions that are still running.
  const resolvers: Array<(result: SongSearchResult) => void> = [];

  const backend: SearchBackend = (_query: string): Promise<SongSearchResult> => {
    calls += 1;
    concurrent += 1;
    if (concurrent > maxConcurrent) maxConcurrent = concurrent;
    return new Promise<SongSearchResult>((resolve) => {
      resolvers.push((result) => {
        concurrent -= 1;
        resolve(result);
      });
    });
  };

  return {
    backend,
    callCount: () => calls,
    pendingCount: () => resolvers.length,
    maxConcurrent: () => maxConcurrent,
    concurrent: () => concurrent,
    settleOldest: (result) => {
      const resolve = resolvers.shift();
      if (!resolve) {
        throw new Error('settleOldest called but no backend call is pending');
      }
      resolve(result);
    },
  };
}

/** Flush the microtask queue so awaited continuations in the controller run. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// --- Generators -------------------------------------------------------------

/** A structurally valid `TrackCandidate` (field values are irrelevant here). */
const candidateArb: fc.Arbitrary<TrackCandidate> = fc.record({
  videoId: fc.stringMatching(/^[A-Za-z0-9_-]{1,15}$/),
  title: fc.string(),
  artist: fc.string(),
  durationSec: fc.nat({ max: 600 }),
});

const searchFailureArb: fc.Arbitrary<SearchFailure> = fc.record({
  ok: fc.constant<false>(false),
  reason: fc.constantFrom<SearchFailure['reason']>('timeout', 'network', 'parse', 'http'),
});

/** The eventual outcome the backend resolves with (success or typed failure). */
const resultArb: fc.Arbitrary<SongSearchResult> = fc.oneof(
  fc.record({ ok: fc.constant<true>(true), candidates: fc.array(candidateArb, { maxLength: 5 }) }),
  fc.record({ ok: fc.constant<false>(false), failure: searchFailureArb }),
);

/**
 * K (2..10) rapid query strings issued back-to-back, plus the result the first
 * backend call eventually settles with. K is the array length so the count of
 * rapid `search()` calls and the supplied queries always agree.
 */
const scenarioArb = fc.record({
  queries: fc.array(fc.string(), { minLength: 2, maxLength: 10 }),
  firstResult: resultArb,
});

// --- Property 9 -------------------------------------------------------------

describe('Property 9: At most one search is in flight', () => {
  it('admits one backend request for K rapid calls, returns the same in-flight promise, and releases the lock on settle', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ queries, firstResult }) => {
        const cb = makeControllableBackend();
        const controller = new SongPickerController({ backend: cb.backend });
        const k = queries.length;

        // 1) First search: the backend is invoked synchronously and held
        //    pending, so the controller enters its searching state.
        const first = controller.search(queries[0]!);
        expect(cb.callCount()).toBe(1);
        expect(cb.pendingCount()).toBe(1);
        expect(controller.isSearching).toBe(true);

        // 2) K-1 more rapid calls WHILE the first is still pending. Each must be
        //    ignored: the backend is never re-entered, the lock stays held, and
        //    the SAME in-flight promise is handed back to every caller.
        for (let i = 1; i < k; i++) {
          const next = controller.search(queries[i]!);
          expect(next).toBe(first); // exact same promise reference
          expect(cb.callCount()).toBe(1);
          expect(cb.pendingCount()).toBe(1);
          expect(controller.isSearching).toBe(true);
          // Interleave a microtask flush to simulate async timing between
          // submits; with the backend still pending nothing should settle.
          await flushMicrotasks();
          expect(cb.callCount()).toBe(1);
          expect(controller.isSearching).toBe(true);
          // Core invariant: at most one backend execution at any instant.
          expect(cb.concurrent()).toBeLessThanOrEqual(1);
          expect(cb.maxConcurrent()).toBe(1);
        }

        // Across all K rapid submits the backend ran exactly once.
        expect(cb.callCount()).toBe(1);
        expect(cb.maxConcurrent()).toBe(1);

        // 3) Settle the single in-flight request. The lock is released: the
        //    controller is no longer searching once it has processed the result.
        cb.settleOldest(firstResult);
        await first;
        expect(controller.isSearching).toBe(false);
        expect(cb.pendingCount()).toBe(0);
        expect(cb.concurrent()).toBe(0);

        // 4) A SUBSEQUENT search now triggers a NEW backend call (lock released),
        //    incrementing the count to 2 and returning a fresh in-flight promise.
        const second = controller.search(queries[0]!);
        expect(cb.callCount()).toBe(2);
        expect(second).not.toBe(first);
        expect(controller.isSearching).toBe(true);
        expect(cb.maxConcurrent()).toBe(1);

        // Settle the second request to clean up and re-confirm the bound holds
        // across the full interleaving.
        cb.settleOldest({ ok: true, candidates: [] });
        await second;
        expect(controller.isSearching).toBe(false);
        expect(cb.maxConcurrent()).toBeLessThanOrEqual(1);
      }),
    );
  });
});
