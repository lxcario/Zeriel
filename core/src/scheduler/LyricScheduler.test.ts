import { describe, it, expect, vi } from 'vitest';
import type { LyricLine } from '../types/index.js';
import { LyricScheduler } from './index.js';

/**
 * Smoke unit tests for task 6.1: the pure lyric scheduler.
 *
 * These prove the core guarantees of the task — lines drop only at/after their
 * `startMs`, each line drops exactly once across repeated updates, ascending
 * order is preserved (including within a single update that crosses several
 * timestamps), `isComplete()`/`remaining()` track progress, and non-monotonic
 * (backward) time never re-drops. The dedicated property test is optional task
 * 6.2 and is NOT written here.
 */

/** Build a LyricLine with the empty `solutionSlots` the LRC parser emits. */
function makeLine(id: string, startMs: number, text = id): LyricLine {
  return { id, startMs, text, solutionSlots: [] };
}

/** Capture the ids dropped, in drop order, plus the LyricScheduler under test. */
function makeScheduler(lines: readonly LyricLine[]): {
  scheduler: LyricScheduler;
  dropped: string[];
} {
  const dropped: string[] = [];
  const scheduler = new LyricScheduler(lines, (line) => dropped.push(line.id));
  return { scheduler, dropped };
}

describe('LyricScheduler (task 6.1)', () => {
  it('never drops a line before its startMs', () => {
    const { scheduler, dropped } = makeScheduler([
      makeLine('a', 1000),
      makeLine('b', 2000),
    ]);

    scheduler.update(0);
    expect(dropped).toEqual([]);
    scheduler.update(999);
    expect(dropped).toEqual([]);
    // Exactly at the timestamp counts as reached.
    scheduler.update(1000);
    expect(dropped).toEqual(['a']);
    scheduler.update(1999);
    expect(dropped).toEqual(['a']);
    scheduler.update(2000);
    expect(dropped).toEqual(['a', 'b']);
  });

  it('drops each line exactly once across repeated/duplicate updates', () => {
    const { scheduler, dropped } = makeScheduler([
      makeLine('a', 100),
      makeLine('b', 200),
    ]);

    scheduler.update(250);
    scheduler.update(250); // same time again
    scheduler.update(300); // further forward
    scheduler.update(10_000); // big jump

    expect(dropped).toEqual(['a', 'b']);
  });

  it('preserves ascending startMs order even when constructed unsorted', () => {
    const { scheduler, dropped } = makeScheduler([
      makeLine('c', 300),
      makeLine('a', 100),
      makeLine('b', 200),
    ]);

    scheduler.update(1000);
    expect(dropped).toEqual(['a', 'b', 'c']);
  });

  it('drops all reached lines in order within a single update crossing several timestamps', () => {
    const { scheduler, dropped } = makeScheduler([
      makeLine('a', 100),
      makeLine('b', 200),
      makeLine('c', 300),
      makeLine('d', 5000),
    ]);

    // One update at 350 should drop a, b, c (in order) but not d.
    scheduler.update(350);
    expect(dropped).toEqual(['a', 'b', 'c']);
    expect(scheduler.isComplete()).toBe(false);
  });

  it('drops tied-timestamp lines together in stable input order', () => {
    const { scheduler, dropped } = makeScheduler([
      makeLine('first', 500),
      makeLine('second', 500),
      makeLine('third', 500),
    ]);

    scheduler.update(500);
    expect(dropped).toEqual(['first', 'second', 'third']);
  });

  it('reports isComplete() and remaining() correctly as lines drop', () => {
    const { scheduler } = makeScheduler([
      makeLine('a', 100),
      makeLine('b', 200),
    ]);

    expect(scheduler.total).toBe(2);
    expect(scheduler.remaining()).toBe(2);
    expect(scheduler.isComplete()).toBe(false);

    scheduler.update(100);
    expect(scheduler.remaining()).toBe(1);
    expect(scheduler.dropped).toBe(1);
    expect(scheduler.isComplete()).toBe(false);

    scheduler.update(200);
    expect(scheduler.remaining()).toBe(0);
    expect(scheduler.isComplete()).toBe(true);
  });

  it('is vacuously complete with no lines and drops nothing', () => {
    const { scheduler, dropped } = makeScheduler([]);
    expect(scheduler.isComplete()).toBe(true);
    expect(scheduler.remaining()).toBe(0);
    scheduler.update(10_000);
    expect(dropped).toEqual([]);
  });

  it('never re-drops or un-drops when time moves backward (non-monotonic input)', () => {
    const { scheduler, dropped } = makeScheduler([
      makeLine('a', 100),
      makeLine('b', 200),
      makeLine('c', 300),
    ]);

    scheduler.update(250); // drops a, b
    expect(dropped).toEqual(['a', 'b']);

    // Time jumps backward — must not re-drop or un-drop anything.
    scheduler.update(0);
    expect(dropped).toEqual(['a', 'b']);
    scheduler.update(150);
    expect(dropped).toEqual(['a', 'b']);

    // Resuming forward drops only the still-pending line, once.
    scheduler.update(300);
    expect(dropped).toEqual(['a', 'b', 'c']);
    expect(scheduler.isComplete()).toBe(true);
  });

  it('feeds dropped lines to the sink (wired to GameCore.spawnLine in the host)', () => {
    const sink = vi.fn();
    const lines = [makeLine('a', 0), makeLine('b', 10)];
    const scheduler = new LyricScheduler(lines, sink);

    scheduler.update(10);

    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[0]![0]).toBe(lines[0]);
    expect(sink.mock.calls[1]![0]).toBe(lines[1]);
  });

  it('does not re-schedule when the caller mutates the input array afterwards', () => {
    const input = [makeLine('a', 100)];
    const { dropped } = (() => {
      const captured: string[] = [];
      const scheduler = new LyricScheduler(input, (line) => captured.push(line.id));
      // Mutating the original array must not affect the scheduler's private copy.
      input.push(makeLine('late', 50));
      scheduler.update(1000);
      return { dropped: captured };
    })();

    expect(dropped).toEqual(['a']);
  });
});
