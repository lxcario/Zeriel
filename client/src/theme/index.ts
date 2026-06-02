/**
 * Barrel for the client `theme` module (task 8.1).
 *
 * Re-exports the Reduce_Motion_Mode resolution/persistence helpers and the
 * art-direction theme selector so consumers (the Renderer in task 9.1, the
 * React UI shell/toggle in task 14.1) can import from a single entry point.
 */

export {
  resolveReduceMotion,
  loadExplicitChoice,
  saveExplicitChoice,
  readPrefersReducedMotion,
  getEffectiveReduceMotion,
  REDUCE_MOTION_STORAGE_KEY,
  PREFERS_REDUCED_MOTION_QUERY,
  type StorageLike,
  type MatchMediaFn,
} from './reduceMotion.ts';

export { selectTheme, type Theme, type Surface } from './themeSelect.ts';
