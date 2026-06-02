import { describe, it, expect } from 'vitest';
import { shouldPredictGrab, visibleLocksFromSnapshot } from './predictGrab.ts';
import type { LockSnapshot, PlayerId } from '@glitch/core';

/**
 * Unit tests for the pure grab prediction decision (task 17.3, Requirements 8.5,
 * 8.6). These pin the iff that the optional Property 23 (task 17.4) will cover
 * exhaustively: predict iff the target is not visibly locked by ANOTHER player.
 */

const SELF: PlayerId = 'me';
const OTHER: PlayerId = 'other';

function locks(...entries: LockSnapshot[]): Map<string, PlayerId> {
  return visibleLocksFromSnapshot(entries);
}

describe('shouldPredictGrab (task 17.3)', () => {
  it('predicts a grab on an unlocked letter (8.5)', () => {
    expect(shouldPredictGrab(locks(), 'L:0', SELF)).toBe(true);
  });

  it('predicts a re-grab of a letter this player already owns', () => {
    expect(shouldPredictGrab(locks({ letterId: 'L:0', ownerId: SELF }), 'L:0', SELF)).toBe(true);
  });

  it('skips prediction on a letter visibly locked by another player (8.6)', () => {
    expect(shouldPredictGrab(locks({ letterId: 'L:0', ownerId: OTHER }), 'L:0', SELF)).toBe(false);
  });

  it('predicts a grab on a different letter while another is locked by someone else', () => {
    const v = locks({ letterId: 'L:0', ownerId: OTHER });
    expect(shouldPredictGrab(v, 'L:1', SELF)).toBe(true);
  });

  it('is total and side-effect free (does not mutate the lock map)', () => {
    const v = locks({ letterId: 'L:0', ownerId: OTHER });
    const before = v.size;
    shouldPredictGrab(v, 'L:0', SELF);
    shouldPredictGrab(v, 'L:9', SELF);
    expect(v.size).toBe(before);
  });
});

describe('visibleLocksFromSnapshot (task 17.3)', () => {
  it('maps only locked letters to their owners', () => {
    const v = visibleLocksFromSnapshot([
      { letterId: 'L:0', ownerId: 'p1' },
      { letterId: 'L:2', ownerId: 'p2' },
    ]);
    expect(v.get('L:0')).toBe('p1');
    expect(v.get('L:2')).toBe('p2');
    expect(v.has('L:1')).toBe(false);
  });
});
