/**
 * Pure fixed-timestep accumulator math (task 13.1).
 *
 * Design reference (design.md "Fixed-Timestep Loop (decoupled physics)"):
 *
 * ```
 * const STEP = 1000 / 30;        // ~33.3ms authoritative tick
 * accumulator += frameDeltaMs;
 * while (accumulator >= STEP) {
 *     gameCore.tick(STEP);       // integrate + relax + locks + scoring
 *     accumulator -= STEP;
 * }
 * renderer.draw(gameCore.state, interpolationAlpha);  // render at display rate
 * ```
 *
 * The physics step MUST be decoupled from the Renderer frame rate (Requirements
 * 7.2, 14.2, 14.6): physics advances in fixed `~33.3ms` (30Hz) increments while
 * rendering runs at the display rate (target 60fps, Requirement 14.1). The
 * Renderer interpolates between the two most recent physics states using
 * `accumulator / STEP` so motion stays smooth even though physics ticks slower
 * than it renders.
 *
 * This module extracts the *decision* part of that loop — how many fixed steps
 * to run this frame, the residual accumulator, and the interpolation `alpha` —
 * into a pure function ({@link planFixedSteps}) so it can be unit-tested without
 * `requestAnimationFrame`, real timers, or a `GameCore`. {@link LocalGameHost}
 * calls it each frame and then runs exactly `plan.steps` ticks. No DOM, no
 * allocation beyond the small returned record.
 */

/** Default fixed physics step in ms — 30Hz (~33.3ms), per Requirement 14.6. */
export const DEFAULT_STEP_MS = 1000 / 30;

/**
 * Default cap on fixed steps executed per frame. Bounds the work done in a
 * single frame so a long stall (e.g. a backgrounded tab that resumes with a
 * huge `frameDeltaMs`) cannot trigger a "spiral of death" where each frame
 * schedules ever more catch-up ticks. Excess accumulated time beyond this cap
 * is intentionally discarded (see {@link planFixedSteps}).
 */
export const DEFAULT_MAX_STEPS_PER_FRAME = 5;

/**
 * The outcome of one fixed-timestep planning call for a single rendered frame.
 */
export interface FixedStepPlan {
  /**
   * Number of fixed `stepMs` physics ticks to run this frame (>= 0, never more
   * than the supplied `maxSteps`).
   */
  steps: number;
  /**
   * Residual accumulator carried into the next frame, always in `[0, stepMs)`.
   * This is the leftover sub-step time after running `steps` whole ticks; any
   * time discarded by the `maxSteps` clamp is NOT included here.
   */
  accumulator: number;
  /**
   * Interpolation factor in `[0, 1)` for the Renderer — `accumulator / stepMs`.
   * `0` means render exactly at the latest physics state; values approaching `1`
   * mean render nearly a full step ahead of it (Requirements 14.1, 14.2).
   */
  alpha: number;
}

/** Coerce a value to a finite number `>= 0`, mapping NaN/Infinity/negatives to 0. */
function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Plan the fixed-timestep work for one rendered frame (pure; the testable core
 * of the {@link LocalGameHost} loop).
 *
 * Given the accumulator carried from the previous frame and the wall-clock delta
 * since it, this returns how many fixed `stepMs` ticks to run, the residual
 * accumulator to carry forward, and the interpolation `alpha`.
 *
 * Behavior and guarantees:
 * - **Accumulate then drain.** `acc = accumulatorMs + frameDeltaMs`; the number
 *   of whole steps is `floor(acc / stepMs)`.
 * - **Decoupled from render rate.** Several display frames may run 0 steps (when
 *   rendering faster than 30Hz) and a slow frame may run several — exactly the
 *   decoupling Requirements 7.2/14.2/14.6 require.
 * - **Spiral-of-death guard.** Steps are clamped to `maxSteps`; when the clamp
 *   bites, the extra whole-step time is DROPPED (only the sub-step fractional
 *   remainder is carried forward) so a resumed-after-stall frame cannot cascade.
 * - **Residual + alpha.** The returned `accumulator` is the fractional remainder
 *   in `[0, stepMs)` and `alpha = accumulator / stepMs` in `[0, 1)`, regardless
 *   of whether the clamp bit.
 * - **Defensive inputs.** Non-finite or negative `accumulatorMs`/`frameDeltaMs`
 *   are treated as `0`; a non-positive or non-finite `stepMs` yields no steps
 *   and a zero accumulator/alpha (the loop simply does nothing that frame).
 *
 * @param accumulatorMs  Leftover accumulator from the previous frame, in ms.
 * @param frameDeltaMs   Wall-clock time since the previous frame, in ms.
 * @param stepMs         Fixed physics step size, in ms (e.g. {@link DEFAULT_STEP_MS}).
 * @param maxSteps       Maximum ticks to run this frame ({@link DEFAULT_MAX_STEPS_PER_FRAME}).
 */
export function planFixedSteps(
  accumulatorMs: number,
  frameDeltaMs: number,
  stepMs: number,
  maxSteps: number,
): FixedStepPlan {
  // A non-positive / non-finite step disables stepping entirely.
  if (!Number.isFinite(stepMs) || stepMs <= 0) {
    return { steps: 0, accumulator: 0, alpha: 0 };
  }

  const acc = nonNegativeFinite(accumulatorMs) + nonNegativeFinite(frameDeltaMs);
  const cap = Number.isFinite(maxSteps) && maxSteps > 0 ? Math.floor(maxSteps) : 0;

  const rawSteps = Math.floor(acc / stepMs);
  const steps = rawSteps > cap ? cap : rawSteps;

  // Fractional remainder in [0, stepMs). When the cap bites, the whole-step
  // time above the cap is discarded (spiral-of-death guard) — only this
  // sub-step remainder is carried forward, identical in both branches.
  const residual = acc - rawSteps * stepMs;
  // Clamp defends against floating-point drift so the [0, stepMs) / [0, 1)
  // invariants hold for every input.
  const accumulator = residual < 0 ? 0 : residual >= stepMs ? 0 : residual;
  const alpha = accumulator / stepMs;

  return { steps, accumulator, alpha };
}
