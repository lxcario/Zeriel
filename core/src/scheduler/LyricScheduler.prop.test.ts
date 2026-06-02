import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { LyricLine } from '../types/index.js';
import { LyricScheduler } from './index.js';

/**
 * Property-based test for the pure lyric scheduler (task 6.2).
 *
 * Property 16: Lyric scheduling drops each line once, in order, at its timestamp.
 * Validates: Requirements 6.3, 10.2.
 *
 * Design ("Correctness Properties" / Property 16): *For any* ordered set of
 * Lyric_Lines and any monotonically increasing playback timeline, each
 * Lyric_Line is dropped exactly once, never before its start timestamp, and in
 * ascending timestamp order. Requirement 6.3: "WHILE a Round is in progress, THE
 * Game_Server SHALL schedule each Lyric_Line to drop into play at its start
 * timestamp relative to the audio playback time." Requirement 10.2: "WHILE a
 * Round is in the playing state, THE Game_Server SHALL drop Lyric_Lines
 * according to their scheduled timestamps until the last Lyric_Line is reached."
 *
 * ---------------------------------------------------------------------------
 * Generator design
 * ---------------------------------------------------------------------------
 * - **Lines** (`linesArb`): an array of 0..30 records. Each line gets a unique
 *   id `line-${i}`, a non-empty text, an empty `solutionSlots` (matching what the
 *   LRC parser emits), and a non-negative integer `startMs`. `startMs` is drawn
 *   from a *blend* of a dense range (0..2000, weight 3) and the full bounded
 *   range (0..600000, weight 1). The dense range makes DUPLICATE `startMs`
 *   (ties) frequent, exercising the scheduler's stable tie-break. The array is
 *   in *generation order*, which is independent of `startMs`, so the input is
 *   NOT assumed sorted (the scheduler must sort its own private copy).
 * - **Monotonic times** (`monotonicTimesArb`): a NON-DECREASING sequence built by
 *   prefix-summing non-negative deltas from a non-negative start, then folding in
 *   a random subset of the lines' exact `startMs` values (to land *exactly on*
 *   timestamps) and optionally one time past the last line, then sorting
 *   ascending. Because the max time varies relative to the lines, this covers
 *   times before the first line, between lines, exactly on timestamps, and past
 *   the last line — including runs where not every line is reached.
 * - **Non-monotonic times** (`nonMonotonicTimesArb`): an arbitrary-order array of
 *   non-negative integers, deliberately including backward jumps, to assert the
 *   scheduler never re-drops / un-drops when playback time moves backward.
 *
 * ---------------------------------------------------------------------------
 * Instrumenting the "never before timestamp" check
 * ---------------------------------------------------------------------------
 * `onDrop` does not receive the current playback time. We close over a mutable
 * `currentUpdateTime` that is assigned IMMEDIATELY before each
 * `scheduler.update(t)` call. Inside the sink we assert
 * `currentUpdateTime >= line.startMs`: a line can only drop while the triggering
 * update's time has reached its `startMs`. This holds for both the monotonic and
 * non-monotonic strands (a drop always fires from the `update(t)` whose `t`
 * satisfies `startMs <= t`).
 */

/** Empty solutionSlots, exactly as the LRC parser emits before slot generation. */
type GeneratedLine = LyricLine;

/** A recorded drop, capturing identity, timestamp, and global drop order. */
interface DropRecord {
  id: string;
  startMs: number;
  dropOrderIndex: number;
}

/** Bounded full range for start timestamps (Requirement 6.2 timestamps in ms). */
const MAX_START_MS = 600_000;

/**
 * `startMs` generator blending a dense range (frequent ties) with the full
 * bounded range, so equal-timestamp lines are exercised regularly.
 */
const startMsArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 2000 }) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: MAX_START_MS }) },
);

/**
 * 0..30 lines with unique ids assigned by generation index. Input order is the
 * generation order (independent of startMs), i.e. intentionally unsorted.
 */
