import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  mapPipedSearchResponse,
  type PipedSearchItem,
  type PipedSearchResponse,
} from './searchBackend.ts';

/**
 * Property-based test for Song_Picker search-candidate fields (task 10.2).
 *
 * Property 7: Search candidates expose title and artist.
 * **Validates: Requirements 3.1**
 *
 * Design ("Correctness Properties" / Property 7): *For any* list of track
 * candidates returned by search, every candidate exposes a title and an artist.
 * design.md "Song_Picker": "Calls the search backend, lists candidates with
 * title + artist (Requirement 3.1)". The pure mapper
 * {@link mapPipedSearchResponse} is the isolated target of this property — it
 * is the gate that guarantees every surfaced candidate carries a usable
 * `videoId`, a non-empty `title`, and a non-empty `artist`.
 *
 * Strategy: we generate a BROAD `PipedSearchResponse` input space so the
 * invariant is stressed against every shape the backend could realistically
 * return — fields independently present/absent, empty/whitespace strings,
 * non-`stream` item types, and missing/negative/NaN durations. Each field is
 * generated independently and is "sometimes absent" so any combination of
 * missing data is exercised. We also feed `null`/`undefined`/`{}` whole
 * responses to assert the mapper degrades to `[]` rather than throwing.
 *
 * If the mapper ever surfaces a candidate with an empty `title` or `artist`
 * (or a missing `videoId`), that is a genuine Requirement 3.1 / Property 7
 * violation — not a test problem — and the counterexample proves the bug.
 *
 * numRuns is left at the global default (100, from `vitest.setup.ts`); we do
 * not weaken it.
 */

// --- Generators -------------------------------------------------------------

/**
 * Sometimes-absent wrapper: with ~1/4 probability yields `undefined` (the field
 * is omitted from the item), otherwise the supplied value. This drives the
 * mapper's defensive handling of partial Piped items.
 */
function sometimesAbsent<T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> {
  return fc.oneof(
    { weight: 3, arbitrary: arb },
    { weight: 1, arbitrary: fc.constant(undefined) },
  );
}

/** An arbitrary, possibly-empty/whitespace/Unicode video id for the `v=` param. */
const videoIdArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.string({ unit: 'grapheme' }),
  fc.constantFrom('dQw4w9WgXcQ', 'abc-123_XYZ', '0', ' ', '   '),
);

/**
 * A `url` field: usually a `/watch?v=ID` path with an arbitrary id, but
 * sometimes a bare/invalid url that carries no `v=` param (so the mapper must
 * drop it), plus the occasional empty string.
 */
const urlArb: fc.Arbitrary<string> = fc.oneof(
  // Well-formed watch path with an arbitrary (possibly empty) id.
  videoIdArb.map((id) => `/watch?v=${encodeURIComponent(id)}`),
  // Absolute watch URL with an arbitrary id + extra params.
  videoIdArb.map((id) => `https://piped.example/watch?v=${encodeURIComponent(id)}&t=42s`),
  // Bare / invalid urls with no `v=` param — must never yield a candidate.
  fc.constantFrom('/channel/UC123', '/playlist?list=PL1', '/watch', 'not-a-url', ''),
  fc.webUrl(),
);

/** A text field that is sometimes empty / whitespace-only to probe the trim gate. */
const textArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.string({ unit: 'grapheme' }),
  fc.constantFrom('', ' ', '   ', '\t', '\n', '  \t \n '),
  fc.constant('Bohemian Rhapsody'),
);

/** A duration field spanning absent/negative/NaN/Infinity/fractional/valid. */
const durationArb: fc.Arbitrary<number> = fc.oneof(
  fc.double({ min: -1000, max: 100000, noNaN: false }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0, 0.4, 1.6),
  fc.integer({ min: -10, max: 6000 }),
);

/** Item `type`: only `'stream'` is playable; channels/playlists/absent are mixed in. */
const typeArb: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constant('stream'),
  fc.constantFrom('channel', 'playlist', 'stream', 'music_song', ''),
  fc.string(),
  fc.constant(undefined),
);

