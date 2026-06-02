import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { GameConfig, LyricLine } from '../types/index.js';
import { GameCore } from './index.js';

/**
 * Property-based test for Solution_Slot ordering (task 4.3).
 *
 * Property 25: Solution-slot sequence matches the correct order.
 * Validates: Requirements 9.1.
 *
 * Design ("Correctness Properties" / Property 25): *For any* dropped Lyric_Line
 * of n tokens, its Solution_Slot indices form the sequence `0..n-1` aligned to
 * the correct order of its Rope_Letters. Requirement 9.1: "THE Game_Server SHALL
 * define a Solution_Slot sequence for each dropped Lyric_Line corresponding to
 * the correct order of its Rope_Letters."
 *
 * The unit under test is the pure {@link GameCore.spawnLine}. Per the impl, a
 * line is tokenized PER WORD as the maximal non-whitespace runs `text.match(/\S+/g)`,
 * one Rope_Letter and one Solution_Slot are produced per token, the letter at
 * correct position `i` carries `correctIndex === i`, and slot `i` is laid out on a
 * single answer row across `config.bounds`:
 *   - `position.x = bounds.x + ((i + 0.5) / n) * bounds.width`  (strictly increasing in `i`, width > 0)
 *   - `position.y = bounds.y + 0.85 * bounds.height`            (identical for every slot → common y)
 *   - `tolerance  = config.placementTolerance`                  (fixed > 0)
 * `spawnLine` fills the caller's `line.solutionSlots` array in place AND stores
 * the SAME array reference under `line.id` (so `getSolutionSlots(line.id)` is the
 * identical array, asserted with `toBe`, matching GameCore.spawn.test.ts).
 *
 * ---------------------------------------------------------------------------
 * Generator design
 * ---------------------------------------------------------------------------
 * We generate arbitrary lyric-line text covering the full token-counting input
 * space, plus an arbitrary 32-bit seed. The token count is computed the SAME way
 * the spec defines it — `n = text.match(/\S+/g)?.length ?? 0` — so the assertions
 * are anchored to the requirement's own definition rather than to the generator.
 *
 * - **Words**: 1..6 char runs drawn from a mixed alphabet of ASCII letters/digits/
 *   punctuation, accented Latin, CJK, Greek, and emoji code points — every member
 *   is a `\S` (non-whitespace) character, so a word never accidentally splits.
 * - **Whitespace**: 1..4 char runs drawn from space, tab, newline, CR, form-feed,
 *   vertical tab, and non-breaking space (all `\s`), so leading/trailing and
 *   multi-character internal whitespace are exercised.
 * - **Structure**: a 0..12 element array freely interleaving word and whitespace
 *   segments, joined. This naturally yields leading/trailing whitespace, runs of
 *   adjacent whitespace, single/multi-word lines, and (via the empty array or an
 *   all-whitespace array) blank / whitespace-only lines. A second branch generates
 *   pure-whitespace/empty strings directly so the `n === 0` case occurs often.
 * - **Seed**: any 32-bit unsigned integer (the PRNG coerces via `>>> 0`).
 *
 * ---------------------------------------------------------------------------
 * Assertions (per generated text + seed)
 * ---------------------------------------------------------------------------
 *  1. ONE SLOT PER LETTER: `line.solutionSlots.length === n === core.letters.length`
 *     (one Solution_Slot per spawned Rope_Letter; 0 for blank/whitespace-only lines).
 *  2. INDEX SEQUENCE 0..n-1 (Req 9.1 / Property 25): the slot `index` values deep-equal
 *     `[0, 1, ..., n-1]` (ascending, contiguous, starting at 0).
 *  3. ALIGNED TO CORRECT ORDER: the letters' `correctIndex` values are exactly the set
 *     `{0..n-1}` with no duplicates — i.e. for each slot `i` there is exactly one letter
 *     with `correctIndex === i`, so slots and letters share one `0..n-1` index space.
 *  4. TOLERANCE: every `slot.tolerance === config.placementTolerance` and is `> 0`.
 *  5. STORED REFERENCE: `core.getSolutionSlots(line.id)` is the SAME array reference as
 *     `line.solutionSlots` (identity, `toBe`).
 *  6. ORDERING OF TARGETS: the answer row is ordered — `slot[i].position.x` is strictly
 *     greater than `slot[i-1].position.x`, and every slot shares a common `position.y`.
 *  7. DETERMINISM: a second `GameCore` with the same seed + config + line yields
 *     deep-equal `solutionSlots`.
 *
 * numRuns is left at the global default (100, from vitest.setup.ts). The concrete
 * examples are pinned by GameCore.spawn.test.ts; this test proves the universal form.
 */

/** A representative fixed config (mirrors GameCore.spawn.test.ts). `placementTolerance` is > 0. */
function makeConfig(): GameConfig {
  return {
    gravity: { x: 0, y: 980 },
    damping: 0.98,
    constraintIterations: 8,
    subSteps: 1,
    defaultStiffness: 0.8,
    constraintTolerance: 0.5,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    restitution: 0.3,
    colliderRadius: 10,
    spawnBand: { x: 0, y: 0, width: 800, height: 120 },
    placementTolerance: 24,
    maxPlayers: 8,
    stepMs: 1000 / 30,
  };
}

