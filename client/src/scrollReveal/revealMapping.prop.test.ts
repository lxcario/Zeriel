import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { ScrollRevealConfig } from '@glitch/core';
import {
  opacityAt,
  blurAt,
  rotationAt,
  styleAt,
  revealedStyleAt,
  FULL_OPACITY,
  NO_BLUR_PX,
  NO_ROTATION_DEG,
} from './revealMapping.ts';

/**
 * Property-based test for the pure scroll-progress → style mapping (task 11.3).
 *
 * Property 44: Scroll-progress mapping is monotonic and honors configured endpoints.
 * **Validates: Requirements 19.2, 19.5**
 *
 * Design ("Correctness Properties" / Property 44): *For any* scroll progress
 * value in [0,1] and any reveal configuration, the computed opacity, blur, and
 * rotation vary monotonically with progress and equal the configured base
 * values at progress 0 and the fully-revealed values (full opacity, zero blur,
 * zero rotation) at progress 1.
 *
 * The functions under test are pure linear interpolations of the clamped
 * progress `t = clampProgress(p)` (confirmed by reading `revealMapping.ts`):
 *
 *   opacityAt(p, b)        = b + (1 - b) * t       (b at t=0, 1 at t=1)
 *   blurAt(p, s, true)     = s * (1 - t)           (s at t=0, 0 at t=1)
 *   blurAt(p, s, false)    = 0                      (always, any p)
 *   rotationAt(p, r)       = r * (1 - t)           (r at t=0, 0 at t=1)
 *
 * Confirmed clamping / non-finite behavior of `clampProgress`:
 *   - non-finite p (NaN, ±Infinity) → 0   (the un-revealed BASE state)
 *   - p < 0                          → 0   (base)
 *   - p > 1 (finite)                 → 1   (fully revealed)
 * Note the asymmetry: a finite p > 1 reveals (t=1), but +Infinity is non-finite
 * and therefore maps to the BASE state (t=0), not the revealed state.
 *
 * Float epsilon: each mapping is a single subtraction, a multiply, and (for
 * opacity) an addition over operands bounded by ~90 (rotation), 40 (blur), and
 * 1 (opacity). The accumulated rounding error is on the order of a few ULPs
 * (~1e-14 absolute at these magnitudes), so EPS = 1e-9 is a comfortably tight
 * tolerance — used only for the `opacityAt(1, b) ≈ 1` endpoint and to guard the
 * monotonicity inequalities against equality/rounding ties. Endpoints that are
 * exact under IEEE-754 (e.g. multiply-by-zero, multiply-by-one, add-zero) are
 * asserted with strict equality.
 *
 * numRuns is left at the global default (100, from vitest.setup.ts).
 */

/** Float tolerance justified by the linear single-step arithmetic above. */
const EPS = 1e-9;

/**
 * Sign-agnostic zero check. `rotationAt(1, r) = r * (1 - 1) = r * 0` evaluates
 * to `-0` under IEEE-754 whenever `r` is negative (or `-0`). `-0` is
 * numerically equal to `0` (`-0 === 0`), so the rotation endpoint IS reached;
 * only `Object.is`/`toBe` would spuriously distinguish the sign. The reveal
 * contract (Requirement 19.2) is "rotation falls to zero", which `-0`
 * satisfies, so endpoint assertions for zero use this helper.
 */
const isZero = (x: number): boolean => x === 0;

/** Scroll progress within the in-domain range [0, 1]. */
const inRangeArb = fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });

/** Strictly-below-range progress (< 0): must clamp to the p=0 / base endpoints. */
const belowRangeArb = fc.double({
  min: -1000,
  max: -1e-6,
  noNaN: true,
  noDefaultInfinity: true,
});

/** Strictly-above-range progress (> 1): must clamp to the p=1 / revealed endpoints. */
const aboveRangeArb = fc.double({
  min: 1 + 1e-6,
  max: 1_000_000,
  noNaN: true,
  noDefaultInfinity: true,
});

/** Non-finite progress: treated as 0 (base state) per clampProgress. */
const nonFiniteArb = fc.constantFrom(
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
);

/** An ordered pair (p1 <= p2) of in-range progress values for monotonicity. */
const orderedPairArb = fc
  .tuple(inRangeArb, inRangeArb)
  .map(([a, b]): [number, number] => (a <= b ? [a, b] : [b, a]));

const baseOpacityArb = fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });
const baseRotationArb = fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true });
const blurStrengthArb = fc.double({ min: 0, max: 40, noNaN: true, noDefaultInfinity: true });

/**
 * Full reveal configuration (Requirement 19.5). `scrollStart`/`scrollEnd` are
 * GSAP ScrollTrigger strings exposed as config but irrelevant to the pure
 * numeric mapping, so they are held constant here.
 */
const configArb: fc.Arbitrary<ScrollRevealConfig> = fc.record({
  enableBlur: fc.boolean(),
  baseOpacity: baseOpacityArb,
  baseRotation: baseRotationArb,
  blurStrength: blurStrengthArb,
  scrollStart: fc.constant('top bottom'),
  scrollEnd: fc.constant('bottom top'),
});

