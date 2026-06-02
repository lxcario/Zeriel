import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { parseLrc } from './lyricsService.ts';
import type { LyricLine } from '@glitch/core';

/**
 * Property-based test for the LRC parser (task 2.8).
 *
 * Property 15: LRC parse round trip and ordering.
 * **Validates: Requirements 6.2**
 *
 * Design ("Correctness Properties" / Property 15): *For any* ordered set of
 * timed lyric lines, formatting them to LRC text and parsing the result yields
 * an equivalent set of Lyric_Lines (matching start timestamps and text) sorted
 * by ascending start time. Requirement 6.2: "WHEN LRCLIB returns synced
 * lyrics, THE Lyrics_Service SHALL parse the response into an ordered set of
 * Lyric_Lines, each with a start timestamp and text."
 *
 * Strategy — GENERATE → FORMAT → PARSE → ASSERT
 * --------------------------------------------------------------------------
 * Rather than generating raw LRC text (which would force the test to re-derive
 * the parser's own drop/round rules), we generate a clean MODEL of timed lines,
 * render them to canonical LRC, parse that, and check the parse reproduces the
 * model. This keeps the oracle independent of the implementation.
 *
 * 1. GENERATE a list of entries `{ ms, text, sortKey }`:
 *    - `ms`   — generated as `n * 10` for an integer `n` in `0..599_999`, i.e.
 *      an integer in `0..5_999_990` that is ALWAYS A MULTIPLE OF 10. This is
 *      the centisecond-alignment trick (see FORMAT below): it makes the
 *      round trip exact even though we format at 2-digit (centisecond)
 *      precision. With this range minutes land in `0..99` (two digits).
 *    - `text` — a non-empty (after trim) string containing NO `[`/`]` (so it
 *      cannot introduce spurious timestamp tags) and no `\r`/`\n` (so it cannot
 *      introduce extra lines). We compare against `text.trim()` because the
 *      parser trims, so leading/trailing whitespace is intentionally allowed in
 *      the generator and normalized on both sides of the comparison.
 *    - `sortKey` — a throwaway key used only to SHUFFLE the formatted lines
 *      into a random order before parsing, so we exercise the parser's sort
 *      rather than feeding it pre-sorted input.
 *
 * 2. FORMAT each entry to a canonical line `[mm:ss.cc] text` at CENTISECOND
 *    precision (2-digit fraction). The parser reads a 2-digit fraction as
 *    centiseconds (`×10` ms). Because `ms` is a multiple of 10, `ms / 10` is an
 *    integer and `cc = (ms % 1000) / 10` is exact, so FORMAT then PARSE is
 *    lossless: `parse(format(ms)) === ms`. Minutes are padded to at least two
 *    digits (`\d+` in the parser allows more); here they never exceed 99.
 *
 * 3. PARSE the lines joined (in shuffled order) with `\n`.
 *
 * 4. ASSERT ordering, round-trip multiset equality, id sequence, and slots.
 *
 * numRuns is left at the global default (100, from `vitest.setup.ts`); it is
 * not weakened. Deterministic examples below additionally pin the multi-tag
 * expansion and the malformed/empty-line drop rules.
 */

// --- Generators -------------------------------------------------------------

/**
 * Characters that are safe inside lyric text: they never contain `[` or `]`
 * (which would create spurious timestamp tags) nor `\r`/`\n` (which would split
 * the line). Spaces and `:`/`.` are included on purpose — `:`/`.` are only
 * meaningful to the parser INSIDE brackets, so as bare text they must survive
 * untouched. A few multi-code-unit graphemes stress non-ASCII handling.
 */
const textCharArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(''),
  ),
  fc.constantFrom(' ', '.', ':', ',', '!', '?', "'", '"', '-', '_', '(', ')', '/'),
  fc.constantFrom('é', 'ñ', 'ü', '日', '本', '語', '🎤', '🎶'),
);

/** Non-empty-after-trim lyric text with no bracket/newline characters. */
const textArb: fc.Arbitrary<string> = fc
  .string({ unit: textCharArb, minLength: 1, maxLength: 24 })
  .filter((t) => t.trim().length > 0);

interface Entry {
  /** Start time in ms, always a multiple of 10 (centisecond-aligned). */
  ms: number;
  /** Raw line text (compared against its trimmed form). */
  text: string;
  /** Throwaway key used only to shuffle the formatted lines. */
  sortKey: number;
}

