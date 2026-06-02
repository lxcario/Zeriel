import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { buildJoinLink, parseJoinLink, parseJoinLinkResult } from './joinLink.ts';

/**
 * Property-based test for the join-link round trip (task 16.8).
 *
 * Property 2: Join-link round trip.
 * **Validates: Requirements 1.2**
 *
 * Design ("Correctness Properties" / Property 2): *For any* Room_Code, parsing
 * the join link built from that code yields back the original Room_Code.
 *
 * Strategy: `design.md` describes `RoomCode` as "short, URL-safe,
 * collision-checked on creation", but the implementation embeds the code via
 * `URLSearchParams` (`?room=CODE`), which percent-encodes/decodes losslessly
 * for ANY string value — not just URL-safe ones. So we deliberately generate a
 * BROAD input space far beyond well-formed Room_Codes (plain text, web-segment
 * shapes, Unicode, spaces, and URL-significant characters such as `& = % ? # /`
 * and emoji) to stress the round trip. If any non-empty code fails to round
 * trip, that is a genuine losslessness bug in the embedding scheme.
 *
 * Empty-string exclusion: `parseJoinLink` documents that an absent OR EMPTY
 * `room` parameter yields `null` ("no code"), because an empty string is not a
 * valid (collision-checked, URL-safe) Room_Code. The round-trip guarantee
 * therefore covers all NON-EMPTY codes; we filter out `''` so we never assert
 * the round trip on a value the parser is specified to reject by design.
 *
 * numRuns is left at the global default (100, from `vitest.setup.ts`); we do
 * not weaken it. The existing `joinLink.test.ts` pins concrete examples and the
 * empty-param / unparseable-URL behavior; this file proves the universal
 * round-trip invariant across the whole non-empty input space.
 */

// --- Generator: a broad set of non-empty candidate Room_Code strings --------

/** Strings rich in URL-significant characters that must survive encoding. */
const urlSignificantArb: fc.Arbitrary<string> = fc.string({
  // fast-check v4 takes a per-character `unit` arbitrary (the v3 `stringOf`
  // helper was removed).
  unit: fc.constantFrom(
    'a', 'Z', '0', '9', '-', '_', // ordinary URL-safe code characters
    ' ', '&', '=', '%', '?', '#', '/', '+', // URL-significant / reserved
    '日', '本', '語', '🎤', '🎶', // multi-byte Unicode + emoji
  ),
  minLength: 1,
  maxLength: 32,
});

/** Union of generators spanning plain text, web-segment shapes, and the above. */
const roomCodeArb: fc.Arbitrary<string> = fc
  .oneof(
    fc.string(),
    fc.webSegment(),
    // `{ unit: 'grapheme' }` is the v4 replacement for `fullUnicodeString`: it
    // emits full-Unicode strings including multi-code-point graphemes (emoji).
    fc.string({ unit: 'grapheme' }),
    urlSignificantArb,
  )
  // Exclude the empty string: the parser treats an empty `room` param as "no
  // code" (=> null) by design, so it is out of scope for the round trip.
  .filter((code) => code.length > 0);

// --- Property 2 -------------------------------------------------------------

describe('Property 2: Join-link round trip (Requirement 1.2)', () => {
  it('round trips any non-empty code through an explicit base URL', () => {
    fc.assert(
      fc.property(roomCodeArb, (code) => {
        expect(parseJoinLink(buildJoinLink(code, 'https://glitch.example/'))).toBe(code);
      }),
    );
  });

  it('round trips any non-empty code through the default base', () => {
    fc.assert(
      fc.property(roomCodeArb, (code) => {
        expect(parseJoinLink(buildJoinLink(code))).toBe(code);
      }),
    );
  });

  it('yields a matching ok JoinLinkResult for any non-empty code', () => {
    fc.assert(
      fc.property(roomCodeArb, (code) => {
        expect(parseJoinLinkResult(buildJoinLink(code, 'https://glitch.example/'))).toEqual({
          ok: true,
          roomCode: code,
        });
      }),
    );
  });
});