describe('revealMapping (Property 44: monotonic mapping honoring configured endpoints)', () => {
  it('hits the configured base/revealed endpoints at p=0 and p=1 (19.2, 19.5)', () => {
    fc.assert(
      fc.property(baseOpacityArb, baseRotationArb, blurStrengthArb, (b, r, s) => {
        // p = 0 ⇒ exactly the configured base values (exact under IEEE-754:
        // (1-b)*0 = 0, s*(1-0) = s, r*(1-0) = r).
        expect(opacityAt(0, b)).toBe(b);
        expect(blurAt(0, s, true)).toBe(s);
        expect(rotationAt(0, r)).toBe(r);

        // p = 1 ⇒ exactly the fully-revealed values; opacity needs EPS because
        // it is b + (1-b) which can round off 1 by a few ULPs.
        expect(opacityAt(1, b)).toBeCloseTo(FULL_OPACITY, 9);
        expect(Math.abs(opacityAt(1, b) - FULL_OPACITY)).toBeLessThanOrEqual(EPS);
        expect(blurAt(1, s, true)).toBe(NO_BLUR_PX);
        // rotationAt(1, r) = r * 0 ⇒ ±0; numerically zero (sign-agnostic).
        expect(isZero(rotationAt(1, r))).toBe(true);
      }),
    );
  });

  it('is monotonic in progress: opacity ↑, blur ↓, |rotation| → 0 (19.2)', () => {
    fc.assert(
      fc.property(orderedPairArb, configArb, ([p1, p2], cfg) => {
        const { baseOpacity: b, baseRotation: r, blurStrength: s, enableBlur } = cfg;

        // Opacity is non-decreasing as progress increases (rises toward 1).
        expect(opacityAt(p1, b)).toBeLessThanOrEqual(opacityAt(p2, b) + EPS);

        // Blur is non-increasing as progress increases (falls toward 0).
        expect(blurAt(p1, s, enableBlur)).toBeGreaterThanOrEqual(
          blurAt(p2, s, enableBlur) - EPS,
        );

        // Rotation is a linear interpolation toward 0: as progress increases,
        // rotationAt(p2) lies between 0 and rotationAt(p1) (sign preserved,
        // magnitude non-increasing).
        const rot1 = rotationAt(p1, r);
        const rot2 = rotationAt(p2, r);
        const lo = Math.min(0, rot1);
        const hi = Math.max(0, rot1);
        expect(rot2).toBeGreaterThanOrEqual(lo - EPS);
        expect(rot2).toBeLessThanOrEqual(hi + EPS);
        // Equivalent magnitude statement: rotation never moves away from 0.
        expect(Math.abs(rot2)).toBeLessThanOrEqual(Math.abs(rot1) + EPS);
      }),
    );
  });

  it('clamps progress < 0 to the p=0 / base endpoints (19.2)', () => {
    fc.assert(
      fc.property(belowRangeArb, baseOpacityArb, baseRotationArb, blurStrengthArb, (p, b, r, s) => {
        expect(opacityAt(p, b)).toBe(opacityAt(0, b));
        expect(opacityAt(p, b)).toBe(b);
        expect(blurAt(p, s, true)).toBe(blurAt(0, s, true));
        expect(blurAt(p, s, true)).toBe(s);
        expect(rotationAt(p, r)).toBe(rotationAt(0, r));
        expect(rotationAt(p, r)).toBe(r);
      }),
    );
  });

  it('clamps progress > 1 to the p=1 / revealed endpoints (19.2)', () => {
    fc.assert(
      fc.property(aboveRangeArb, baseOpacityArb, baseRotationArb, blurStrengthArb, (p, b, r, s) => {
        // Identical computation to p=1 (t clamps to 1) ⇒ exact equality.
        expect(opacityAt(p, b)).toBe(opacityAt(1, b));
        expect(Math.abs(opacityAt(p, b) - FULL_OPACITY)).toBeLessThanOrEqual(EPS);
        expect(blurAt(p, s, true)).toBe(NO_BLUR_PX);
        // rotationAt clamps to t=1 ⇒ r * 0 ⇒ ±0; numerically zero.
        expect(isZero(rotationAt(p, r))).toBe(true);
      }),
    );
  });

  it('treats non-finite progress as 0 / the base endpoints', () => {
    fc.assert(
      fc.property(nonFiniteArb, baseOpacityArb, baseRotationArb, blurStrengthArb, (p, b, r, s) => {
        // NaN / ±Infinity all collapse to the un-revealed base state (t = 0).
        expect(opacityAt(p, b)).toBe(b);
        expect(blurAt(p, s, true)).toBe(s);
        expect(rotationAt(p, r)).toBe(r);
      }),
    );
  });

  it('produces zero blur for any progress when enableBlur is false (19.5)', () => {
    const anyProgressArb = fc.oneof(inRangeArb, belowRangeArb, aboveRangeArb, nonFiniteArb);
    fc.assert(
      fc.property(anyProgressArb, blurStrengthArb, (p, s) => {
        expect(blurAt(p, s, false)).toBe(NO_BLUR_PX);
      }),
    );
  });

  it('revealedStyleAt() is the fully-revealed target (full opacity, no blur, no rotation) (19.6 endpoint)', () => {
    expect(revealedStyleAt()).toEqual({
      opacity: FULL_OPACITY,
      blurPx: NO_BLUR_PX,
      rotationDeg: NO_ROTATION_DEG,
    });
  });

  it('styleAt composes opacityAt/blurAt/rotationAt consistently (19.5)', () => {
    const anyProgressArb = fc.oneof(inRangeArb, belowRangeArb, aboveRangeArb, nonFiniteArb);
    fc.assert(
      fc.property(anyProgressArb, configArb, (p, cfg) => {
        const style = styleAt(p, cfg);
        expect(style.opacity).toBe(opacityAt(p, cfg.baseOpacity));
        expect(style.blurPx).toBe(blurAt(p, cfg.blurStrength, cfg.enableBlur));
        expect(style.rotationDeg).toBe(rotationAt(p, cfg.baseRotation));
      }),
    );
  });
});
