import { describe, it, expect } from 'vitest';
import {
  createSongPickerController,
  type SongPickerController,
} from './songPickerController.ts';
import type { SearchBackend, SongSearchResult } from './searchBackend.ts';
import type { TrackCandidate } from '@glitch/core';

/**
 * Task 10.6 — Unit test for empty search results.
 *
 * Focused, example-based coverage (no fast-check) of Requirement 3.4:
 *
 *   IF a search query returns no matching candidates, THEN the Song_Picker
 *   SHALL display a "no results" message and allow the Host to enter a new
 *   query only AFTER the current search request completes.
 *
 * The controller exposes the "no results" condition as state
 * (`getState().noResults`) that the React view renders the message from, and
 * enforces the "new query only after completion" rule via its single-in-flight
 * lock (a `search()` call made while one is pending is ignored and returns the
 * existing in-flight promise). These tests assert both halves:
 *
 *   1. NO-RESULTS state           — a completed empty search raises `noResults`.
 *   2. NON-EMPTY clears noResults  — a completed non-empty search clears it.
 *   3. noResults resets in flight  — a new pending search clears the message.
 *   4. POST-COMPLETION re-query    — a new query is blocked until the current
 *                                     request completes, then allowed.
 *
 * All network is behind an injected fake backend (no real network, no timers).
 * The in-flight cases use a manually-resolved (deferred) backend so the test
 * controls exactly when each request settles.
 */

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

/** A manually-controllable promise so the test decides when a search settles. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush the microtask queue so awaited `.then` callbacks run before asserting. */
const flush = (): Promise<void> => Promise.resolve().then(() => undefined);

function candidate(id: string): TrackCandidate {
  return { videoId: id, title: `Title ${id}`, artist: `Artist ${id}`, durationSec: 200 };
}

const okResult = (candidates: TrackCandidate[]): SongSearchResult => ({
  ok: true,
  candidates,
});

// ---------------------------------------------------------------------------
// 1) NO-RESULTS state (Requirement 3.4)
// ---------------------------------------------------------------------------

describe('empty search results — no-results state (Requirement 3.4)', () => {
  it('raises noResults with empty candidates and a clean idle state after an empty search', async () => {
    const backend: SearchBackend = async () => okResult([]);
    const controller: SongPickerController = createSongPickerController({ backend });

    await controller.search('something with no matches');

    const state = controller.getState();
    // This is the state the view renders the "no results" message from.
    expect(state.noResults).toBe(true);
    expect(state.candidates).toEqual([]);
    // The request has completed: the picker is idle and ready for a new query.
    expect(state.isSearching).toBe(false);
    expect(state.lastError).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2) NON-EMPTY result clears noResults (Requirement 3.4)
// ---------------------------------------------------------------------------

describe('empty search results — non-empty clears the message (Requirement 3.4)', () => {
  it('leaves noResults false and surfaces the candidates when the search has matches', async () => {
    const items = [candidate('a'), candidate('b')];
    const backend: SearchBackend = async () => okResult(items);
    const controller = createSongPickerController({ backend });

    await controller.search('a real song');

    const state = controller.getState();
    expect(state.noResults).toBe(false);
    expect(state.candidates).toEqual(items);
    expect(state.isSearching).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3) noResults resets WHILE a new search is in flight (Requirement 3.4)
// ---------------------------------------------------------------------------

describe('empty search results — message clears during a pending re-query (Requirement 3.4)', () => {
  it('clears noResults while the next search is in flight, then reflects the new result', async () => {
    // First backend resolves immediately to [] so the first search yields noResults.
    // Second backend is deferred so we can inspect the in-flight state.
    const second = deferred<SongSearchResult>();
    let call = 0;
    const backend: SearchBackend = (_query) => {
      call += 1;
      if (call === 1) return Promise.resolve(okResult([]));
      return second.promise;
    };
    const controller = createSongPickerController({ backend });

    // First search → noResults true.
    await controller.search('no matches');
    expect(controller.getState().noResults).toBe(true);

    // Start the second search; it is now in flight (deferred, not yet settled).
    const secondSearch = controller.search('trying again');
    const inFlight = controller.getState();
    // While the re-query is pending the "no results" message is cleared so it
    // is not shown over a fresh, in-progress search.
    expect(inFlight.noResults).toBe(false);
    expect(inFlight.isSearching).toBe(true);

    // Resolve the second search to an empty result and let it settle.
    second.resolve(okResult([]));
    await secondSearch;
    await flush();

    const settled = controller.getState();
    expect(settled.isSearching).toBe(false);
    // noResults now reflects the SECOND result (also empty here).
    expect(settled.noResults).toBe(true);
    expect(settled.candidates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4) POST-COMPLETION re-query gating (Requirement 3.4)
// ---------------------------------------------------------------------------

describe('empty search results — new query allowed only after completion (Requirement 3.4)', () => {
  it('blocks a second query while one is in flight and allows it once the request completes', async () => {
    const first = deferred<SongSearchResult>();
    let callCount = 0;
    const queries: string[] = [];
    const backend: SearchBackend = (query) => {
      callCount += 1;
      queries.push(query);
      if (callCount === 1) return first.promise;
      return Promise.resolve(okResult([candidate('z')]));
    };
    const controller = createSongPickerController({ backend });

    // First search is now in flight; backend invoked exactly once.
    const firstSearch = controller.search('a');
    expect(callCount).toBe(1);
    expect(controller.getState().isSearching).toBe(true);

    // Attempt a new query WHILE the first is pending: it must be blocked.
    const blocked = controller.search('b');
    // Backend was NOT called a second time (re-query blocked until completion).
    expect(callCount).toBe(1);
    // The blocked call returns the SAME in-flight promise rather than starting one.
    expect(blocked).toBe(firstSearch);

    // Complete the first request.
    first.resolve(okResult([]));
    await firstSearch;
    await flush();
    expect(controller.getState().isSearching).toBe(false);

    // Now a new query IS allowed (re-query permitted only after completion).
    await controller.search('b');
    expect(callCount).toBe(2);
    // Call count progression: 1 → (still 1 while blocked) → 2 after completion.
    expect(queries).toEqual(['a', 'b']);

    const state = controller.getState();
    expect(state.isSearching).toBe(false);
    expect(state.noResults).toBe(false);
    expect(state.candidates).toEqual([candidate('z')]);
  });
});