const entryArb: fc.Arbitrary<Entry> = fc.record({
  // n in 0..599_999 → ms = n*10 in 0..5_999_990, always a multiple of 10.
  ms: fc.integer({ min: 0, max: 599_999 }).map((n) => n * 10),
  text: textArb,
  sortKey: fc.double({ min: 0, max: 1, noNaN: true }),
});

const entriesArb: fc.Arbitrary<Entry[]> = fc.array(entryArb, { maxLength: 30 });

// --- Formatting (the centisecond-aligned canonical LRC line) ----------------

/**
 * Render `ms` (a multiple of 10) and `text` to a canonical `[mm:ss.cc] text`
 * LRC line at centisecond precision. Lossless under the generator because
 * `ms % 1000` is always a multiple of 10, so `cc` carries no rounding error.
 */
function formatLrcLine(ms: number, text: string): string {
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  const centiseconds = Math.floor((ms % 1_000) / 10);
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  const cc = String(centiseconds).padStart(2, '0');
  return `[${mm}:${ss}.${cc}] ${text}`;
}

// --- Helpers for assertions -------------------------------------------------

interface Pair {
  ms: number;
  text: string;
}

/** Canonicalize a multiset of (ms, text) pairs by sorting, so ties/order don't matter. */
function sortPairs(pairs: Pair[]): Pair[] {
  return [...pairs].sort((a, b) => a.ms - b.ms || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
}

// --- Property 15 ------------------------------------------------------------

describe('Property 15: LRC parse round trip and ordering (Requirement 6.2)', () => {
  it('parses canonical LRC back to the generated lines, sorted ascending', () => {
    fc.assert(
      fc.property(entriesArb, (entries) => {
        // Shuffle the formatted lines so the parser must do the sorting.
        const lrc = [...entries]
          .sort((a, b) => a.sortKey - b.sortKey)
          .map((e) => formatLrcLine(e.ms, e.text))
          .join('\n');

        const lines: LyricLine[] = parseLrc(lrc);

        // (1) Ordering: startMs is non-decreasing (Requirement 6.2 "ordered set").
        for (let i = 1; i < lines.length; i += 1) {
          expect(lines[i]!.startMs).toBeGreaterThanOrEqual(lines[i - 1]!.startMs);
        }

        // (2) Round trip: the multiset of (startMs, text) returned equals the
        //     multiset of (ms, trimmed text) generated — nothing lost, nothing
        //     invented. Sorted-pair comparison is robust to ties/order.
        const expected = sortPairs(entries.map((e) => ({ ms: e.ms, text: e.text.trim() })));
        const actual = sortPairs(lines.map((l) => ({ ms: l.startMs, text: l.text })));
        expect(actual).toEqual(expected);

        // (3) ids: each output line id is `line-{indexInSortedOutput}`.
        lines.forEach((line, index) => {
          expect(line.id).toBe(`line-${index}`);
        });

        // (4) solutionSlots: always the empty array (filled later at spawn time).
        for (const line of lines) {
          expect(line.solutionSlots).toEqual([]);
        }
      }),
    );
  });
});

// --- Targeted deterministic sub-properties (multi-tag + dropped lines) ------

describe('parseLrc — multi-tag expansion and malformed/empty drops', () => {
  it('(a) expands a multi-tag line into one entry per tag, sharing the text', () => {
    const lines = parseLrc('[00:01.00][00:02.00] hello');

    expect(lines).toHaveLength(2);
    expect(lines.map((l) => ({ startMs: l.startMs, text: l.text }))).toEqual([
      { startMs: 1_000, text: 'hello' },
      { startMs: 2_000, text: 'hello' },
    ]);
    expect(lines.map((l) => l.id)).toEqual(['line-0', 'line-1']);
  });

  it('(b) drops lines with no tag, tag-only lines, and metadata tags', () => {
    const lrc = [
      'this line has no timestamp tag', // no tag → dropped
      '[00:03.00]   ', // tag only / empty after trim → dropped
      '[00:03.00]', // bare timestamp marker → dropped
      '[ti:Title]', // metadata tag (not mm:ss) → dropped
      '[00:01.00][00:02.00] hello', // multi-tag → 2 entries
      '[00:00.50] first', // centiseconds 50 → 500ms
    ].join('\n');

    const lines = parseLrc(lrc);

    // Only the two real lyric lines survive, sorted ascending by start time.
    expect(lines.map((l) => ({ id: l.id, startMs: l.startMs, text: l.text }))).toEqual([
      { id: 'line-0', startMs: 500, text: 'first' },
      { id: 'line-1', startMs: 1_000, text: 'hello' },
      { id: 'line-2', startMs: 2_000, text: 'hello' },
    ]);
  });
});
