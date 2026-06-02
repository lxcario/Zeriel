import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  offGridOffset,
  letterVariation,
  MAX_LETTER_ROTATION_RAD,
  MAX_LETTER_VARIATION_PX,
} from './Renderer.ts';

/**
 * Property-based test for bounded off-grid offsets (task 9.2).
 *
 * Property 34: Off-grid offsets are bounded.
 * **Validates: Requirements 12.3**
 *
 * Design ("Correctness Properties" / Property 34): *For any* seed, the off-grid
 * placement offset has magnitude no greater than the configured maximum on each
 * axis. Requirement 12.3: the Renderer SHALL apply off-grid placement so that UI
 * and play elements deviate from strict alignment by a BOUNDED random offset.
 *
 * ---------------------------------------------------------------------------
 * What `offGridOffset(seed, maxPx)` guarantees (the contract under test)
 * ---------------------------------------------------------------------------
 * The pure helper in Renderer.ts is documented to:
 *   - bound each axis by the configured maximum: `|dx| <= |maxPx|` and
 *     `|dy| <= |maxPx|` for ANY seed (a clamp defends against float drift);
 *   - treat the bound as a MAGNITUDE: a negative `maxPx` is used as `|maxPx|`;
 *   - DEGRADE to `{ dx: 0, dy: 0 }` when `maxPx` is non-finite (NaN/±Infinity);
 *   - be DETERMINISTIC in `seed` so an element's off-grid placement is stable
 *     frame to frame (12.3 is a FIXED deviation from alignment, not per-frame
 *     jitter — that decorative jitter lives elsewhere and is gated by
 *     reduce-motion, Property 35).
 *
 * Each strand below pins exactly one of those guarantees. The companion
 * Renderer.test.ts pins concrete examples; this file proves the invariants hold
 * across the input space. numRuns is left at the global default (100).
 *
 * Note on the |dx| <= maxPx assertion: because the bound is enforced with a
 * clamp to [-m, m], the inequality is NON-STRICT (the boundary value m is an
 * allowed result), so we assert `<=` rather than `<`.
 */

// --- Generators -------------------------------------------------------------

/**
 * Arbitrary 32-bit-ish seed. `fc.integer()` already spans negatives, 0, and
 * large positives; we additionally fold in explicit edge seeds (0, ±1, the
 * 2^31 sign boundary, and the full unsigned-32 max 2^32 - 1) so the shrinker
 * and the run both exercise the corners the hash mixes through `>>> 0`.
 */
const seedArb = fc.oneof(
  fc.integer(),
  fc.integer({ min: 0, max: 0xffffffff }), // full unsigned-32 range (up to 2^32 - 1)
  fc.constantFrom(0, 1, -1, 2 ** 31, -(2 ** 31), 0xffffffff),
);

/** Finite, NON-NEGATIVE maximum offset in px (the normal configured range). */
const finiteNonNegMaxArb = fc.double({
  min: 0,
  max: 1000,
  noNaN: true,
  noDefaultInfinity: true,
});

/**
 * Finite, NEGATIVE maximum. The implementation treats the bound as a magnitude
 * (`|maxPx|`), so the per-axis bound is `|maxPx|`. Upper bound is a tiny
 * negative so the strand stays strictly negative.
 */
const negativeMaxArb = fc.double({
  min: -1000,
  max: -1e-9,
  noNaN: true,
  noDefaultInfinity: true,
});

/** Non-finite maxima — each must degrade the offset to exactly {0,0}. */
const nonFiniteMaxArb = fc.constantFrom(
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
);

// --- Property 34 ------------------------------------------------------------

describe('Property 34: Off-grid offsets are bounded', () => {
  it('bounds each axis by maxPx for finite, non-negative maxPx (core invariant, Req 12.3)', () => {
    fc.assert(
      fc.property(seedArb, finiteNonNegMaxArb, (seed, maxPx) => {
        const { dx, dy } = offGridOffset(seed, maxPx);
        // The configured maximum bounds each axis (non-strict: m is allowed).
        expect(Math.abs(dx)).toBeLessThanOrEqual(maxPx);
        expect(Math.abs(dy)).toBeLessThanOrEqual(maxPx);
        // ...and the result is always a pair of finite numbers (no NaN/Infinity).
        expect(Number.isFinite(dx)).toBe(true);
        expect(Number.isFinite(dy)).toBe(true);
      }),
    );
  });

  it('uses |maxPx| as the bound when maxPx is negative (the bound is on magnitude)', () => {
    fc.assert(
      fc.property(seedArb, negativeMaxArb, (seed, maxPx) => {
        const bound = Math.abs(maxPx);
        const { dx, dy } = offGridOffset(seed, maxPx);
        expect(Math.abs(dx)).toBeLessThanOrEqual(bound);
        expect(Math.abs(dy)).toBeLessThanOrEqual(bound);
        expect(Number.isFinite(dx)).toBe(true);
        expect(Number.isFinite(dy)).toBe(true);
      }),
    );
  });

  it('degrades to exactly {0,0} for non-finite maxPx (NaN/±Infinity)', () => {
    fc.assert(
      fc.property(seedArb, nonFiniteMaxArb, (seed, maxPx) => {
        expect(offGridOffset(seed, maxPx)).toEqual({ dx: 0, dy: 0 });
      }),
    );
  });

  it('is deterministic in (seed, maxPx) — stable across frames, not per-frame jitter', () => {
    // Cover the finite, negative, and non-finite maxPx domains in one strand so
    // determinism is proven everywhere the bound logic branches.
    const anyMaxArb = fc.oneof(finiteNonNegMaxArb, negativeMaxArb, nonFiniteMaxArb);
    fc.assert(
      fc.property(seedArb, anyMaxArb, (seed, maxPx) => {
        const first = offGridOffset(seed, maxPx);
        const second = offGridOffset(seed, maxPx);
        expect(second).toEqual(first);
      }),
    );
  });
});

// --- Secondary strand: per-letter ransom-note variation (same family, 12.1) -

/**
 * Secondary coverage of the sibling pure helper {@link letterVariation}
 * (Requirement 12.1 — per-letter rotation/placement variation). It is the same
 * family as the off-grid offset (deterministic, bounded per-element variation),
 * so we pin its bounds here too: rotation within ±MAX_LETTER_ROTATION_RAD and
 * each placement axis within ±MAX_LETTER_VARIATION_PX, plus determinism.
 */
describe('letterVariation bounds (Requirement 12.1, sibling helper)', () => {
  it('bounds rotation and per-axis placement variation and is deterministic', () => {
    fc.assert(
      fc.property(seedArb, (seed) => {
        const v = letterVariation(seed);
        expect(Math.abs(v.rotation)).toBeLessThanOrEqual(MAX_LETTER_ROTATION_RAD);
        expect(Math.abs(v.dx)).toBeLessThanOrEqual(MAX_LETTER_VARIATION_PX);
        expect(Math.abs(v.dy)).toBeLessThanOrEqual(MAX_LETTER_VARIATION_PX);
        expect(Number.isFinite(v.rotation)).toBe(true);
        // Deterministic in the seed (frame-stable look).
        expect(letterVariation(seed)).toEqual(v);
      }),
    );
  });
});
