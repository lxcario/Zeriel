import { describe, it, expect } from 'vitest';
import type { RoundState } from '@glitch/core';
import { shouldSendJoinSnapshot } from './joinInProgress.js';

/**
 * Unit test for the pure join-in-progress decision (task 16.9, Requirement
 * 16.3): a client joining a Round in progress (and only then) is sent a full
 * authoritative snapshot to mirror existing Players.
 */
describe('shouldSendJoinSnapshot (task 16.9)', () => {
  it('sends a snapshot only while a Round is playing', () => {
    expect(shouldSendJoinSnapshot('playing')).toBe(true);
  });

  it('does not send a physics snapshot in any non-playing state', () => {
    const nonPlaying: RoundState[] = [
      'lobby',
      'resolving',
      'ready',
      'resolve_failed',
      'scoring',
    ];
    for (const state of nonPlaying) {
      expect(shouldSendJoinSnapshot(state)).toBe(false);
    }
  });
});
