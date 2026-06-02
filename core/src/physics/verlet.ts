/**
 * Pure Verlet integration and distance-constraint relaxation primitives.
 *
 * These functions are the foundation of the Physics_Engine (design.md
 * "Verlet Physics Model"). They operate in place on `Particle[]` / `Constraint[]`
 * arrays, are deterministic given their inputs, and allocate nothing inside
 * their loops — reusing module-level pre-allocated scratch vectors instead
 * (Requirement 14.3). The functions take an explicit `dt`, so they can be driven
 * by a fixed-timestep loop that is decoupled from the render frame rate
 * (Requirements 7.2, 14.2).
 *
 * Pure module: no DOM/network/audio/React imports, keeping `@glitch/core` pure.
 *
 * ## Units (dt)
 * The integration step in design.md is `nextX = x + f*(x - prev) + a*dt^2`.
 * `dt` is supplied in **milliseconds** (matching `GameConfig.stepMs`, ~33.3ms at
 * 30Hz) and converted to **seconds** internally for the `a*dt^2` term. Therefore
 * `gravity` (and any applied acceleration `a`) is expressed in
 * **units per second squared** — the natural physics convention (e.g. px/s²).
 * Because the loop is fixed-timestep, `dt` is constant across steps, which is the
 * assumption under which the classic constant-step Verlet form is valid.
 *
 * ## Mass weighting (invMass conversion)
 * design.md writes the constraint correction using masses `m`:
 * ```
 * shift = d * diff * 0.5 * stiffness
 * p1.x -= shift * (m2 / (m1 + m2))
 * p2.x += shift * (m1 / (m1 + m2))
 * ```
 * Our {@link Particle} stores `invMass` (0 = pinned/infinite mass). Substituting
 * `m = 1/invMass` gives `m2/(m1+m2) = invMass1/(invMass1+invMass2)` and
 * `m1/(m1+m2) = invMass2/(invMass1+invMass2)`. So each particle moves by its own
 * inverse-mass share of the correction:
 * ```
 * total = invMass1 + invMass2
 * p1.x -= shift * (invMass1 / total)
 * p2.x += shift * (invMass2 / total)
 * ```
 * A pinned particle (invMass 0) gets a 0 share and does not move, while its
 * non-pinned partner takes the full correction — exactly the infinite-mass
 * behavior the design intends. When `total === 0` (both pinned) the constraint
 * is skipped.
 */

import type { Particle, Constraint, Vec2 } from '../types/index.js';
import { createVec2, sub, length } from './vec2.js';

/** Milliseconds per second, used to convert `dtMs` to the seconds-based `a*dt²` term. */
const MS_PER_SECOND = 1000;

/**
 * Module-level scratch for the constraint separation vector `d = p2.x - p1.x`.
 * Reused across every constraint and relaxation iteration so the solver never
 * allocates inside its loops (Requirement 14.3). Safe because the module is
 * pure and JavaScript executes these synchronously on a single thread.
 */
const scratchD: Vec2 = createVec2();

/**
 * True when a particle is immovable (pinned or infinite mass). Such particles
 * are skipped by integration and contribute a zero inverse-mass share to
 * constraint corrections.
 */
function isFixed(p: Particle): boolean {
  return p.pinned || p.invMass === 0;
}

/**
 * Advance every non-fixed particle one fixed step using Verlet integration with
 * implicit velocity (`x - prev`), damping `f`, and constant acceleration `a`
 * (gravity plus any pre-applied force already folded into the particle's
 * positions). Mutates `particles` in place (Requirements 7.2, 14.2).
 *
 * Pinned / infinite-mass particles (`pinned === true` or `invMass === 0`) are
 * left untouched so cursor-held or anchored nodes stay put.
 *
 * @param particles Particles to integrate, mutated in place.
 * @param dtMs Fixed timestep in milliseconds (see "Units" in the file header).
 * @param gravity Constant acceleration in units/second² (downward is +y).
 * @param damping Velocity retention coefficient `f` (1 = frictionless, <1 damps).
 */
export function integrateParticles(
  particles: Particle[],
  dtMs: number,
  gravity: Vec2,
  damping: number,
): void {
  const dtSec = dtMs / MS_PER_SECOND;
  const dt2 = dtSec * dtSec;
  const ax = gravity.x * dt2;
  const ay = gravity.y * dt2;

  for (let i = 0; i < particles.length; i++) {
    const p = particles[i]!;
    if (isFixed(p)) continue;

    const cx = p.x.x;
    const cy = p.x.y;
    // Implicit velocity = current - previous.
    const vx = cx - p.prev.x;
    const vy = cy - p.prev.y;

    // nextX = x + f*(x - prev) + a*dt²
    const nextX = cx + damping * vx + ax;
    const nextY = cy + damping * vy + ay;

    // prev <- current, then x <- next (no allocation; scalar writes only).
    p.prev.x = cx;
    p.prev.y = cy;
    p.x.x = nextX;
    p.x.y = nextY;
  }
}

/**
 * Run `iterations` relaxation passes over `constraints`, nudging each connected
 * particle pair back toward the constraint's rest length so chain rest lengths
 * are preserved within tolerance after resolution (Requirements 7.3, 14.2).
 * Mutates the referenced particles in place.
 *
 * Mass weighting uses each particle's `invMass` share (see "Mass weighting" in
 * the file header); pinned / infinite-mass particles do not move. A constraint
 * whose endpoints are both fixed, or whose endpoints coincide (`dist === 0`,
 * which has no defined separation axis), is skipped to avoid divide-by-zero.
 *
 * @param particles The owning letter's particle array (indexed by constraints).
 * @param constraints Distance constraints to satisfy, referencing `particles` by index.
 * @param iterations Number of relaxation passes (research: 5–10 per tick).
 */
export function solveConstraints(
  particles: Particle[],
  constraints: Constraint[],
  iterations: number,
): void {
  for (let iter = 0; iter < iterations; iter++) {
    for (let c = 0; c < constraints.length; c++) {
      const con = constraints[c]!;
      const p1 = particles[con.a]!;
      const p2 = particles[con.b]!;

      // Inverse-mass shares; fixed particles contribute 0 (infinite mass).
      const iw1 = isFixed(p1) ? 0 : p1.invMass;
      const iw2 = isFixed(p2) ? 0 : p2.invMass;
      const total = iw1 + iw2;
      if (total === 0) continue; // both endpoints pinned: nothing to move.

      // d = p2.x - p1.x  (reuses module scratch, no allocation).
      sub(scratchD, p2.x, p1.x);
      const dist = length(scratchD);
      if (dist === 0) continue; // coincident points: no separation axis.

      // diff = (L - dist) / dist;  shift = d * diff * 0.5 * stiffness
      const factor = ((con.restLength - dist) / dist) * 0.5 * con.stiffness;
      const shiftX = scratchD.x * factor;
      const shiftY = scratchD.y * factor;

      // Each particle moves by its inverse-mass share of the correction.
      const w1 = iw1 / total;
      const w2 = iw2 / total;

      p1.x.x -= shiftX * w1;
      p1.x.y -= shiftY * w1;
      p2.x.x += shiftX * w2;
      p2.x.y += shiftY * w2;
    }
  }
}
