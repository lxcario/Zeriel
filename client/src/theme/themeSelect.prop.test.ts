import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { RoundState } from '@glitch/core';
import { selectTheme, type Surface, type Theme } from './themeSelect.ts';

/**
 * Property-based test for art-direction theme separation (task 8.3).
 *
 * Property 42: Theme separation between premium and gameplay surfaces.
 * Validates: Requirements 18.3, 18.4.
 *
 * Design ("Correctness Properties" / Property 42): *For any* surface and Round
 * state, the theme selector returns the handmade gameplay theme for the in-round
 * play area while playing and never returns the Premium_Entry_Surface theme for
 * the play area.
 *
 * Requirement 18.3: SHALL NOT apply the Premium_Entry_Surface art direction to
 * the in-round gameplay play area.
 * Requirement 18.4: WHILE a Round is in the playing state, the gameplay play
 * area uses the handmade aesthetic, not the Premium_Entry_Surface art direction.
 *
 * Strategy: generate ARBITRARY `Surface` values (every literal) and ARBITRARY
 * `RoundState` values (every literal plus the `undefined` case, via
 * `fc.option`), then assert the load-bearing separation invariants hold across
 * the whole input space. The existing `themeSelect.test.ts` pins concrete
 * examples; this file proves the cross-cutting guarantees for all inputs.
 * numRuns is left at the global default (100, from vitest.setup.ts).
 */

// --- Generators (constrained to the exact type input spaces) ---------------

/** Every `Surface` literal (design.md "Overview", Requirement 18.1). */
const surfaceArb: fc.Arbitrary<Surface> = fc.constantFrom<Surface>(
  'landing',
  'lobby',
  'song_picker',
  'gameplay',
);

/** Every non-gameplay Premium_Entry_Surface literal (Requirement 18.1). */
const premiumSurfaceArb: fc.Arbitrary<Exclude<Surface, 'gameplay'>> =
  fc.constantFrom<Exclude<Surface, 'gameplay'>>('landing', 'lobby', 'song_picker');

/** Every `RoundState` literal (core identity.ts). */
const roundStateArb: fc.Arbitrary<RoundState> = fc.constantFrom<RoundState>(
  'lobby',
  'resolving',
  'ready',
  'playing',
  'scoring',
  'resolve_failed',
);

/**
 * A Round state OR the `undefined` case (the optional `roundState` parameter).
 * `fc.option(..., { nil: undefined })` yields both the literals and `undefined`.
 */
const maybeRoundStateArb: fc.Arbitrary<RoundState | undefined> = fc.option(
  roundStateArb,
  { nil: undefined },
);

const GAMEPLAY_THEME: Theme = 'gameplay';
const PREMIUM_THEME: Theme = 'premium';

// --- Property 42 -----------------------------------------------------------

describe('Property 42: Theme separation between premium and gameplay surfaces', () => {
  it('gameplay surface is ALWAYS the handmade gameplay theme and NEVER premium, for every round state and undefined (18.3, 18.4)', () => {
    fc.assert(
      fc.property(maybeRoundStateArb, (state) => {
        const theme = selectTheme('gameplay', state);
        expect(theme).toBe(GAMEPLAY_THEME);
        expect(theme).not.toBe(PREMIUM_THEME);
      }),
    );
  });

  it('every non-gameplay premium surface is ALWAYS the premium theme (never bleeds the gameplay theme), for every round state and undefined (18.3)', () => {
    fc.assert(
      fc.property(premiumSurfaceArb, maybeRoundStateArb, (surface, state) => {
        const theme = selectTheme(surface, state);
        expect(theme).toBe(PREMIUM_THEME);
        expect(theme).not.toBe(GAMEPLAY_THEME);
      }),
    );
  });

  it('separation: the gameplay surface and any premium surface never share a theme, for every round state and undefined (18.3, 18.4)', () => {
    fc.assert(
      fc.property(
        premiumSurfaceArb,
        maybeRoundStateArb,
        maybeRoundStateArb,
        (premiumSurface, gameplayState, premiumState) => {
          const gameplayTheme = selectTheme('gameplay', gameplayState);
          const premiumTheme = selectTheme(premiumSurface, premiumState);
          expect(gameplayTheme).not.toBe(premiumTheme);
        },
      ),
    );
  });

  it('classification is total: every surface resolves to exactly one of the two themes, for every round state and undefined', () => {
    fc.assert(
      fc.property(surfaceArb, maybeRoundStateArb, (surface, state) => {
        const theme = selectTheme(surface, state);
        // The play area is the only surface assigned the gameplay theme; all
        // others are premium (Requirement 18.1 vs 18.3/18.4).
        const expected: Theme = surface === 'gameplay' ? GAMEPLAY_THEME : PREMIUM_THEME;
        expect(theme).toBe(expected);
      }),
    );
  });
});