const linesArb: fc.Arbitrary<GeneratedLine[]> = fc
  .array(
    fc.record({
      startMs: startMsArb,
      text: fc.string({ minLength: 1, maxLength: 24 }),
    }),
    { minLength: 0, maxLength: 30 },
  )
  .map((specs) =>
    specs.map(
      (s, i): GeneratedLine => ({
        id: `line-${i}`,
        startMs: s.startMs,
        text: s.text,
        solutionSlots: [],
      }),
    ),
  );

/**
 * Build a non-decreasing (monotonic) sequence of playback times tailored to the
 * given lines: prefix-summed deltas, plus a subset of exact line timestamps,
 * plus an optional time past the last line, all sorted ascending.
 */
function monotonicTimesArb(lines: readonly GeneratedLine[]): fc.Arbitrary<number[]> {
  const exactArb =
    lines.length > 0 ? fc.subarray(lines.map((l) => l.startMs)) : fc.constant<number[]>([]);
  return fc
    .record({
      start: fc.integer({ min: 0, max: MAX_START_MS }),
      deltas: fc.array(fc.integer({ min: 0, max: 60_000 }), { maxLength: 40 }),
      includeExact: exactArb,
      pastEnd: fc.boolean(),
    })
    .map(({ start, deltas, includeExact, pastEnd }) => {
      const base: number[] = [];
      let t = start;
      for (const d of deltas) {
        base.push(t);
        t += d;
      }
      base.push(t); // always at least one update time
      const maxStart = lines.length > 0 ? Math.max(...lines.map((l) => l.startMs)) : 0;
      const extra = pastEnd ? [maxStart + 1000] : [];
      return [...base, ...includeExact, ...extra].sort((a, b) => a - b);
    });
}

/** Arbitrary-order playback times (includes backward jumps) of 0..40 entries. */
const nonMonotonicTimesArb: fc.Arbitrary<number[]> = fc.array(
  fc.integer({ min: 0, max: MAX_START_MS }),
  { maxLength: 40 },
);

/** Scenario pairing lines with a monotonic timeline derived from them. */
const monotonicScenarioArb = linesArb.chain((lines) =>
  fc.record({ lines: fc.constant(lines), times: monotonicTimesArb(lines) }),
);

/** Scenario pairing lines with an arbitrary-order (non-monotonic) timeline. */
const nonMonotonicScenarioArb = fc.record({
  lines: linesArb,
  times: nonMonotonicTimesArb,
});

/**
 * Stable ascending-by-startMs order matching the scheduler's internal sort
 * (tie-break on original input index), as the expected drop order.
 */
function stableExpectedOrder(lines: readonly GeneratedLine[]): GeneratedLine[] {
  return lines
    .map((line, index) => ({ line, index }))
    .sort((a, b) => a.line.startMs - b.line.startMs || a.index - b.index)
    .map(({ line }) => line);
}

