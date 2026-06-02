/**
 * Barrel for the pure Verlet physics primitives.
 *
 * Re-exports the allocation-free {@link Vec2} math helpers and the integration /
 * constraint-relaxation functions. These are pure, deterministic, and free of
 * DOM/network/audio/React imports (task 3.1).
 */

export {
  createVec2,
  set,
  copy,
  add,
  sub,
  scale,
  addScaled,
  lengthSq,
  length,
  Vec2Pool,
} from './vec2.js';

export { integrateParticles, solveConstraints } from './verlet.js';

export { resolveBounds } from './bounds.js';

export { resolveOverlap } from './collision.js';
