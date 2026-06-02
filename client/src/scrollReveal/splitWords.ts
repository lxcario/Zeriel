/**
 * Lossless word tokenization for the Scroll_Reveal_Animation (task 11.1).
 *
 * Design references:
 * - Requirement 19.1: the Scroll_Reveal_Animation splits a STRING child into
 *   one span per WORD.
 * - design.md "Correctness Properties" Property 43 ("ScrollReveal word
 *   splitting is lossless"): for any input string, the split produces exactly
 *   one span per word and the parts can be rejoined to reproduce the original.
 *
 * This module is intentionally PURE (no DOM, no React, no GSAP) so it is the
 * direct target of the optional Property 43 test (task 11.2) and can be unit-
 * tested in a plain `node` environment without jsdom.
 *
 * ## Tokenization scheme (and its losslessness guarantee)
 *
 * {@link splitIntoWords} returns an ordered array of tokens where every token
 * is either:
 *   - a maximal run of NON-whitespace characters (a "word" token), or
 *   - a maximal run of whitespace characters (a "whitespace" token).
 *
 * The two kinds strictly alternate and cover every character of the input
 * exactly once, in order. Therefore the tokenization is **lossless** in the
 * strongest sense:
 *
 * ```ts
 * splitIntoWords(text).join('') === text   // for every string `text`
 * ```
 *
 * A naive `text.split(' ')` + single-space `join(' ')` is NOT lossless for
 * arbitrary whitespace (tabs, newlines, repeated spaces, leading/trailing
 * spaces), so this scheme keeps the whitespace runs as their own tokens instead
 * of discarding them. The consumer renders each WORD token as one `<span>`
 * (Requirement 19.1) and renders WHITESPACE tokens verbatim so the original
 * visual layout is preserved.
 *
 * The number of WORD tokens equals the number of words in the input, which is
 * what makes "exactly one span per word" hold.
 */

/**
 * Matches a maximal run of whitespace (`\s+`) OR a maximal run of
 * non-whitespace (`\S+`). Because every character is either whitespace or not,
 * scanning the string with this alternation yields contiguous, non-overlapping
 * tokens that together cover the whole input — the basis of the losslessness
 * guarantee documented above.
 */
const TOKEN_RE = /\s+|\S+/g;

/**
 * Matches a token that is entirely whitespace. Tokens produced by
 * {@link splitIntoWords} are homogeneous (all whitespace or all non-whitespace)
 * and never empty, so this reliably distinguishes whitespace tokens from word
 * tokens.
 */
const WHITESPACE_TOKEN_RE = /^\s+$/;

/**
 * Split a string into an ordered, lossless list of word and whitespace tokens.
 *
 * Joining the returned tokens with the empty string reproduces the input
 * exactly: `splitIntoWords(text).join('') === text`. The non-whitespace tokens
 * are the WORDS (one `<span>` each, Requirement 19.1); the whitespace tokens
 * preserve the original spacing for layout.
 *
 * @param text - The string child to tokenize.
 * @returns The tokens in input order. An empty string yields an empty array
 *   (whose join is `''`, still lossless).
 */
export function splitIntoWords(text: string): string[] {
  const tokens = text.match(TOKEN_RE);
  return tokens === null ? [] : tokens;
}

/**
 * Report whether a token produced by {@link splitIntoWords} is a whitespace
 * run (rendered verbatim) rather than a WORD (rendered as a `<span>`).
 *
 * @param token - A token from {@link splitIntoWords}.
 * @returns `true` when the token is entirely whitespace.
 */
export function isWhitespaceToken(token: string): boolean {
  return WHITESPACE_TOKEN_RE.test(token);
}
