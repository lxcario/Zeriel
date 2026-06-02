/**
 * Pure inter-letter overlap (stacking) resolution for the Physics_Engine.
 *
 * Rope_Letters are given coarse circular collider radii at their particle
 * nodes. A positional pass pushes overlapping nodes apart along their
 * separation axis so letters pile up rather than passing through each other
 * (design.md "Boundaries and stacking", Requirement 7.5). This is a *positional*
 * (not impulse) resolution — node positions `x` are moved directly — which is
 * consistent with the Verlet approach (the position change is itself felt as a
 * velocity on the next integration step).
 *
 * Operates in place on `RopeLetter[]`, is deterministic given its inputs, and
 * allocates nothing inside its loops (only scalar locals) (Requirement 14.3).
 *
 * Pure module: no DOM/network/audio/React imports, keeping `@glitch/core` pure.
 *
 * ## Scope: cross-letter only
 * The requirement is about "two Rope_Letters" overlapping. Spacing *within* a
 * single letter is governed by its distance constraints (see
 * {@link solveConstraints}), so this pass resolves **only pairs of nodes that
 * belong to different letters**. Same-letter node pairs are never compared,
 * which avoids fighting the constraint solver.
 *
 * ## Collider model
 * Each particle node of a letter is treated as a circle of radius equal to that
 * letter's `colliderRadius`. Two nodes from different letters overlap when the
 * distance between their centers is less than the sum of the two letters'
 * radii. The penetration depth is `(r1 + r2) - dist`.
 *
 * ## Positional push + inverse-mass split
 * For an overlapping pair, nodes are separated along the unit axis
 * `n = (p2 - p1) / dist`, mirroring the inverse-mass weighting convention used
 * by {@link solveConstraints}: each node moves by its own inverse-mass share of
 * the penetration so a pinned / infinite-mass node (a cursor-held or anchored
 * node) stays put while its partner takes the whole correction.
 *
 * ```
 * iw1 = isFixed(p1) ? 0 : p1.invMass
 * iw2 = isFixed(p2) ? 0 : p2.invMass
 * total = iw1 + iw2                 // both fixed -> skip (cannot separate)
 * p1 -= n * penetration * (iw1 / total)
 * p2 += n * penetration * (iw2 / total)
 * ```
 *
 * The pair's separation increases by exactly `penetration * (iw1 + iw2)/total =
 * penetration`, so after the push the nodes just touch (non-overlapping).
 *
 * ## Coincident-center degenerate case (determinism)
 * When two node centers coincide (`dist === 0`) there is no defined separation
 * axis. To avoid `NaN` (division by zero) and to keep the engine deterministic,
 * a fixed separation axis of `+x` (`n = (1, 0)`) is used. The choice is constant
 * and reproducible — the same inputs always produce the same separation — which
 * is required for client/server agreement and property testing.
 */

import type { Particle, RopeLetter } from '../types/index.js';

/**
 * True when a particle is immovable (pinned or infinite mass). Mirrors the
 * convention in {@link solveConstraints}: fixed nodes contribute a zero
 * inverse-mass share and therefore do not move.
 */
function isFixed(p: Particle): boolean {
  return p.pinned || p.invMass === 0;
}

/**
 * Resolve overlaps between the collider nodes of different rope-letters by
 * pushing penetrating node pairs apart positionally so letters stack/pile
 * rather than pass through one another (Requirement 7.5). Mutates the letters'
 * particle positions in place; allocates nothing (Requirement 14.3).
 *
 * Only cross-letter node pairs are considered (within-letter spacing is handled
 * by distance constraints). A simple nested loop is used — acceptable for the
 * configured maximum number of concurrent letters; no spatial hash is needed.
 *
 * @param letters The live rope-letters whose nodes may overlap, mutated in place.
 */
export function resolveOverlap(letters: RopeLetter[]): void {
  for (let li = 0; li < letters.length; li++) {
    const a = letters[li]!;
    const ra = a.colliderRadius;
    const aParticles = a.particles;

    // Only compare against LATER letters so each cross-letter pair is visited
    // once and same-letter pairs are never compared.
    for (let lj = li + 1; lj < letters.length; lj++) {
      const b = letters[lj]!;
      const minDist = ra + b.colliderRadius;
      if (minDist <= 0) continue; // no collider footprint: nothing to resolve.
      const minDistSq = minDist * minDist;
      const bParticles = b.particles;

      for (let i = 0; i < aParticles.length; i++) {
        const p1 = aParticles[i]!;
        const iw1 = isFixed(p1) ? 0 : p1.invMass;

        for (let j = 0; j < bParticles.length; j++) {
          const p2 = bParticles[j]!;
          const iw2 = isFixed(p2) ? 0 : p2.invMass;
          const total = iw1 + iw2;
          if (total === 0) continue; // both fixed: cannot separate.

          let dx = p2.x.x - p1.x.x;
          let dy = p2.x.y - p1.x.y;
          const distSq = dx * dx + dy * dy;
          if (distSq >= minDistSq) continue; // not overlapping.

          let dist: number;
          let nx: number;
          let ny: number;
          if (distSq === 0) {
            // Coincident centers: no axis. Use a fixed, deterministic +x axis.
            dist = 0;
            nx = 1;
            ny = 0;
          } else {
            dist = Math.sqrt(distSq);
            nx = dx / dist;
            ny = dy / dist;
          }

          const penetration = minDist - dist;
          const w1 = iw1 / total;
          const w2 = iw2 / total;

          // p1 moves away from p2 (along -n); p2 moves along +n.
          p1.x.x -= nx * penetration * w1;
          p1.x.y -= ny * penetration * w1;
          p2.x.x += nx * penetration * w2;
          p2.x.y += ny * penetration * w2;
        }
      }
    }
  }
}