describe('Property 16: Lyric scheduling drops each line once, in order, at its timestamp (Req 6.3, 10.2)', () => {
  it('monotonic timeline: each line drops exactly once, never early, in ascending stable order', () => {
    fc.assert(
      fc.property(monotonicScenarioArb, ({ lines, times }) => {
        let currentUpdateTime = Number.NEGATIVE_INFINITY;
        const drops: DropRecord[] = [];

        const scheduler = new LyricScheduler(lines, (line) => {
          // NEVER BEFORE TIMESTAMP: the triggering update time has reached startMs.
          expect(currentUpdateTime).toBeGreaterThanOrEqual(line.startMs);
          drops.push({ id: line.id, startMs: line.startMs, dropOrderIndex: drops.length });
        });

        for (const t of times) {
          currentUpdateTime = t;
          scheduler.update(t);
        }

        const maxUpdateTime = times[times.length - 1]!; // times always non-empty
        const maxStartMs =
          lines.length > 0 ? Math.max(...lines.map((l) => l.startMs)) : Number.NEGATIVE_INFINITY;

        // Expected drops: exactly the lines whose startMs has been reached, in
        // the scheduler's stable ascending order.
        const expectedOrder = stableExpectedOrder(lines).filter((l) => l.startMs <= maxUpdateTime);
        const expectedIds = expectedOrder.map((l) => l.id);
        const droppedIds = drops.map((d) => d.id);

        // EXACTLY ONCE: no id dropped twice, and the dropped set is precisely the
        // reached lines (lines with startMs > maxUpdateTime are NOT dropped).
        expect(new Set(droppedIds).size).toBe(droppedIds.length);
        expect([...droppedIds].sort()).toEqual([...expectedIds].sort());

        // ASCENDING ORDER + STABLE TIES: dropped startMs sequence is
        // non-decreasing, and the full id sequence matches the stable expectation.
        const droppedStartMs = drops.map((d) => d.startMs);
        for (let i = 1; i < droppedStartMs.length; i++) {
          expect(droppedStartMs[i]!).toBeGreaterThanOrEqual(droppedStartMs[i - 1]!);
        }
        expect(droppedIds).toEqual(expectedIds);

        // COMPLETENESS: progress accounting is consistent and isComplete() is true
        // exactly when there are no lines OR the last line's timestamp was reached.
        expect(scheduler.dropped).toBe(drops.length);
        expect(scheduler.total).toBe(lines.length);
        expect(scheduler.remaining()).toBe(scheduler.total - scheduler.dropped);
        const allReached = lines.length === 0 || maxUpdateTime >= maxStartMs;
        expect(scheduler.isComplete()).toBe(allReached);
        if (allReached) {
          expect(scheduler.remaining()).toBe(0);
          expect(scheduler.dropped).toBe(scheduler.total);
        } else {
          expect(scheduler.isComplete()).toBe(false);
        }
      }),
    );
  });

  it('non-monotonic timeline: backward jumps never re-drop or un-drop; count tracks the running max', () => {
    fc.assert(
      fc.property(nonMonotonicScenarioArb, ({ lines, times }) => {
        let currentUpdateTime = Number.NEGATIVE_INFINITY;
        const drops: DropRecord[] = [];

        const scheduler = new LyricScheduler(lines, (line) => {
          // Still never before its timestamp, even with out-of-order updates.
          expect(currentUpdateTime).toBeGreaterThanOrEqual(line.startMs);
          drops.push({ id: line.id, startMs: line.startMs, dropOrderIndex: drops.length });
        });

        let runningMax = Number.NEGATIVE_INFINITY;
        for (const t of times) {
          currentUpdateTime = t;
          scheduler.update(t);
          runningMax = Math.max(runningMax, t);

          // After every update (including a backward one), the dropped count is
          // exactly the number of lines reached by the MAX time seen so far —
          // backward time adds nothing, and nothing is ever re-dropped.
          const reachedSoFar = lines.filter((l) => l.startMs <= runningMax).length;
          expect(scheduler.dropped).toBe(reachedSoFar);
          expect(drops.length).toBe(reachedSoFar);
        }

        // No id ever dropped twice across the whole non-monotonic sequence.
        const droppedIds = drops.map((d) => d.id);
        expect(new Set(droppedIds).size).toBe(droppedIds.length);

        // Drops are globally in ascending stable order regardless of input order.
        const expectedOrder = stableExpectedOrder(lines)
          .filter((l) => l.startMs <= runningMax)
          .map((l) => l.id);
        expect(droppedIds).toEqual(expectedOrder);

        const droppedStartMs = drops.map((d) => d.startMs);
        for (let i = 1; i < droppedStartMs.length; i++) {
          expect(droppedStartMs[i]!).toBeGreaterThanOrEqual(droppedStartMs[i - 1]!);
        }
      }),
    );
  });
});
