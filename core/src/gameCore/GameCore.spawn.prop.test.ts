import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { GameConfig, LyricLine } from '../types/index.js';
import { GameCore } from './index.js';

/**
 * Property-based test for per-token spawning (task 4.2).
 *
 * Property 17: One rope-letter spawned per token at the top of the play area.
 * **Validates: Requirements 7.1**
 *
 * Design ("Correctness Properties" / Property 17): *For any* Lyric_Line, dropping
 * it spawns exactly one Rope_Letter per letter/word token, and every spawned
 * Rope_Letter's initial particle positions lie within the top spawn band of the
 * play area. Requirement 7.1: "WHEN a Lyric_Line drops, THE Physics_Engine SHALL
 * spawn a Rope_Letter for each letter or word in the Lyric_Line at the top of the
 * play area."
 *
 * ---------------------------------------------------------------------------
 * Token granularity + oracle (per-WORD, documented in GameCore.ts)
 * ---------------------------------------------------------------------------
 * Requirement 7.1 permits either letters OR words; `GameCore.spawnLine` tokenizes
 * per WORD — maximal runs of non-whitespace characters, whitespace excluded (see
 * the "Tokenization" note in GameCore.ts). The independent ORACLE for the token
 * sequence is therefore the same maximal-`\S+`-run extraction:
 *
 *     const tokens = text.match(/\S+/g) ?? [];
 *
 * `tokens.length` is the expected rope-letter count (0 for blank/whitespace-only
 * lines) and `tokens` (in order) is the expected glyph sequence. This oracle is
 * computed directly from the raw text and never from the implementation, so it is
 * a genuine cross-check rather than a restatement.
 *
 * ---------------------------------------------------------------------------
 * Generators — broad input space (task 4.2)
 * ---------------------------------------------------------------------------
 * We exercise the tokenizer against a wide variety of line text:
 *   - `structuredLineArb`: the realistic case — 0..6 WORDS (non-whitespace runs of
 *     letters/digits/punctuation/Unicode/emoji) joined by arbitrary whitespace
 *     runs (space, tab, `\n`, `\r`, NO-BREAK SPACE `\u00A0`, IDEOGRAPHIC SPACE
 *     `\u3000` — all matched by JS `\s`), with optional leading/trailing
 *     whitespace. Because each generated word is purely non-whitespace and words
 *     are separated by >= 1 whitespace char, the constructed string's `\S+` runs
 *     are exactly the generated words, so this reliably stresses multi-word lines,
 *     irregular/leading/trailing spacing, and the per-token placement clamps.
 *   - `rawTextArb`: adversarial raw text — `fc.string()` (incl. control chars),
 *     `fc.string({ unit: 'grapheme' })` (full Unicode incl. multi-code-point
 *     graphemes / emoji), whitespace-only strings, and explicit edge constants
 *     (`''`, single/multiple spaces, mixed whitespace). These rarely form multiple
 *     words but stress empty/blank lines and odd Unicode.
 * The seed is an arbitrary `fc.integer()` (mulberry32 coerces via `>>> 0`, so any
 * finite integer is a valid seed) to prove the assertions hold regardless of the
 * deterministic spawn jitter.
 *
 * numRuns is left at the global default (100, from `vitest.setup.ts`); it is not
 * weakened. If a counterexample reveals a real spawn bug (wrong count/glyphs or an
 * out-of-band particle), the failing assertion stops the run with the shrunk
 * counterexample.
 */

// --- Fixed representative config (mirrors GameCore.spawn.test.ts) ------------

/** A representative config; spawnBand is the TOP band of the play-area bounds. */
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

/** The independent per-word token oracle (maximal non-whitespace runs). */
function tokenOracle(text: string): string[] {
  return text.match(/\S+/g) ?? [];
}

// --- Generators -------------------------------------------------------------

/** Non-whitespace characters spanning letters, digits, punctuation, Unicode, emoji. */
const wordCharArb = fc.constantFrom(
  'a', 'B', 'z', 'Q', '0', '7', '9',
  '-', '_', '.', '!', '?', ',', ';', ':', '#', '@', '/', '(', ')', '[', ']', "'",
  '日', '本', 'é', 'ñ', 'Ω', '𝟙',
  '🎤', '🎶', '😀',
);

/** One WORD: a non-empty string of strictly non-whitespace characters. */
const wordArb: fc.Arbitrary<string> = fc.string({
  unit: wordCharArb,
  minLength: 1,
  maxLength: 8,
});

