/**
 * `LyricScheduler` — a pure, deterministic, playback-time-driven dropper for
 * Lyric_Lines (task 6.1).
 *
 * Design references:
 * - design.md "Round State Machine" / "Fixed-Timestep Loop": lyric scheduling is
 *   driven by the audio **playback time**, which the host feeds in each tick.
 *   While a Round is `Playing`, lines drop "according to their scheduled
 *   timestamps until the last Lyric_Line is reached".
 * - design.md "GameCore public surface": this scheduler feeds
 *   `GameCore.spawnLine(line)` via its {@link LyricDropSink} callback. It does
 *   NOT reference GameCore directly so that `@glitch/core` stays free of any
 *   GameCore↔scheduler coupling and the scheduler is trivially unit-testable.
 *
 * Requirements:
 * - **6.3**: "WHILE a Round is in progress, THE Game_Server SHALL schedule each
 *   Lyric_Line to drop into play at its start timestamp relative to the audio
 *   playback time."
 * - **10.2**: "WHILE a Round is in the playing state, THE Game_Server SHALL drop
 *   Lyric_Lines according to their scheduled timestamps until the last
 *   Lyric_Line is reached."
 *
 * ## Purity
 * This module imports only the shared {@link LyricLine} type. It performs NO
 * audio/DOM/network/React work — the *host* (the fixed-timestep loop in tasks
 * 13.1 / 16.9) owns the audio clock and calls {@link LyricScheduler.update} with
 * the current playback time each tick. Given the same lines and the same
 * sequence of `update` times, the scheduler produces the same drops in the same
 * order (deterministic).
 *
 * ## Guarantees (and how they are enforced)
 * The scheduler keeps a single defensively-sorted internal copy of the lines and
 * a monotonically advancing cursor ({@link nextIndex}) into it. All guarantees
 * fall out of that cursor:
 *
 * - **Dropped exactly once (6.3 / 10.2).** A line is dropped only as the cursor
 *   passes it, and the cursor only ever ADVANCES. Once dropped, a line is behind
 *   the cursor forever, so it can never be dropped again — even if `update` is
 *   called repeatedly, with the same time, or with a smaller time.
 * - **Never before its timestamp.** A line at the cursor is dropped only when
 *   `line.startMs <= playbackTimeMs`. The first line whose `startMs` exceeds the
 *   supplied time stops the scan, and (because the list is sorted) so do all
 *   lines after it. A line therefore never drops while playback time is below
 *   its `startMs`.
 * - **Ascending startMs order.** The internal copy is sorted ascending by
 *   `startMs` and the cursor walks it front-to-back, so drops — both across
 *   `update` calls and within a single `update` that crosses several timestamps
 *   — are emitted in ascending `startMs` order.
 * - **Ties are stable.** Lines sharing a `startMs` are kept in their original
 *   input order (a stable sort via an index tie-breaker). When that timestamp is
 *   reached they all drop in the same `update`, in that original order.
 *
 * ## Monotonic vs. non-monotonic playback time
 * The design states playback time is monotonic (it comes from the audio clock).
 * This scheduler does not *require* monotonicity for correctness:
 * - If `update` is called with a time LOWER than a previous call (which should
 *   not happen with a real audio clock), the cursor is NOT moved backward and no
 *   already-dropped line is "un-dropped" or re-dropped. Backward time simply
 *   drops nothing new (the lines below the cursor were already dropped; the
 *   lines at/after it still have `startMs` greater than the lower time). The
 *   dropped-once property is permanent.
 * - Forward jumps that skip over several timestamps in one `update` correctly
 *   drop every line whose `startMs` has been reached, in ascending order.
 *
 * ## Allocation behavior
 * The constructor allocates one sorted copy of the line list. After that,
 * {@link update} allocates nothing in the common no-drop tick (it advances an
 * integer cursor and calls the sink); it allocates only what the sink callback
 * itself allocates. Correctness is prioritized over micro-optimization, but the
 * hot path (a tick that drops no line) is allocation-free here.
 */

import type { LyricLine } from '../types/index.js';