/** Build a fresh LyricLine with the empty `solutionSlots` the LRC parser emits. */
function makeLine(id: string, text: string): LyricLine {
  return { id, startMs: 0, text, solutionSlots: [] };
}

// --- Generators --------------------------------------------------------------

/** Non-whitespace code points: ASCII letters/digits/punctuation, accented Latin, CJK, Greek, emoji. */
const WORD_CHARS: readonly string[] = [
  'a', 'b', 'c', 'Z', '0', '1', '9', '!', '?', '.', ',', '-', '_',
  'é', 'ñ', 'ü', '你', '好', 'α', 'β', '🎵', '😀',
];

/** Whitespace characters (all match `\s`): space, tab, newline, CR, form-feed, vertical tab, NBSP. */
const WS_CHARS: readonly string[] = [' ', '\t', '\n', '\r', '\f', '\u000B', '\u00A0'];

/** A 1..6 character non-whitespace word (never splits under `\S+`). */
const wordArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...WORD_CHARS), { minLength: 1, maxLength: 6 })
  .map((cs) => cs.join(''));

/** A 1..4 character whitespace run. */
const wsArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...WS_CHARS), { minLength: 1, maxLength: 4 })
  .map((cs) => cs.join(''));

/** Arbitrary lyric-line text: interleaved words/whitespace, plus blank/whitespace-only/empty. */
const textArb: fc.Arbitrary<string> = fc.oneof(
  // Structured lines: leading/trailing/internal whitespace, single/multi-word, or blank.
  {
    weight: 8,
    arbitrary: fc
      .array(fc.oneof(wordArb, wsArb), { minLength: 0, maxLength: 12 })
      .map((segs) => segs.join('')),
  },
  // Blank / whitespace-only / empty (drives the n === 0 case).
  {
    weight: 2,
    arbitrary: fc
      .array(fc.constantFrom(...WS_CHARS), { minLength: 0, maxLength: 6 })
      .map((cs) => cs.join('')),
  },
);

/** Any 32-bit unsigned seed (the PRNG coerces via `>>> 0`). */
const seedArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 0xffffffff });

/** Count word tokens exactly as Requirement 9.1 / the impl define them. */
function tokenCount(text: string): number {
  return text.match(/\S+/g)?.length ?? 0;
}

describe('Property 25: Solution-slot sequence matches the correct order (Req 9.1)', () => {
  it('generates a 0..n-1 slot sequence, one per rope-letter, aligned to correctIndex', () => {
    fc.assert(
      fc.property(textArb, seedArb, (text, seed) => {
        const config = makeConfig();
        const n = tokenCount(text);

        const core = new GameCore(seed, config);
        const line = makeLine('L', text);
        core.spawnLine(line);

        const slots = line.solutionSlots;

        // (1) ONE SLOT PER LETTER — one Solution_Slot per spawned Rope_Letter (0 for blank).
        expect(slots.length).toBe(n);
        expect(core.letters.length).toBe(n);

        // (2) INDEX SEQUENCE 0..n-1 (Req 9.1 / Property 25): ascending, contiguous, from 0.
        const expectedIndices = Array.from({ length: n }, (_, i) => i);
        expect(slots.map((s) => s.index)).toEqual(expectedIndices);

        // (3) ALIGNED TO CORRECT ORDER: letters' correctIndex set is exactly {0..n-1},
        //     each appearing exactly once (bijection between slots and letters).
        const correctCounts = new Array<number>(n).fill(0);
        for (const letter of core.letters) {
          expect(letter.correctIndex).toBeGreaterThanOrEqual(0);
          expect(letter.correctIndex).toBeLessThan(n);
          // The two asserts above prove 0 <= correctIndex < n, so this indexed
          // access is provably in-bounds (non-null assertion for noUncheckedIndexedAccess).
          correctCounts[letter.correctIndex]! += 1;
        }
        expect(correctCounts).toEqual(new Array<number>(n).fill(1));

        // (4) TOLERANCE: every slot uses the fixed, positive placementTolerance.
        for (const slot of slots) {
          expect(slot.tolerance).toBe(config.placementTolerance);
          expect(slot.tolerance).toBeGreaterThan(0);
        }

        // (5) STORED REFERENCE: the stored sequence is the SAME array reference.
        expect(core.getSolutionSlots(line.id)).toBe(slots);

        // (6) ORDERING OF TARGETS: x strictly increases with index; common y across the row.
        for (let i = 1; i < n; i++) {
          expect(slots[i]!.position.x).toBeGreaterThan(slots[i - 1]!.position.x);
          expect(slots[i]!.position.y).toBe(slots[0]!.position.y);
        }

        // (7) DETERMINISM: same seed + config + line ⇒ deep-equal slot sequence.
        const core2 = new GameCore(seed, makeConfig());
        const line2 = makeLine('L', text);
        core2.spawnLine(line2);
        expect(line2.solutionSlots).toEqual(slots);
      }),
    );
  });
});