/** A non-empty run of varied whitespace (all forms matched by JS `\s`). */
const wsRunArb: fc.Arbitrary<string> = fc.string({
  unit: fc.constantFrom(' ', '\t', '\n', '\r', '\u00A0', '\u3000'),
  minLength: 1,
  maxLength: 4,
});

/**
 * A realistic lyric line: 0..6 words joined by arbitrary whitespace runs, with
 * optional leading/trailing whitespace. The `\S+` runs of the result equal
 * `words` exactly (words are non-whitespace; gaps are >= 1 whitespace char).
 */
const structuredLineArb: fc.Arbitrary<string> = fc
  .record({
    words: fc.array(wordArb, { minLength: 0, maxLength: 6 }),
    seps: fc.array(wsRunArb, { minLength: 1, maxLength: 6 }),
    leading: fc.option(wsRunArb, { nil: '' }),
    trailing: fc.option(wsRunArb, { nil: '' }),
  })
  .map(({ words, seps, leading, trailing }) => {
    let s = leading;
    words.forEach((w, i) => {
      s += w;
      if (i < words.length - 1) s += seps[i % seps.length] ?? ' ';
    });
    return s + trailing;
  });

/** Adversarial raw text + blank/whitespace-only edges. */
const rawTextArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.string({ unit: 'grapheme' }),
  fc.string({
    unit: fc.constantFrom(' ', '\t', '\n', '\r', '\u00A0', '\u3000'),
    minLength: 1,
    maxLength: 12,
  }),
  fc.constantFrom('', ' ', '   ', '\t\n', '\u00A0\u3000', 'oneword'),
);

/** Broad union driving every assertion below. */
const lineTextArb: fc.Arbitrary<string> = fc.oneof(structuredLineArb, rawTextArb);

const seedArb = fc.integer();

// --- Property 17 ------------------------------------------------------------

describe('Property 17: One rope-letter per token at the top of the play area (Req 7.1)', () => {
  it('spawns exactly one rope-letter per word token (count matches the \\S+ oracle)', () => {
    fc.assert(
      fc.property(seedArb, lineTextArb, (seed, text) => {
        const core = new GameCore(seed, makeConfig());
        core.spawnLine(makeLine('L', text));
        // COUNT (Req 7.1): one rope-letter per word token; zero for blank lines.
        expect(core.letters.length).toBe(tokenOracle(text).length);
      }),
    );
  });

  it("each rope-letter's glyph equals the matching token, in order", () => {
    fc.assert(
      fc.property(seedArb, lineTextArb, (seed, text) => {
        const core = new GameCore(seed, makeConfig());
        core.spawnLine(makeLine('L', text));
        // GLYPHS: the spawned glyphs are exactly the tokens in order.
        expect(core.letters.map((l) => l.glyph)).toEqual(tokenOracle(text));
      }),
    );
  });

  it('places every particle of every spawned letter within the top spawn band', () => {
    const config = makeConfig();
    const band = config.spawnBand;
    // Document "top of the play area": the spawn band sits at the top of bounds.
    expect(band.y).toBe(config.bounds.y);

    fc.assert(
      fc.property(seedArb, lineTextArb, (seed, text) => {
        const core = new GameCore(seed, config);
        core.spawnLine(makeLine('L', text));
        for (const letter of core.letters) {
          for (const p of letter.particles) {
            // TOP OF PLAY AREA (Req 7.1): in-band vertically AND horizontally.
            expect(p.x.y).toBeGreaterThanOrEqual(band.y);
            expect(p.x.y).toBeLessThanOrEqual(band.y + band.height);
            expect(p.x.x).toBeGreaterThanOrEqual(band.x);
            expect(p.x.x).toBeLessThanOrEqual(band.x + band.width);
          }
        }
      }),
    );
  });

  it('assigns correctIndex 0..n-1 in order, with null owner and null placedSlot', () => {
    fc.assert(
      fc.property(seedArb, lineTextArb, (seed, text) => {
        const core = new GameCore(seed, makeConfig());
        core.spawnLine(makeLine('L', text));
        core.letters.forEach((l, i) => {
          expect(l.correctIndex).toBe(i);
          expect(l.ownerId).toBeNull();
          expect(l.placedSlot).toBeNull();
        });
      }),
    );
  });

  it('is deterministic: same seed + config + line yields deep-equal letters', () => {
    fc.assert(
      fc.property(seedArb, lineTextArb, (seed, text) => {
        const a = new GameCore(seed, makeConfig());
        const b = new GameCore(seed, makeConfig());
        a.spawnLine(makeLine('L', text));
        b.spawnLine(makeLine('L', text));
        // DETERMINISM: identical positions and spawn-jitter seeds.
        expect(a.letters).toEqual(b.letters);
      }),
    );
  });
});
