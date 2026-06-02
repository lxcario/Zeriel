/**
 * Pure server-side fixed-timestep planning (task 16.9).
 *
 * The authoritative Game_Server advances `GameCore` on a FIXED ~30Hz tick that
 * is decoupled from whatever timer actually drives the loop (Requirements 14.6,
 * 7.2). This module extracts the *decision* — how many fixed `stepMs` ticks to
 * run for a given slice of elapsed wall-clock time, and the residual accumulator
 * to carry forward — into a pure function so it is unit/property-testable with
 * NO real timers and NO `GameCore` (mirrors the client's `planFixedSteps`, but
 * the server needs no interpolation `alpha`: it never renders).
 *
 * design.md "Fixed-Timestep Loop (decoupled physics)":
 *
 * ```
 * const STEP = 1000 / 30;        // ~33.3ms authoritative tick
 * accumulator += frameDeltaMs;
 * while (accumulator >= STEP) { gameCore.tick(STEP); accumulator -= STEP; }
 * ```
 *
 * The injectable loop driver ({@link AuthoritativeGameLoop}) calls
 * {@link planServerTicks} each time it wakes and then runs exactly `plan.ticks`
 * ticks, so the physics rate stays a stable 30Hz regardless of how often (or how
 * irregularly) the OS timer fires.
 */

/** Default fixed authoritative physics step in ms — ~33.3ms (30Hz), Requirement 14.6. */
export const DEFAULT_SERVER_STEP_MS = 1000 / 30;

/**
 * Default cap on fixed ticks executed per loop wake. Bounds the catch-up work a
 * single wake can do so a long pause (a stalled event loop, a process resumed
 * from sleep) cannot trigger a "spiral of death" where each wake schedules ever
 * more ticks. Whole-step time beyond the cap is intentionally discarded.
 */
export const DEFAULT_MAX_TICKS_PER_WAKE = 5;

/** The outcome of one fixed-timestep planning call for a single loop wake. */
export interface ServerTickPlan {
  /**
   * Number of fixed `stepMs` ticks to run now (>= 0, never more than the
   * supplied `maxTicks`).
   */
  ticks: number;
  /**
   * Residual accumulator to carry into the next wake, always in `[0, stepMs)`.
   * The leftover sub-step time after running `ticks` whole ticks; any time
   * discarded by the `maxTicks` clamp is NOT included here.
   */
  accumulator: number;
}

/** Coerce a value to a finite number `>= 0`, mapping NaN/Infinity/negatives to 0. */
function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Plan the fixed-timestep work for one loop wake (pure; the testable core of the
 * authoritative tick loop).
 *
 * Given the accumulator carried from the previous wake and the wall-clock time
 * elapsed since it, this returns how many fixed `stepMs` ticks to run and the
 * residual accumulator to carry forward.
 *
 * Guarantees:
 * - **Accumulate then drain.** `acc = accumulatorMs + elapsedMs`; whole ticks =
 *   `floor(acc / stepMs)`.
 * - **Rate-stable / decoupled.** Several fast wakes run 0 ticks; a slow wake runs
 *   several — so the physics rate stays ~30Hz no matter the driver cadence
 *   (Requirements 7.2, 14.2, 14.6).
 * - **Spiral-of-death guard.** Ticks are clamped to `maxTicks`; when the clamp
 *   bites, the excess whole-step time is DROPPED (only the sub-step remainder is
 *   carried forward) so a resumed-after-stall wake cannot cascade.
 * - **Residual invariant.** The returned `accumulator` is always in
 *   `[0, stepMs)`, whether or not the clamp bit.
 * - **Defensive inputs.** Non-finite/negative `accumulatorMs`/`elapsedMs` are
 *   treated as `0`; a non-positive/non-finite `stepMs` yields no ticks and a zero
 *   accumulator (the loop simply does nothing this wake).
 *
 * @param accumulatorMs Leftover accumulator from the previous wake, in ms.
 * @param elapsedMs     Wall-clock time since the previous wake, in ms.
 * @param stepMs        Fixed physics step size, in ms (e.g. {@link DEFAULT_SERVER_STEP_MS}).
 * @param maxTicks      Maximum ticks to run this wake ({@link DEFAULT_MAX_TICKS_PER_WAKE}).
 */
export function planServerTicks(
  accumulatorMs: number,
  elapsedMs: number,
  stepMs: number,
  maxTicks: number,
): ServerTickPlan {
  // A non-positive / non-finite step disables ticking entirely.
  if (!Number.isFinite(stepMs) || stepMs <= 0) {
    return { ticks: 0, accumulator: 0 };
  }

  const acc = nonNegativeFinite(accumulatorMs) + nonNegativeFinite(elapsedMs);
  const cap = Number.isFinite(maxTicks) && maxTicks > 0 ? Math.floor(maxTicks) : 0;

  const rawTicks = Math.floor(acc / stepMs);
  const ticks = rawTicks > cap ? cap : rawTicks;

  // Fractional remainder in [0, stepMs). When the cap bites, the whole-step time
  // above the cap is discarded (spiral guard) — only this sub-step remainder is
  // carried forward, identical in both branches.
  const residual = acc - rawTicks * stepMs;
  // Clamp defends against floating-point drift so the [0, stepMs) invariant holds.
  const accumulator = residual < 0 ? 0 : residual >= stepMs ? 0 : residual;

  return { ticks, accumulator };
}
