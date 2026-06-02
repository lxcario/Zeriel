import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { TrackSignature } from '@glitch/core';
import { buildGetUrl, DEFAULT_LRCLIB_BASE_URL } from './lyricsService.ts';

/**
 * Property-based test for LRCLIB signature encoding (task 2.7).
 *
 * Property 14: LRCLIB request encodes the track signature.
 * **Validates: Requirements 6.1**
 *
 * Design ("Correctness Properties" / Property 14): *For any* track signature,
 * the LRCLIB request URL encodes the track name, artist name, album name, and
 * duration as query parameters that decode back to the original signature
 * values.
 *
 * Design ("External Service Interfaces — Lyrics_Service (LRCLIB)"): the request
 * is `GET {LRCLIB}/api/get?track_name=&artist_name=&album_name=&duration=`
 * (Requirement 6.1), and `buildGetUrl` adds all four fields through
 * `URLSearchParams` so every value is percent-encoded regardless of spaces or
 * punctuation in the names.
 *
 * Strategy
 * --------
 * The encode is proven LOSSLESS by a WHATWG round trip: build the URL with
 * `buildGetUrl(base, sig)`, re-parse it with `new URL(...)`, and assert each
 * query parameter decodes back to the exact signature value. URL-significant
 * characters (space, `&`, `=`, `?`, `#`, `%`, `+`, `/`) and emoji are the whole
 * point — `application/x-www-form-urlencoded` maps space -> `+` and `+` ->
 * `%2B` on the way out and reverses it on the way back, so a passing round trip
 * proves those transforms cancel.
 *
 * Generators
 * ----------
 * - track/artist/album names: a broad string space (default `fc.string`,
 *   full-Unicode graphemes incl. emoji, and a unit string saturated with
 *   URL-significant characters). EMPTY STRINGS ARE INCLUDED (not filtered):
 *   `track_name=` is a legal, expected encoding and must round trip to `''`.
 *   We mirror the proven-safe generators from `joinLink.prop.test.ts`, which
 *   avoid lone surrogates (those would be coerced to U+FFFD by URL encoding and
 *   are not part of a real track signature).
 * - durationSec: `TrackSignature.durationSec` is typed `number` and carries the
 *   Piped track duration in seconds (a whole-second count). We generate
 *   NON-NEGATIVE INTEGERS via `fc.nat()` for cleanliness: `String(n)` is then
 *   canonical and unambiguous. The assertion compares against
 *   `String(sig.durationSec)`, so any finite double would round trip identically
 *   (the param is just its string form); integers fully exercise the contract
 *   without depending on float-to-string formatting.
 *
 * numRuns is left at the global default (100, from `vitest.setup.ts`); it is
 * not weakened. `lyricsService.ts` is also exercised elsewhere; this file only
 * imports the pure `buildGetUrl` and does no network/DOM work.
 */

// --- Generators -------------------------------------------------------------

/** A string unit saturated with URL-significant characters, Unicode, and emoji. */
const urlSignificantText: fc.Arbitrary<string> = fc.string({
  unit: fc.constantFrom(
    'a', 'Z', '0', '9', '-', '_', '.', // ordinary
    ' ', '&', '=', '%', '?', '#', '/', '+', // URL-significant / reserved
    '日', '本', '語', '🎤', '🎶', '🎸', // multi-byte Unicode + emoji
  ),
  minLength: 0,
  maxLength: 48,
});

/**
 * A broad text-field generator (track/artist/album). The empty string is
 * intentionally reachable so the `track_name=` (empty value) case is covered.
 */
const textFieldArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  // `{ unit: 'grapheme' }` emits well-formed full-Unicode strings, including
  // multi-code-point graphemes (emoji), with no lone surrogates.
  fc.string({ unit: 'grapheme' }),
  urlSignificantText,
);

/**
 * Track signature generator. `durationSec` is a non-negative integer (seconds),
 * matching how the resolved Piped duration is forwarded to LRCLIB.
 */
const trackSignatureArb: fc.Arbitrary<TrackSignature> = fc.record({
  trackName: textFieldArb,
  artistName: textFieldArb,
  albumName: textFieldArb,
  durationSec: fc.nat(),
});

/** Base origins that should all resolve the path to end with `/api/get`. */
const baseArb: fc.Arbitrary<string> = fc.constantFrom(
  DEFAULT_LRCLIB_BASE_URL, // 'https://lrclib.net'
  `${DEFAULT_LRCLIB_BASE_URL}/`, // trailing slash (joinUrl strips it)
  `${DEFAULT_LRCLIB_BASE_URL}///`, // several trailing slashes
  'https://mirror.example.org', // a different origin
  'https://mirror.example.org/lrclib', // a base WITH a path segment
);

/** Assert all four signature fields decode back to their exact values. */
function expectSignatureRoundTrip(url: string, sig: TrackSignature): void {
  const parsed = new URL(url);
  expect(parsed.searchParams.get('track_name')).toBe(sig.trackName);
  expect(parsed.searchParams.get('artist_name')).toBe(sig.artistName);
  expect(parsed.searchParams.get('album_name')).toBe(sig.albumName);
  expect(parsed.searchParams.get('duration')).toBe(String(sig.durationSec));
}

// --- Property 14 ------------------------------------------------------------

describe('Property 14: LRCLIB request encodes the track signature (Requirement 6.1)', () => {
  it('round trips every signature field through the default LRCLIB base', () => {
    fc.assert(
      fc.property(trackSignatureArb, (sig) => {
        const url = buildGetUrl(DEFAULT_LRCLIB_BASE_URL, sig);

        // The URL is absolute and parseable on the expected endpoint.
        const parsed = new URL(url);
        expect(parsed.protocol).toBe('https:');
        expect(parsed.pathname).toBe('/api/get');

        // All four signature values survive the encode -> parse round trip.
        expectSignatureRoundTrip(url, sig);
      }),
    );
  });

  it('round trips every signature field across base shapes (trailing slash, sub-path)', () => {
    fc.assert(
      fc.property(baseArb, trackSignatureArb, (base, sig) => {
        const url = buildGetUrl(base, sig);

        // Absolute/parseable, and the `/api/get` endpoint is preserved
        // regardless of trailing slashes or a base path (joinUrl strips only
        // trailing slashes before appending `/api/get`).
        const parsed = new URL(url);
        expect(parsed.protocol).toBe('https:');
        expect(parsed.pathname.endsWith('/api/get')).toBe(true);

        expectSignatureRoundTrip(url, sig);
      }),
    );
  });

  it('encodes exactly the four signature parameters (no extras, none missing)', () => {
    fc.assert(
      fc.property(trackSignatureArb, (sig) => {
        const parsed = new URL(buildGetUrl(DEFAULT_LRCLIB_BASE_URL, sig));
        expect([...parsed.searchParams.keys()].sort()).toEqual([
          'album_name',
          'artist_name',
          'duration',
          'track_name',
        ]);
      }),
    );
  });
});