/** One arbitrary Piped search item with each field generated independently. */
const itemArb: fc.Arbitrary<PipedSearchItem> = fc
  .record({
    url: sometimesAbsent(urlArb),
    title: sometimesAbsent(textArb),
    uploaderName: sometimesAbsent(textArb),
    duration: sometimesAbsent(durationArb),
    type: typeArb,
  })
  .map((raw) => {
    // Build the item omitting absent keys entirely (closer to real payloads
    // and exercising both "key missing" and "value present" paths).
    const item: PipedSearchItem = {};
    if (raw.url !== undefined) item.url = raw.url;
    if (raw.title !== undefined) item.title = raw.title;
    if (raw.uploaderName !== undefined) item.uploaderName = raw.uploaderName;
    if (raw.duration !== undefined) item.duration = raw.duration;
    if (raw.type !== undefined) item.type = raw.type;
    return item;
  });

/** A well-formed response with an `items` array (0..20 items). */
const itemsResponseArb: fc.Arbitrary<PipedSearchResponse> = fc.record({
  items: fc.array(itemArb, { minLength: 0, maxLength: 20 }),
});

/** Degenerate responses the mapper must tolerate by returning `[]`. */
const emptyResponseArb: fc.Arbitrary<PipedSearchResponse | null | undefined> = fc.constantFrom(
  null,
  undefined,
  {} as PipedSearchResponse,
  { items: [] } as PipedSearchResponse,
);

/** Full input space: well-formed responses unioned with the degenerate ones. */
const responseArb: fc.Arbitrary<PipedSearchResponse | null | undefined> = fc.oneof(
  { weight: 4, arbitrary: itemsResponseArb },
  { weight: 1, arbitrary: emptyResponseArb },
);

// --- Property 7 -------------------------------------------------------------

describe('Property 7: Search candidates expose title and artist (Requirement 3.1)', () => {
  it('every returned candidate carries a non-empty title, artist, and videoId', () => {
    fc.assert(
      fc.property(responseArb, (resp) => {
        const result = mapPipedSearchResponse(resp);

        // Never throws; always an array.
        expect(Array.isArray(result)).toBe(true);

        // Soundness: cannot emit more candidates than there were input items.
        const inputItemCount = Array.isArray(resp?.items) ? resp.items.length : 0;
        expect(result.length).toBeLessThanOrEqual(inputItemCount);

        for (const candidate of result) {
          // Title: non-empty string with no leading/trailing whitespace
          // (the mapper trims, so it must equal its own trimmed form).
          expect(typeof candidate.title).toBe('string');
          expect(candidate.title.length).toBeGreaterThan(0);
          expect(candidate.title).toBe(candidate.title.trim());

          // Artist: same guarantees (Requirement 3.1 — title AND artist).
          expect(typeof candidate.artist).toBe('string');
          expect(candidate.artist.length).toBeGreaterThan(0);
          expect(candidate.artist).toBe(candidate.artist.trim());

          // Usable videoId.
          expect(typeof candidate.videoId).toBe('string');
          expect(candidate.videoId.length).toBeGreaterThan(0);

          // Duration: finite, non-negative integer (the mapper rounds, 0 when absent).
          expect(typeof candidate.durationSec).toBe('number');
          expect(Number.isFinite(candidate.durationSec)).toBe(true);
          expect(candidate.durationSec).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(candidate.durationSec)).toBe(true);
        }
      }),
    );
  });

  it('drops non-stream items and items with no v= param', () => {
    fc.assert(
      fc.property(itemsResponseArb, (resp) => {
        const result = mapPipedSearchResponse(resp);
        const items = resp.items ?? [];

        // Every emitted candidate must trace back to an item that was a stream
        // (or had no explicit type) AND whose url carried a `v=` param. The
        // source predicate is independent of the candidate, so iterate by index
        // (one assertion per emitted candidate).
        for (let i = 0; i < result.length; i += 1) {
          const source = items.find((it) => {
            if (it.type !== undefined && it.type !== 'stream') return false;
            if (typeof it.url !== 'string') return false;
            return /[?&]v=([^&]+)/.test(it.url);
          });
          expect(source).toBeDefined();
        }

        // Count of items that are structurally droppable for type reasons can
        // never appear: assert no candidate count exceeds the count of
        // stream-or-untyped items.
        const playableTypeCount = items.filter(
          (it) => it.type === undefined || it.type === 'stream',
        ).length;
        expect(result.length).toBeLessThanOrEqual(playableTypeCount);
      }),
    );
  });

  it('returns [] for null/undefined/empty responses', () => {
    fc.assert(
      fc.property(emptyResponseArb, (resp) => {
        expect(mapPipedSearchResponse(resp)).toEqual([]);
      }),
    );
  });
});
