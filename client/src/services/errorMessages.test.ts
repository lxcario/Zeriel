import { describe, it, expect } from 'vitest';
import {
  mapExternalError,
  type AudioResolveFailure,
  type LyricsFailure,
  type SearchFailure,
  type ExternalServiceFailure,
} from './errorMessages.ts';

/**
 * Unit tests for the external-error-to-message mapping (task 2.9).
 *
 * These verify the per-branch mapping and the cross-cutting invariants from
 * Requirements 17.1 (non-empty actionable message) and 17.5 (recoverable
 * errors expose a retry control). The optional Property 39 (task 2.10) covers
 * these invariants exhaustively with fast-check; here we pin the concrete
 * behavior of each branch.
 */

function hasAction(failure: ExternalServiceFailure, kind: string): boolean {
  return mapExternalError(failure).actions.some((a) => a.kind === kind);
}

describe('mapExternalError', () => {
  describe('audio all_instances_failed (Requirements 4.5, 17.5)', () => {
    const failure: AudioResolveFailure = {
      ok: false,
      reason: 'all_instances_failed',
      attempts: [
        { instance: 'https://piped.a', outcome: 'timeout' },
        { instance: 'https://piped.b', outcome: 'no_streams' },
      ],
    };

    it('produces a non-empty actionable message', () => {
      expect(mapExternalError(failure).message.length).toBeGreaterThan(0);
    });

    it('offers both a retry and a pick-different-track action and is recoverable', () => {
      const result = mapExternalError(failure);
      expect(result.recoverable).toBe(true);
      expect(hasAction(failure, 'retry')).toBe(true);
      expect(hasAction(failure, 'pick_different_track')).toBe(true);
    });
  });

  describe('lyrics no_lyrics (Requirements 6.4, 17.3)', () => {
    const failure: LyricsFailure = { ok: false, reason: 'no_lyrics' };

    it('produces a non-empty actionable message', () => {
      expect(mapExternalError(failure).message.length).toBeGreaterThan(0);
    });

    it('offers continue-lyrics-free and pick-different-track, with no retry', () => {
      expect(hasAction(failure, 'continue_lyrics_free')).toBe(true);
      expect(hasAction(failure, 'pick_different_track')).toBe(true);
      expect(hasAction(failure, 'retry')).toBe(false);
    });

    it('is not marked recoverable (a no-result, not a transport failure)', () => {
      expect(mapExternalError(failure).recoverable).toBe(false);
    });
  });

  describe('lyrics retrieval_failed (Requirement 6.5)', () => {
    const failure: LyricsFailure = { ok: false, reason: 'retrieval_failed' };

    it('produces a non-empty message and a retry action and is recoverable', () => {
      const result = mapExternalError(failure);
      expect(result.message.length).toBeGreaterThan(0);
      expect(result.recoverable).toBe(true);
      expect(hasAction(failure, 'retry')).toBe(true);
    });
  });

  describe('search failures (Requirements 17.1, 17.5)', () => {
    const reasons = ['timeout', 'network', 'http', 'parse'] as const;

    for (const reason of reasons) {
      it(`maps a ${reason} search failure to a recoverable retryable message`, () => {
        const failure: SearchFailure = { ok: false, reason };
        const result = mapExternalError(failure);
        expect(result.message.length).toBeGreaterThan(0);
        expect(result.recoverable).toBe(true);
        expect(result.actions.some((a) => a.kind === 'retry')).toBe(true);
      });
    }

    it('includes the HTTP status in the message when present', () => {
      const failure: SearchFailure = { ok: false, reason: 'http', status: 503 };
      expect(mapExternalError(failure).message).toContain('503');
    });
  });

  describe('cross-cutting invariants', () => {
    const allFailures: ExternalServiceFailure[] = [
      { ok: false, reason: 'all_instances_failed', attempts: [] },
      { ok: false, reason: 'no_lyrics' },
      { ok: false, reason: 'retrieval_failed' },
      { ok: false, reason: 'timeout' },
      { ok: false, reason: 'network' },
      { ok: false, reason: 'http', status: 500 },
      { ok: false, reason: 'parse' },
    ];

    it('every mapped result has a non-empty message (Requirement 17.1)', () => {
      for (const failure of allFailures) {
        expect(mapExternalError(failure).message.trim().length).toBeGreaterThan(0);
      }
    });

    it('every recoverable result includes a retry action (Requirement 17.5)', () => {
      for (const failure of allFailures) {
        const result = mapExternalError(failure);
        if (result.recoverable) {
          expect(result.actions.some((a) => a.kind === 'retry')).toBe(true);
        }
      }
    });

    it('every action has a non-empty label', () => {
      for (const failure of allFailures) {
        for (const action of mapExternalError(failure).actions) {
          expect(action.label.trim().length).toBeGreaterThan(0);
        }
      }
    });
  });
});
