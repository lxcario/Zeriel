import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { TrackCandidate } from '@glitch/core';
import {
  createSongPickerController,
  type SongPickerState,
} from './songPickerController.ts';
import type { SongSearchResult } from './searchBackend.ts';

/**
 * Property-based test for pending-track selection (task 10.3).
 *
 * Property 8: Selection records the pending track.
 * Validates: Requirements 3.2.
 *
 * Design ("Correctness Properties" / Property 8): *For any* track candidate,
 * selecting it records exactly that candidate as the pending track for the next
 * Round.
 *
 * Requirement 3.2: selecting a candidate records it as the pending track.
 *
 * Strategy: generate ARBITRARY `TrackCandidate` values (non-empty `videoId`,
 * arbitrary `title`/`artist` strings, arbitrary non-negative `durationSec`) and
 * assert that after `select(c)` the controller's `pendingTrack` and
 * `getState().pendingTrack` are exactly `c` (same reference). A second strand
 * generates a NON-EMPTY SEQUENCE of candidates and asserts last-write-wins:
 * after each `select()` the pending track is the most recently selected
 * candidate, and after the whole sequence it equals the final candidate.
 *
 * Selection is independent of search, so the backend is a trivial stub that
 * returns no candidates and is never awaited here. We also assert selection
 * never flips `isSearching` (no search in flight) and never populates
 * `candidates`. numRuns is left at the global default (100, from
 * vitest.setup.ts).
 */

// --- Generators (constrained to the TrackCandidate input space) ------------

/**
 * An arbitrary `TrackCandidate`:
 * - `videoId`: non-empty string (search would never surface a candidate
 *   without a usable id; see `mapPipedSearchResponse`).
 * - `title` / `artist`: arbitrary strings (selection records whatever was
 *   chosen; it does not re-validate the candidate).
 * - `durationSec`: arbitrary non-negative number.
 */
const trackCandidateArb: fc.Arbitrary<TrackCandidate> = fc.record({
  videoId: fc.string({ minLength: 1 }),
  title: fc.string(),
  artist: fc.string(),
  durationSec: fc.nat(),
});

/** A trivial backend: selection is independent of search, so it returns none. */
const idleBackend = async (): Promise<SongSearchResult> => ({
  ok: true,
  candidates: [],
});

// --- Property 8 ------------------------------------------------------------

describe('Property 8: Selection records the pending track', () => {
  it('records EXACTLY the selected candidate (same reference) on the getter and in state, for any candidate (3.2)', () => {
    fc.assert(
      fc.property(trackCandidateArb, (candidate) => {
        const controller = createSongPickerController({ backend: idleBackend });

        controller.select(candidate);

        // The getter returns exactly the selected candidate (same reference).
        expect(controller.pendingTrack).toBe(candidate);
        // The state snapshot mirrors the pending track (same reference).
        expect(controller.getState().pendingTrack).toBe(candidate);
      }),
    );
  });

  it('does not flip isSearching or populate candidates (selection is independent of search), for any candidate (3.2)', () => {
    fc.assert(
      fc.property(trackCandidateArb, (candidate) => {
        const controller = createSongPickerController({ backend: idleBackend });

        controller.select(candidate);

        expect(controller.isSearching).toBe(false);
        const state = controller.getState();
        expect(state.isSearching).toBe(false);
        expect(state.candidates).toEqual([]);
      }),
    );
  });

  it('is last-write-wins across a sequence: after each select the pending track is the most recent one (3.2)', () => {
    fc.assert(
      fc.property(
        fc.array(trackCandidateArb, { minLength: 1 }),
        (candidates) => {
          const controller = createSongPickerController({ backend: idleBackend });

          for (const candidate of candidates) {
            controller.select(candidate);
            // After each call, pending track is the just-selected candidate.
            expect(controller.pendingTrack).toBe(candidate);
            expect(controller.getState().pendingTrack).toBe(candidate);
          }

          // After the whole sequence, pending track equals the last candidate.
          const last = candidates[candidates.length - 1];
          expect(controller.pendingTrack).toBe(last);
          expect(controller.getState().pendingTrack).toBe(last);
        },
      ),
    );
  });

  it('notifies the onChange observer with a state whose pendingTrack equals the selected candidate, for any candidate (3.2)', () => {
    fc.assert(
      fc.property(trackCandidateArb, (candidate) => {
        let lastState: SongPickerState | null = null;
        const controller = createSongPickerController({
          backend: idleBackend,
          onChange: (state) => {
            lastState = state;
          },
        });

        controller.select(candidate);

        expect(lastState).not.toBeNull();
        // Narrow for the type checker; the assertion above guarantees non-null.
        expect((lastState as unknown as SongPickerState).pendingTrack).toBe(candidate);
      }),
    );
  });
});
