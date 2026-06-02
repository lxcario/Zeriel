import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { Particle, Rect } from '../types/index.js';
import { resolveBounds } from './index.js';

/**
 * Property-based test for play-area boundary containment (task 3.4).
 *
 * Property 19: Particles remain within play-area bounds.
 * Validates: Requirements 7.4.
 *
 * Design ("Correctness Properties" / Property 19): *For any* physics state and
 * any applied forces, after a tick every Rope_Letter particle position lies
 * within the play-area rectangle. Design ("Boundaries and stacking"): after
 * integration "particle positions are clamped to the play-area rectangle; a
 * particle that crosses a wall is reflected with restitution and its `prev`
 * adjusted so the implicit velocity damps rather than spikes." Requirement 7.4:
 * "WHILE Rope_Letters are in the play area, THE Physics_Engine SHALL constrain
 * Rope_Letter particles to remain within the play-area bounds."
 *
 * `resolveBounds` is the constraint step that enforces this: it clamps EVERY
 * particle's position into the rectangle (top-left origin: left = bounds.x,
 * right = bounds.x + width, top = bounds.y, bottom = bounds.y + height) and, for
 * non-fixed particles only, reflects the implicit velocity by adjusting `prev`.
 * The containment guarantee (Property 19) is therefore expected to hold for BOTH
 * fixed and free particles because position is clamped for all of them.
 *
 * ---------------------------------------------------------------------------
 * Generator design
 * ---------------------------------------------------------------------------
 * - **Bounds validity**: `x, y` range over [-1000, 1000]; `width, height` are
 *   strictly POSITIVE and bounded over [1, 2000]. A rectangle is only
 *   well-defined when width/height > 0 (otherwise left > right / top > bottom
 *   and "inside" is empty), so the generator never emits a degenerate rect.
 * - **Inside/outside straddling**: each particle's position is drawn from the
 *   bounds expanded by ±STRADDLE (500) on every side, i.e.
 *   [left - 500, right + 500] × [top - 500, bottom + 500]. This deliberately
 *   covers points far outside ALL four walls (and corners) as well as points
 *   strictly inside, so clamping is genuinely exercised on every edge.
 * - **Fixed / free mix**: `pinned` is an arbitrary boolean and `invMass` is
 *   drawn from {0, 1}. A particle is fixed when `pinned === true` OR
 *   `invMass === 0`, so the array mixes fixed (pinned / infinite-mass) and free
 *   particles. Both must end up in-bounds.
 * - `prev` positions are arbitrary but bounded ([-3000, 3000]); `restitution`
 *   ranges over the full valid [0, 1]. Array length is 0..30 (the empty array is
 *   a valid no-op case).
 *
 * ---------------------------------------------------------------------------
 * Assertions (with epsilon rationale)
 * ---------------------------------------------------------------------------
 * For EVERY particle after `resolveBounds`:
 *  1. `left - EPS <= p.x.x <= right + EPS` AND `top - EPS <= p.x.y <= bottom + EPS`
 *     — it lies within the rectangle (Requirement 7.4). Clamping sets the
 *     coordinate EXACTLY to the boundary value, so equality is exact; EPS (1e-9)
 *     is only a tiny guard against float representation of the boundary sums.
 *  2. No NaN / Infinity in `p.x` after resolution.
 * Secondary invariant: a particle that started STRICTLY inside the rectangle is
 * left unchanged (its position is byte-identical), since no wall was crossed.
 *
 * numRuns is left at the global default (100, from vitest.setup.ts). The
 * companion `bounds-collision.test.ts` pins the concrete reflection examples.
 */

// --- Generator regime --------------------------------------------------------

/** How far outside each wall particle positions may be generated. */
const STRADDLE = 500;
/** Bound for arbitrary `prev` coordinates (implicit-velocity source). */
const PREV_BOUND = 3000;
/** Float slack tolerating boundary-sum representation (clamp itself is exact). */
const EPS = 1e-9;

/** A valid play-area rectangle: positive (well-defined) width/height. */
const boundsArb: fc.Arbitrary<Rect> = fc.record({
  x: fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true }),
  y: fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true }),
  // width/height MUST be > 0 for a well-defined rectangle (left<right, top<bottom).
  width: fc.double({ min: 1, max: 2000, noNaN: true, noDefaultInfinity: true }),
  height: fc.double({ min: 1, max: 2000, noNaN: true, noDefaultInfinity: true }),
});