/**
 * Sink invoked once per dropped Lyric_Line, in ascending `startMs` order. The
 * host wires this to `GameCore.spawnLine` (design.md "GameCore public surface").
 */
export type LyricDropSink = (line: LyricLine) => void;

export class LyricScheduler {
  /**
   * The lines to schedule, defensively sorted ascending by `startMs` with a
   * STABLE tie-break on original input index. A private copy, so mutating the
   * array passed to the constructor afterwards cannot change scheduling.
   */
  private readonly lines: readonly LyricLine[];

  /** Called once per dropped line, in drop (ascending `startMs`) order. */
  private readonly onDrop: LyricDropSink;

  /**
   * Cursor into {@link lines}: the index of the next line that may drop. Every
   * line at an index `< nextIndex` has already dropped exactly once. This value
   * only ever increases (it is never decremented), which is what makes
   * dropped-once permanent and makes non-monotonic backward time a no-op.
   */
  private nextIndex = 0;

  /**
   * @param lines  The Lyric_Lines to schedule. The input is NOT assumed to be
   *   sorted; the scheduler sorts a private copy ascending by `startMs` (stable
   *   on input order for ties), so callers may pass lines in any order. The LRC
   *   parser already emits ascending lines, but this constructor does not rely
   *   on that.
   * @param onDrop Sink called once per line when its `startMs` is reached,
   *   in ascending `startMs` order. Typically `(line) => gameCore.spawnLine(line)`.
   */
  constructor(lines: readonly LyricLine[], onDrop: LyricDropSink) {
    // Decorate-sort-undecorate with the original index as a tie-breaker so the
    // sort is STABLE for equal `startMs` regardless of the engine's sort, and
    // so we hold our own copy independent of the caller's array.
    this.lines = lines
      .map((line, index) => ({ line, index }))
      .sort((a, b) => a.line.startMs - b.line.startMs || a.index - b.index)
      .map(({ line }) => line);
    this.onDrop = onDrop;
  }

  /**
   * Advance the schedule to `playbackTimeMs`, dropping every not-yet-dropped
   * line whose `startMs <= playbackTimeMs`, in ascending `startMs` order, by
   * calling {@link onDrop} for each (Requirements 6.3, 10.2).
   *
   * Repeated calls, calls with the same time, and calls with a time LOWER than a
   * previous call never re-drop or un-drop a line (see the class "Monotonic vs.
   * non-monotonic" note). A single call may drop multiple lines when it crosses
   * several timestamps; they are dropped in ascending `startMs` order.
   *
   * @param playbackTimeMs Current monotonic audio playback time, in ms.
   */
  update(playbackTimeMs: number): void {
    // Because `lines` is sorted ascending, the first line whose startMs exceeds
    // the supplied time bounds the scan: every later line is also in the future.
    while (this.nextIndex < this.lines.length) {
      const line = this.lines[this.nextIndex]!;
      if (line.startMs > playbackTimeMs) {
        break; // not yet reached — and nothing after it can be either.
      }
      // Reached: advance the cursor BEFORE invoking the sink so that even if the
      // sink throws or itself calls back into the scheduler, the line is already
      // accounted as dropped (dropped-once stays permanent).
      this.nextIndex++;
      this.onDrop(line);
    }
  }

  /**
   * Whether every scheduled line has dropped — i.e. the last Lyric_Line has been
   * reached (Requirement 10.2 "until the last Lyric_Line is reached"). The round
   * lifecycle (task 6.3) uses this to know lyric playback is exhausted. Vacuously
   * `true` when the scheduler was constructed with no lines.
   */
  isComplete(): boolean {
    return this.nextIndex >= this.lines.length;
  }

  /** Count of lines not yet dropped. `0` exactly when {@link isComplete} is true. */
  remaining(): number {
    return this.lines.length - this.nextIndex;
  }

  /** Total number of scheduled lines (constant for the scheduler's lifetime). */
  get total(): number {
    return this.lines.length;
  }

  /** Count of lines dropped so far. */
  get dropped(): number {
    return this.nextIndex;
  }
}
