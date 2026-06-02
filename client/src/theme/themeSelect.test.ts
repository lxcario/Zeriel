import { describe, it, expect } from 'vitest';
import type { RoundState } from '@glitch/core';
import { selectTheme, type Surface } from './themeSelect.ts';

const ALL_ROUND_STATES: RoundState[] = [
  'lobby',
  'resolving',
  'ready',
  'playing',
  'scoring',
  'resolve_failed',
];

const PREMIUM_SURFACES: Surface[] = ['landing', 'lobby', 'song_picker'];

describe('selectTheme', () => {
  it('returns the gameplay theme for the in-round play area (18.4)', () => {
    expect(selectTheme('gameplay', 'playing')).toBe('gameplay');
  });

  it('never returns the premium theme for the gameplay play area, regardless of round state (18.3, 18.4)', () => {
    for (const state of ALL_ROUND_STATES) {
      expect(selectTheme('gameplay', state)).toBe('gameplay');
    }
    // Also when no round state is provided.
    expect(selectTheme('gameplay')).toBe('gameplay');
  });

  it('returns the premium theme for the non-gameplay entry surfaces (18.1)', () => {
    for (const surface of PREMIUM_SURFACES) {
      expect(selectTheme(surface)).toBe('premium');
    }
  });

  it('keeps premium surfaces premium across every round state', () => {
    for (const surface of PREMIUM_SURFACES) {
      for (const state of ALL_ROUND_STATES) {
        expect(selectTheme(surface, state)).toBe('premium');
      }
    }
  });
});