/** Per-particle generated spec (kept primitive so originals survive mutation). */
interface ParticleSpec {
  px: number;
  py: number;
  prevx: number;
  prevy: number;
  pinned: boolean;
  invMass: number;
}

/** A bounds rectangle plus a straddling particle cloud and a restitution. */
interface Scenario {
  bounds: Rect;
  specs: ParticleSpec[];
  restitution: number;
}

/**
 * Build a scenario whose particle positions straddle the (already-chosen)
 * bounds: drawn from the rectangle expanded by ±STRADDLE on every side so the
 * cloud spans deep-outside, on-edge, and strictly-inside regions.
 */
const scenarioArb: fc.Arbitrary<Scenario> = boundsArb.chain((bounds) => {
  const left = bounds.x;
  const right = bounds.x + bounds.width;
  const top = bounds.y;
  const bottom = bounds.y + bounds.height;

  const specArb: fc.Arbitrary<ParticleSpec> = fc.record({
    px: fc.double({ min: left - STRADDLE, max: right + STRADDLE, noNaN: true, noDefaultInfinity: true }),
    py: fc.double({ min: top - STRADDLE, max: bottom + STRADDLE, noNaN: true, noDefaultInfinity: true }),
    prevx: fc.double({ min: -PREV_BOUND, max: PREV_BOUND, noNaN: true, noDefaultInfinity: true }),
    prevy: fc.double({ min: -PREV_BOUND, max: PREV_BOUND, noNaN: true, noDefaultInfinity: true }),
    pinned: fc.boolean(),
    // {0, 1}: invMass 0 (with any pinned) yields fixed nodes; 1 yields free nodes.
    invMass: fc.constantFrom(0, 1),
  });

  return fc.record({
    bounds: fc.constant(bounds),
    specs: fc.array(specArb, { minLength: 0, maxLength: 30 }),
    restitution: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  });
});

/** Materialize a fresh, mutable Particle from its generated spec. */
function buildParticle(s: ParticleSpec): Particle {
  return {
    x: { x: s.px, y: s.py },
    prev: { x: s.prevx, y: s.prevy },
    pinned: s.pinned,
    invMass: s.invMass,
  };
}

/** True iff (px, py) lies strictly inside (open interior of) the rectangle. */
function strictlyInside(px: number, py: number, b: Rect): boolean {
  return px > b.x && px < b.x + b.width && py > b.y && py < b.y + b.height;
}

describe('Property 19: Particles remain within play-area bounds (Req 7.4)', () => {
  it('after resolveBounds, every particle (fixed or free) lies within the rectangle', () => {
    fc.assert(
      fc.property(scenarioArb, ({ bounds, specs, restitution }) => {
        const left = bounds.x;
        const right = bounds.x + bounds.width;
        const top = bounds.y;
        const bottom = bounds.y + bounds.height;

        const particles = specs.map(buildParticle);
        // Snapshot originals BEFORE mutation to check the strictly-inside subset.
        const originals = particles.map((p) => ({ x: p.x.x, y: p.x.y }));

        resolveBounds(particles, bounds, restitution);

        for (let i = 0; i < particles.length; i++) {
          const p = particles[i]!;

          // (1) Containment within the rectangle, for BOTH fixed and free nodes.
          expect(p.x.x).toBeGreaterThanOrEqual(left - EPS);
          expect(p.x.x).toBeLessThanOrEqual(right + EPS);
          expect(p.x.y).toBeGreaterThanOrEqual(top - EPS);
          expect(p.x.y).toBeLessThanOrEqual(bottom + EPS);

          // (2) No NaN / Infinity introduced by the resolution.
          expect(Number.isFinite(p.x.x)).toBe(true);
          expect(Number.isFinite(p.x.y)).toBe(true);

          // Secondary: a particle that began strictly inside is untouched.
          const o = originals[i]!;
          if (strictlyInside(o.x, o.y, bounds)) {
            expect(p.x.x).toBe(o.x);
            expect(p.x.y).toBe(o.y);
          }
        }
      }),
    );
  });
});
