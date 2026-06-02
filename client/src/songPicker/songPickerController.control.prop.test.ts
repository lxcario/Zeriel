import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  canControl,
  createSongPickerController,
  type ModeContext,
} from './songPickerController.ts';
import type { SearchBackend } from './searchBackend.ts';

/**
 * Property-based test for Song_Picker control authorization (task 10.5).
 *
 * Property 10: Song-picker control authorization.
 * **Validates: Requirements 3.6**
 *
 * Design ("Correctness Properties" / Property 10): *For any* mode context, the
 * picker grants search/selection control if and only if the context is
 * Single_Player_Mode or the requesting Player is the Host.
 *
 * Requirement 3.6: "WHERE the Glitch is running in Single_Player_Mode, THE
 * Song_Picker SHALL allow the single Player to search for and select a track;
 * WHERE the Glitch is running in multiplayer, THE Song_Picker SHALL restrict
 * search and selection to the Host."
 *
 * The full truth table this property asserts across the entire input space:
 *   - mode 'single' ⇒ true ALWAYS (the single Player controls, regardless of
 *     whether the optional `isHost` flag is absent, true, or false).
 *   - mode 'multi'  ⇒ result === ctx.isHost (true iff the viewer is the Host).
 *
 * `numRuns` is left at the global default (100; see vitest.setup.ts). No
 * mocking: `canControl` is a pure total function, and the controller method is
 * exercised against a trivial real backend so the method/function agreement is
 * verified end-to-end.
 */

// --- Generators -------------------------------------------------------------

/**
 * Single-mode contexts in BOTH shapes the type allows:
 *   - `{ mode: 'single' }`                         (isHost absent)
 *   - `{ mode: 'single', isHost: <arbitrary> }`    (isHost present, true|false)
 *
 * `fc.option(boolean, { nil: undefined })` yields `undefined | true | false`;
 * an `undefined` value is mapped to the no-`isHost` shape so the optional
 * property is genuinely ABSENT (not set to `undefined`), exercising both forms.
 */
const singleContextArb: fc.Arbitrary<ModeContext> = fc
  .option(fc.boolean(), { nil: undefined })
  .map((isHost): ModeContext =>
    isHost === undefined ? { mode: 'single' } : { mode: 'single', isHost },
  );

/** Multi-mode contexts with an arbitrary `isHost` flag (true or false). */
const multiContextArb: fc.Arbitrary<ModeContext> = fc
  .boolean()
  .map((isHost): ModeContext => ({ mode: 'multi', isHost }));

/** Cover both mode shapes uniformly across the input space. */
const modeContextArb: fc.Arbitrary<ModeContext> = fc.oneof(
  singleContextArb,
  multiContextArb,
);

/**
 * A trivial, deterministic backend used only to construct a real controller.
 * It never runs during this property (control authorization does no search),
 * so it simply reports an empty, successful result. No network, no mocking
 * framework.
 */
const trivialBackend: SearchBackend = async () => ({ ok: true, candidates: [] });

// --- Property 10 ------------------------------------------------------------

describe('Property 10: Song-picker control authorization', () => {
  it('grants control iff single mode (always) or the multi-mode viewer is the Host', () => {
    fc.assert(
      fc.property(modeContextArb, (ctx) => {
        const result = canControl(ctx);

        // The complete expected truth table (Requirement 3.6 / Property 10).
        const expected = ctx.mode === 'single' ? true : ctx.isHost === true;
        expect(result).toBe(expected);

        if (ctx.mode === 'single') {
          // Single_Player_Mode: the single Player ALWAYS controls, regardless
          // of the (irrelevant, optional) isHost flag.
          expect(result).toBe(true);
        } else {
          // Multiplayer: control is granted iff the viewer is the Host.
          expect(result).toBe(ctx.isHost);
        }

        // The controller METHOD must agree with the standalone pure function
        // for the very same context (construct a controller per case with a
        // trivial real backend — no mocks).
        const controller = createSongPickerController({ backend: trivialBackend });
        expect(controller.canControl(ctx)).toBe(result);
      }),
    );
  });
});
