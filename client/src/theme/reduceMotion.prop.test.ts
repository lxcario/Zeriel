import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { resolveReduceMotion } from './reduceMotion.ts';

/**
 * Property-based test for the pure Reduce_Motion_Mode resolution core (task 8.2).
 *
 * Property 36: Explicit reduce-motion choice takes precedence.
 * Validates: Requirements 13.3.
 *
 * Design ("Correctness Properties" / Property 36): *For any* combination of a
 * stored explicit Reduce_Motion_Mode choice and a browser
 * prefers-reduced-motion setting, the effective mode equals the stored explicit
 * choice when one exists, and otherwise equals the browser setting.
 *
 * Strategy: model the stored explicit choice as `fc.option(fc.boolean(), { nil:
 * null })` so the generator covers the explicit `true`/`false` cases AND the
 * "no explicit choice" (`null`, e.g. first visit) case, and model the browser
 * `prefers-reduced-motion` setting as an arbitrary `fc.boolean()`. Two universal
 * invariants are asserted across the whole input space:
 *
 * - An explicit choice ALWAYS wins, regardless of the browser setting
 *   (Requirement 13.3) — a persisted choice is respected on subsequent visits
 *   rather than being overridden by the browser.
 * - With no explicit choice, the effective mode falls back to the browser
 *   setting (Requirement 13.2, the first-visit default).
 *
 * The existing `reduceMotion.test.ts` pins the concrete per-branch examples;
 * this file proves the cross-cutting precedence guarantee holds for all inputs.
 * numRuns is left at the global default (100, from vitest.setup.ts).
 */
describe('resolveReduceMotion (Property 36: explicit choice takes precedence)', () => {
  it('returns the explicit choice for every boolean explicit/browser combination (13.3)', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (explicitChoice, prefersReducedMotion) => {
        // An explicit choice always wins, regardless of the browser setting.
        expect(resolveReduceMotion(explicitChoice, prefersReducedMotion)).toBe(
          explicitChoice,
        );
      }),
    );
  });

  it('falls back to the browser setting when there is no explicit choice (13.2)', () => {
    fc.assert(
      fc.property(fc.boolean(), (prefersReducedMotion) => {
        // null (e.g. first visit) defers to the browser prefers-reduced-motion.
        expect(resolveReduceMotion(null, prefersReducedMotion)).toBe(
          prefersReducedMotion,
        );
      }),
    );
  });

  it('upholds the full precedence rule over the whole input space (13.2, 13.3)', () => {
    const explicitChoiceArb = fc.option(fc.boolean(), { nil: null });
    const prefersReducedMotionArb = fc.boolean();
    fc.assert(
      fc.property(
        explicitChoiceArb,
        prefersReducedMotionArb,
        (explicitChoice, prefersReducedMotion) => {
          const expected =
            explicitChoice !== null ? explicitChoice : prefersReducedMotion;
          expect(resolveReduceMotion(explicitChoice, prefersReducedMotion)).toBe(
            expected,
          );
        },
      ),
    );
  });
});
