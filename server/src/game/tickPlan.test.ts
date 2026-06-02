import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  planServerTicks,
  DEFAULT_SERVER_STEP_MS,
  DEFAULT_MAX_TICKS_PER_WAKE,
} from './tickPlan.js';

/**
 * Unit + property tests for the pure fixed-timestep planner backing the
 * authoritative ~30Hz server tick (task 16.9, Requirements 7.2, 14.2, 14.6).
 *
 * These pin the rate-stability and spiral-of-death guarantees WITHOUT a real
 * timer or a `GameCore`, which is the whole point of extracting the decision.
 */
describe('planServerTicks (task 16.9)', () => {
  const STEP = DEFAULT_SERVER_STEP_MS;

  it('runs zero ticks when less than one step has accumulated', () => {
    const plan = planServerTicks(0, STEP / 2, STEP, DEFAULT_MAX_TICKS_PER_WAKE);
    expect(plan.ticks).toBe(0);
    expect(plan.accumulator).toBeCloseTo(STEP / 2, 9);
  });

  it('runs exactly one tick when one full step has accumulated', () => {
    const plan = planServerTicks(0, STEP, STEP, DEFAULT_MAX_TICKS_PER_WAKE);
    expect(plan.ticks).toBe(1);
    expect(plan.accumulator).toBeCloseTo(0, 9);
  });

  it('runs several ticks when a slow wake accumulates multiple steps', () => {
    const plan = planServerTicks(0, STEP * 3 + 5, STEP, DEFAULT_MAX_TICKS_PER_WAKE);
    expect(plan.ticks).toBe(3);
    expect(plan.accumulator).toBeCloseTo(5, 6);
  });

  it('clamps to maxTicks and discards the excess whole-step time (spiral guard)', () => {
    // 100 steps of backlog but a cap of 5: run 5, drop the rest, keep only the
    // sub-step remainder.
    const elapsed = STEP * 100 + 7;
    const plan = planServerTicks(0, elapsed, STEP, 5);
    expect(plan.ticks).toBe(5);
    expect(plan.accumulator).toBeGreaterThanOrEqual(0);
    expect(plan.accumulator).toBeLessThan(STEP);
    expect(plan.accumulator).toBeCloseTo(7, 6);
  });

  it('treats a non-positive step as "do nothing this wake"', () => {
    expect(planServerTicks(10, 10, 0, 5)).toEqual({ ticks: 0, accumulator: 0 });
    expect(planServerTicks(10, 10, -1, 5)).toEqual({ ticks: 0, accumulator: 0 });
    expect(planServerTicks(10, 10, Number.NaN, 5)).toEqual({ ticks: 0, accumulator: 0 });
  });

  it('treats non-finite / negative inputs as zero', () => {
    const plan = planServerTicks(Number.NaN, -50, STEP, DEFAULT_MAX_TICKS_PER_WAKE);
    expect(plan.ticks).toBe(0);
    expect(plan.accumulator).toBe(0);
  });

  /**
   * Property: the residual accumulator is ALWAYS in `[0, stepMs)` and ticks are
   * non-negative and never exceed the cap — for any sequence of wakes. This is
   * what keeps the physics rate stable around 30Hz regardless of the driver's
   * cadence (Requirement 14.6).
   *
   * **Validates: Requirements 14.6**
   */
  it('keeps the accumulator in [0, stepMs) and ticks within the cap across random wakes', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 1000, noNaN: true }), { minLength: 1, maxLength: 200 }),
        fc.integer({ min: 1, max: 10 }),
        (deltas, cap) => {
          let acc = 0;
          for (const delta of deltas) {
            const plan = planServerTicks(acc, delta, STEP, cap);
            expect(plan.ticks).toBeGreaterThanOrEqual(0);
            expect(plan.ticks).toBeLessThanOrEqual(cap);
            expect(Number.isInteger(plan.ticks)).toBe(true);
            expect(plan.accumulator).toBeGreaterThanOrEqual(0);
            expect(plan.accumulator).toBeLessThan(STEP);
            acc = plan.accumulator;
          }
        },
      ),
    );
  });

  /**
   * Property: with NO clamp pressure (a generous cap), accumulated time is
   * conserved — the ticks run account for the whole-step portion and the
   * remainder is carried forward (`ticks*step + accumulator === acc`).
   */
  it('conserves accumulated time when the cap does not bite', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 5000, noNaN: true }),
        fc.double({ min: 0, max: 500, noNaN: true }),
        (carried, delta) => {
          const acc = carried + delta;
          const cap = 100000; // effectively unbounded for these magnitudes.
          const plan = planServerTicks(carried, delta, STEP, cap);
          expect(plan.ticks * STEP + plan.accumulator).toBeCloseTo(acc, 6);
        },
      ),
    );
  });
});
