/**
 * Pure play-area boundary resolution for the Verlet Physics_Engine.
 *
 * After integration, particle positions are clamped to the play-area rectangle;
 * a particle that crosses a wall is reflected with restitution and its `prev`
 * adjusted so the implicit velocity damps rather than spikes
 * (design.md "Boundaries and stacking", Requirement 7.4). Operates in place on a
 * `Particle[]`, is deterministic given its inputs, and allocates nothing inside
 * its loop — only scalar locals are used (Requirement 14.3).
 *
 * Pure module: no DOM/network/audio/React imports, keeping `@glitch/core` pure.
 *
 * ## Reflection / prev-adjustment math
 * A particle's velocity is implicit in `v = x - prev` (design.md "Particle
 * integration"). When a particle crosses a wall we clamp its position onto the
 * boundary value `b` and then choose `prev` so the *new* implicit velocity is
 * the reflected, restitution-scaled velocity along that axis:
 *
 * ```
 * vBefore = x.axis - prev.axis      // velocity that carried it past the wall
 * x.axis  = b                       // clamp onto the boundary
 * prev.axis = b + restitution * vBefore
 * ```
 *
 * The resulting implicit velocity is
 * `x.axis - prev.axis = b - (b + restitution * vBefore) = -restitution * vBefore`,
 * i.e. the component normal to the wall is reversed and scaled by
 * `restitution`. This single formula is correct for every edge (left/right,
 * top/bottom) because clamping onto `b` and subtracting `restitution * vBefore`
 * always points the rebound back into the play area:
 *
 * - `restitution === 0` → new velocity `0`: the particle sticks to the wall
 *   (fully damped, no bounce) instead of spiking.
 * - `restitution === 1` → new velocity `-vBefore`: a fully elastic bounce.
 *
 * Because only `prev` is adjusted (and `x` is set exactly to the boundary), the
 * clamped position is exactly in-bounds; the rebound is felt on the *next*
 * integration step, so the velocity never "spikes" from the clamp itself.
 *
 * ## Fixed particles (decision + design citation)
 * Design (Requirement 7.4): "WHILE Rope_Letters are in the play area, THE
 * Physics_Engine SHALL constrain Rope_Letter particles to remain within the
 * play-area bounds." The design narrative adds that a crossing particle "is
 * reflected with restitution and its `prev` adjusted so the implicit velocity
 * damps rather than spikes."
 *
 * Decision: **position is clamped for ALL particles** so nothing ever leaves the
 * play area (satisfying 7.4 universally, including a cursor-held node). The
 * **reflection / prev-adjustment is applied only to non-fixed particles**.
 * Fixed particles (`pinned === true` or `invMass === 0`, e.g. a cursor-held or
 * anchored node) are skipped by integration and have no meaningful implicit
 * velocity, so reflecting their `prev` would be meaningless and could fight the
 * input that drives them toward the cursor (Requirement 8.3). Clamping their
 * position alone keeps them visibly in-bounds without that conflict.
 */

import type { Particle, Rect } from '../types/index.js';

/**
 * True when a particle is immovable (pinned or infinite mass). Such particles
 * have their position clamped but skip the velocity-reflection prev-adjustment.
 */
function isFixed(p: Particle): boolean {
  return p.pinned || p.invMass === 0;
}

/**
 * Clamp every particle to the play-area rectangle, reflecting non-fixed
 * particles off the walls with `restitution` and damping their implicit
 * velocity via a `prev` adjustment (Requirement 7.4). Mutates `particles` in
 * place; allocates nothing (Requirement 14.3).
 *
 * The X and Y axes are resolved independently so a particle that overshoots a
 * corner is clamped and reflected on both axes in the same pass.
 *
 * @param particles Particles to constrain, mutated in place.
 * @param bounds Play-area rectangle (top-left origin) particles must stay within.
 * @param restitution Bounce factor in [0, 1] (0 = fully damped, 1 = elastic).
 */
export function resolveBounds(
  particles: Particle[],
  bounds: Rect,
  restitution: number,
): void {
  const left = bounds.x;
  const right = bounds.x + bounds.width;
  const top = bounds.y;
  const bottom = bounds.y + bounds.height;

  for (let i = 0; i < particles.length; i++) {
    const p = particles[i]!;
    const fixed = isFixed(p);

    // --- X axis: clamp onto the crossed wall, reflect prev if movable. ---
    if (p.x.x < left) {
      const vBefore = p.x.x - p.prev.x;
      p.x.x = left;
      if (!fixed) p.prev.x = left + restitution * vBefore;
    } else if (p.x.x > right) {
      const vBefore = p.x.x - p.prev.x;
      p.x.x = right;
      if (!fixed) p.prev.x = right + restitution * vBefore;
    }

    // --- Y axis: independent of X so corners reflect on both axes. ---
    if (p.x.y < top) {
      const vBefore = p.x.y - p.prev.y;
      p.x.y = top;
      if (!fixed) p.prev.y = top + restitution * vBefore;
    } else if (p.x.y > bottom) {
      const vBefore = p.x.y - p.prev.y;
      p.x.y = bottom;
      if (!fixed) p.prev.y = bottom + restitution * vBefore;
    }
  }
}
