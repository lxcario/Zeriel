import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { isWhitespaceToken, splitIntoWords } from './splitWords.ts';

/**
 * Property-based test for lossless ScrollReveal word splitting (task 11.2).
 *
 * Property 43: ScrollReveal word splitting is lossless.
 * **Validates: Requirements 19.1**
 *
 * Design ("Correctness Properties" / Property 43): *For any* input string, the
 * ScrollReveal split produces exactly one span per word and rejoining the spans
 * reproduces the original sequence of words. Requirement 19.1 states the
 * Scroll_Reveal_Animation "splits a string child into one span per word".
 *
 * The pure target ({@link splitIntoWords}) tokenizes with `/\s+|\S+/g`, yielding
 * MAXIMAL alternating runs of non-whitespace (WORD) and whitespace tokens that
 * cover every character exactly once, so `splitIntoWords(s).join('') === s` for
 * every string (empty string -> [], whose join is ''). The non-whitespace
 * tokens are the WORDS rendered one `<span>` each; whitespace tokens preserve
 * layout. {@link isWhitespaceToken} matches `/^\s+$/`.
 *
 * Strategy — we generate a BROAD input space so losslessness and the "one span
 * per word" count are exercised against arbitrary text, full Unicode, and (most
 * importantly for this tokenizer) every flavour of whitespace JavaScript's `\s`
 * recognizes:
 *   - `fc.string()` — arbitrary ASCII-ish strings (incl. control chars).
 *   - `fc.string({ unit: 'grapheme' })` — full Unicode including multi-code-point
 *     graphemes / emoji (the v4 replacement for `fullUnicodeString`).
 *   - a whitespace-saturated generator whose per-character `unit` interleaves a
 *     rich variety of whitespace — regular space, tab `\t`, newline `\n`,
 *     carriage return `\r`, NO-BREAK SPACE `\u00A0`, and IDEOGRAPHIC SPACE
 *     `\u3000` (both matched by `\s`) — with ordinary and Unicode word chars, so
 *     adjacent/leading/trailing/mixed whitespace runs are stressed.
 *   - explicit `''` and whitespace-only strings as fixed edge cases.
 *
 * numRuns is left at the global default (100, from `vitest.setup.ts`); it is not
 * weakened. If a counterexample reveals lossiness, the LOSSLESSNESS assertion
 * fails and the run stops with the shrunk counterexample.
 */

// --- Generators -------------------------------------------------------------

/**
 * A string saturated with whitespace VARIETY interleaved with word characters.
 * The per-character `unit` mixes the six whitespace forms called out by the
 * design/task with ordinary, Unicode, and emoji word chars, so runs of one or
 * more heterogeneous whitespace characters butt up against words in every
 * arrangement (leading, trailing, interior, repeated, mixed kinds).
 */
const whitespaceVarietyArb: fc.Arbitrary<string> = fc.string({
  unit: fc.constantFrom(
    // whitespace variety (all matched by JS regex `\s`)
    ' ', // U+0020 space
    '\t', // U+0009 tab
    '\n', // U+000A line feed
    '\r', // U+000D carriage return
    '\u00A0', // no-break space
    '\u3000', // ideographic space
    // word characters interleaved with the whitespace
    'a', 'Z', '0', '9', '-', '日', '🎤', '🎶',
  ),
  minLength: 0,
  maxLength: 40,
});

/** Whitespace-ONLY strings (every char is `\s`), incl. the heterogeneous kinds. */
const whitespaceOnlyArb: fc.Arbitrary<string> = fc.string({
  unit: fc.constantFrom(' ', '\t', '\n', '\r', '\u00A0', '\u3000'),
  minLength: 1,
  maxLength: 16,
});

/** Broad union covering arbitrary text, full Unicode, whitespace variety, and edges. */
const textArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.string({ unit: 'grapheme' }),
  whitespaceVarietyArb,
  whitespaceOnlyArb,
  fc.constantFrom('', ' ', '   ', '\t\n', '\u00A0\u3000'),
);

// --- Property 43 ------------------------------------------------------------

describe('Property 43: ScrollReveal word splitting is lossless (Requirement 19.1)', () => {
  it('rejoining the tokens reproduces the original string exactly (lossless)', () => {
    fc.assert(
      fc.property(textArb, (s) => {
        // The core property: covers every character exactly once. Empty string
        // yields [] whose join is '' === s.
        expect(splitIntoWords(s).join('')).toBe(s);
      }),
    );
  });

  it('tokens are non-empty and strictly alternate whitespace / non-whitespace runs', () => {
    fc.assert(
      fc.property(textArb, (s) => {
        const tokens = splitIntoWords(s);
        for (let k = 0; k < tokens.length; k += 1) {
          const token = tokens[k];
          if (token === undefined) continue;
          // No empty tokens are ever produced.
          expect(token.length).toBeGreaterThan(0);
          // Maximal runs => adjacent tokens differ in whitespace-ness.
          const next = tokens[k + 1];
          if (next !== undefined) {
            expect(isWhitespaceToken(token)).not.toBe(isWhitespaceToken(next));
          }
        }
      }),
    );
  });

  it('the number of word (non-whitespace) tokens equals the count of maximal \\S+ runs', () => {
    fc.assert(
      fc.property(textArb, (s) => {
        const tokens = splitIntoWords(s);
        const wordTokenCount = tokens.filter((t) => !isWhitespaceToken(t)).length;
        // "One span per word" (19.1): word tokens line up 1:1 with \S+ runs.
        const expectedWordCount = s.match(/\S+/g)?.length ?? 0;
        expect(wordTokenCount).toBe(expectedWordCount);
      }),
    );
  });

  it('each token is homogeneous: word tokens have no whitespace, whitespace tokens are all whitespace', () => {
    fc.assert(
      fc.property(textArb, (s) => {
        for (const token of splitIntoWords(s)) {
          if (isWhitespaceToken(token)) {
            // Whitespace token: entirely whitespace.
            expect(/^\s+$/.test(token)).toBe(true);
          } else {
            // Word token: contains no whitespace at all.
            expect(/\s/.test(token)).toBe(false);
          }
        }
      }),
    );
  });
});
