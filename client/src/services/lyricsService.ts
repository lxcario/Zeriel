/**
 * Lyrics_Service and LRC parser (task 2.6).
 *
 * Design references:
 * - design.md "External Service Interfaces — Lyrics_Service (LRCLIB)":
 *   "Requests time-synced lyrics using the track signature:
 *   `GET {LRCLIB}/api/get?track_name=&artist_name=&album_name=&duration=`
 *   (Requirement 6.1). LRCLIB matches on duration within ±2s, so the duration
 *   from Piped is passed through. On a 200 response with non-null
 *   `syncedLyrics`, it parses the LRC body into ordered Lyric_Lines (6.2). A
 *   404 / null `syncedLyrics` is a **no-lyrics** result (6.4); a request error
 *   or >8s timeout is a **retrieval failure** (6.5, 17.2). A fallback to
 *   `GET /api/search?q=` is used when the exact signature misses, surfacing
 *   candidates for a looser match."
 * - design.md "LRC parsing": "LRCLIB `syncedLyrics` is LRC text where each line
 *   is `[mm:ss.xx] text`. The parser extracts timestamp tags, converts to
 *   milliseconds, pairs each with its text, drops malformed/empty lines, and
 *   returns lines sorted by ascending start time. This parser is a prime
 *   property-testing target (round-trip and ordering)."
 * - Requirement 17.3: "IF audio is resolved but no matching synced lyrics are
 *   available, THEN THE Glitch SHALL allow the Host to continue in a
 *   lyrics-free listening state or select a different track." (The `no_lyrics`
 *   result is what enables that branch; the UI mapping lives in task 2.9.)
 *
 * This module lives in the client `services` layer (not `@glitch/core`) because
 * it performs network I/O through the shared `fetchWithTimeout` helper, which
 * touches web `fetch`/`AbortController`. `@glitch/core` must stay pure. The
 * `parseLrc` and `buildGetUrl` exports, however, are themselves PURE and
 * DOM/network-free — they are the property-testing targets for tasks 2.7/2.8.
 *
 * Compatibility note: {@link LyricsResult}'s failure arm uses exactly the
 * `reason` literals `'no_lyrics' | 'retrieval_failed'` so it is structurally
 * assignable to `LyricsFailure` in `errorMessages.ts` (task 2.9), with no
 * adapter — a failed `fetchSynced` result can be passed straight into
 * `mapExternalError`.
 */

import type { LyricLine, TrackSignature } from '@glitch/core';
import {
  fetchWithTimeout,
  type FetchFn,
  type FetchResult,
  type FetchWithTimeoutOptions,
} from './fetchWithTimeout.ts';

// ---------------------------------------------------------------------------
// Public result type and configuration
// ---------------------------------------------------------------------------

/**
 * Typed result of {@link fetchSynced} / {@link LyricsService.fetchSynced}.
 *
 * Mirrors `LyricsResult` in design.md. Discriminated on `ok`, then on `reason`
 * for failures:
 * - `no_lyrics`        — LRCLIB matched nothing usable (404, or a 200 whose
 *   `syncedLyrics` is null/absent/unparseable, and the search fallback also
 *   found nothing). A no-result, not a transport failure (Requirements 6.4,
 *   17.3). The Client may continue lyrics-free or pick a different track.
 * - `retrieval_failed` — the request errored or exceeded the 8s timeout
 *   (Requirements 6.5, 17.2). A retryable transport failure.
 */
export type LyricsResult =
  | { ok: true; lines: LyricLine[] }
  | { ok: false; reason: 'no_lyrics' | 'retrieval_failed' };

/** Default LRCLIB base origin. Real callers may override (e.g. a mirror). */
export const DEFAULT_LRCLIB_BASE_URL = 'https://lrclib.net';

/**
 * LRCLIB matches on duration within ±2 seconds, per design.md. Used both
 * implicitly by `/api/get` (server-side) and explicitly when picking a
 * `/api/search` fallback candidate.
 */
export const DURATION_TOLERANCE_SEC = 2;

/** Options for {@link fetchSynced} and {@link createLyricsService}. */
export interface LyricsServiceOptions {
  /** LRCLIB base origin. Defaults to {@link DEFAULT_LRCLIB_BASE_URL}. */
  baseUrl?: string;
  /** Injected fetch implementation, threaded to `fetchWithTimeout`. */
  fetchImpl?: FetchFn;
  /** Per-request timeout (clamped to 8000ms by `fetchWithTimeout`). */
  timeoutMs?: number;
}

/** The Lyrics_Service contract from design.md. */
export interface LyricsService {
  fetchSynced(sig: TrackSignature): Promise<LyricsResult>;
}

// ---------------------------------------------------------------------------
// LRCLIB response shapes (only the fields we consume)
// ---------------------------------------------------------------------------

/**
 * A single LRCLIB record as returned by `/api/get` (object) and `/api/search`
 * (array of these). Only the fields the service reads are typed; everything is
 * optional/nullable because the payload is untrusted external data.
 */
interface LrclibRecord {
  trackName?: string | null;
  artistName?: string | null;
  albumName?: string | null;
  /** Track duration in seconds (used for the ±2s search-candidate match). */
  duration?: number | null;
  instrumental?: boolean | null;
  plainLyrics?: string | null;
  /** LRC-format synced lyrics, or null when LRCLIB has none for the track. */
  syncedLyrics?: string | null;
}

// ---------------------------------------------------------------------------
// URL builders (pure)
// ---------------------------------------------------------------------------

/** Join a base origin (with or without a trailing slash) to an absolute path. */
function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

/**
 * Build the LRCLIB `GET /api/get` URL encoding the full track signature
 * (Requirement 6.1). All four signature fields are added through
 * `URLSearchParams`, so each value is correctly percent-encoded regardless of
 * spaces or punctuation in the track/artist/album names.
 *
 * Query parameters: `track_name`, `artist_name`, `album_name`, `duration`
 * (seconds). LRCLIB matches duration within ±2s, so the resolved Piped
 * duration is passed through verbatim.
 *
 * This is the target of property test 2.7 (LRCLIB signature encoding).
 *
 * @param base - LRCLIB base origin, e.g. `https://lrclib.net`.
 * @param sig  - The track signature to encode.
 * @returns The absolute `/api/get` URL string with encoded query parameters.
 */
export function buildGetUrl(base: string, sig: TrackSignature): string {
  const url = new URL(joinUrl(base, '/api/get'));
  url.searchParams.set('track_name', sig.trackName);
  url.searchParams.set('artist_name', sig.artistName);
  url.searchParams.set('album_name', sig.albumName);
  url.searchParams.set('duration', String(sig.durationSec));
  return url.toString();
}

/**
 * Build the LRCLIB `GET /api/search` fallback URL. The `q` query is composed
 * from the signature as `"{trackName} {artistName}"` (trimmed) — a loose,
 * human-style query, since the exact `/api/get` signature already missed. The
 * value is encoded via `URLSearchParams`.
 *
 * @param base - LRCLIB base origin.
 * @param sig  - The track signature to derive the query from.
 */
export function buildSearchUrl(base: string, sig: TrackSignature): string {
  const url = new URL(joinUrl(base, '/api/search'));
  url.searchParams.set('q', `${sig.trackName} ${sig.artistName}`.trim());
  return url.toString();
}

// ---------------------------------------------------------------------------
// LRC parsing (pure)
// ---------------------------------------------------------------------------

/**
 * Fresh LRC timestamp-tag matcher. A new instance is created per use so the
 * global `lastIndex` never leaks between calls.
 *
 * Accepted timestamp formats (documented per task 2.6):
 * - `[mm:ss]`      — minutes and seconds only (no fraction).
 * - `[mm:ss.x]`    — 1-digit fraction, interpreted as DECIseconds  (×100ms).
 * - `[mm:ss.xx]`   — 2-digit fraction, interpreted as CENTIseconds (×10ms).
 * - `[mm:ss.xxx]`  — 3-digit fraction, interpreted as MILLIseconds (×1ms).
 *
 * Minutes are one or more digits; seconds are one or two digits; the fraction,
 * when present, is separated by a `.` (period) only. Tags that do not match
 * this shape (e.g. ID tags like `[ti:Title]`, `[ar:Artist]`, `[offset:+250]`)
 * are NOT timestamps and therefore contribute no entries.
 */
const makeTimestampTagRe = (): RegExp => /\[(\d+):(\d{1,2})(?:\.(\d{1,3}))?\]/g;

/** Convert an LRC fraction string to milliseconds, based on its digit count. */
function fractionToMs(fraction: string): number {
  const value = Number.parseInt(fraction, 10);
  switch (fraction.length) {
    case 1:
      return value * 100; // deciseconds
    case 2:
      return value * 10; // centiseconds
    default:
      return value; // 3 digits → milliseconds
  }
}

/** A timestamp/text pair extracted from one raw LRC line, before sorting. */
interface RawEntry {
  startMs: number;
  text: string;
}

/**
 * Parse a single raw LRC line into zero or more {@link RawEntry}s.
 *
 * A standard LRC line may carry MULTIPLE timestamp tags (e.g.
 * `[00:12.00][00:15.00] text`); per standard LRC handling this emits one entry
 * per tag, all sharing the line's text. A line with no valid timestamp tag is
 * dropped (malformed). A line whose text is empty after removing all timestamp
 * tags and trimming is also dropped (empty-text rule) — this also discards
 * metadata-only lines such as `[ti:Title]` and bare `[00:30.00]` markers.
 */
function parseLrcLine(raw: string): RawEntry[] {
  const startTimes: number[] = [];
  const matcher = makeTimestampTagRe();
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(raw)) !== null) {
    // Groups 1 (minutes) and 2 (seconds) are always present when the regex
    // matches; group 3 (fraction) is optional.
    const minutes = Number.parseInt(match[1] ?? '0', 10);
    const seconds = Number.parseInt(match[2] ?? '0', 10);
    const fractionMs = match[3] !== undefined ? fractionToMs(match[3]) : 0;
    startTimes.push(minutes * 60_000 + seconds * 1_000 + fractionMs);
  }

  if (startTimes.length === 0) {
    return []; // no valid timestamp tag → malformed, drop
  }

  const text = raw.replace(makeTimestampTagRe(), '').trim();
  if (text.length === 0) {
    return []; // empty after trimming → drop (empty-text rule)
  }

  return startTimes.map((startMs) => ({ startMs, text }));
}

/**
 * Parse LRCLIB `syncedLyrics` LRC text into ordered {@link LyricLine}s.
 *
 * PURE function (no fetch, no DOM). Behavior, per design.md "LRC parsing":
 * - Splits on newlines (`\r\n` or `\n`).
 * - Extracts timestamp tags `[mm:ss(.fraction)?]` and converts each to ms:
 *   `minutes*60000 + seconds*1000 + fraction` (fraction interpreted by digit
 *   count — see {@link makeTimestampTagRe}).
 * - Emits one LyricLine per timestamp tag (multi-tag lines expand).
 * - Drops malformed lines (no valid tag) and empty-text lines (text blank after
 *   removing tags and trimming).
 * - Returns lines sorted by ascending `startMs`, with ties broken by original
 *   appearance order (a STABLE sort), so the ordering is deterministic.
 *
 * Each produced LyricLine gets a deterministic `id` of `line-{index}` based on
 * its position in the sorted output, and `solutionSlots: []`.
 *
 * Empty-solutionSlots decision (documented per task 2.6): the LyricLine type
 * requires `solutionSlots: SolutionSlot[]`, but the parser is responsible for
 * timestamp+text only. design.md's GameCore surface shows
 * `spawnLine(line: LyricLine): void;  // 7.1 one RopeLetter per letter/word`,
 * and task 4.1 builds "the `0..n-1` Solution_Slot sequence aligned to the
 * correct order" at spawn time — so the slots are populated by
 * `GameCore.spawnLine` (task 4.1), not here. The parser therefore emits lines
 * with an empty `solutionSlots: []` to be filled at spawn time.
 *
 * @param lrc - The raw LRC `syncedLyrics` body.
 * @returns Ordered lyric lines (possibly empty if nothing parses).
 */
export function parseLrc(lrc: string): LyricLine[] {
  const entries = lrc.split(/\r?\n/).flatMap(parseLrcLine);

  const sorted = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.startMs - b.entry.startMs || a.index - b.index);

  return sorted.map(({ entry }, index) => ({
    id: `line-${index}`,
    startMs: entry.startMs,
    text: entry.text,
    solutionSlots: [],
  }));
}

// ---------------------------------------------------------------------------
// Service: fetch + classify + fallback
// ---------------------------------------------------------------------------

/**
 * Build `fetchWithTimeout` options that omit `undefined` keys. Required under
 * `exactOptionalPropertyTypes`, where an explicit `undefined` is not assignable
 * to an optional `number`/`FetchFn` property.
 */
function buildFetchOptions(
  fetchImpl: FetchFn | undefined,
  timeoutMs: number | undefined,
): FetchWithTimeoutOptions {
  const opts: FetchWithTimeoutOptions = {};
  if (fetchImpl !== undefined) {
    opts.fetchImpl = fetchImpl;
  }
  if (timeoutMs !== undefined) {
    opts.timeoutMs = timeoutMs;
  }
  return opts;
}

/**
 * Parse a candidate's `syncedLyrics`, returning the parsed lines only when they
 * are usable (a non-empty string that yields at least one LyricLine). Returns
 * `null` for null/absent/empty/unparseable lyrics, signalling "no usable
 * lyrics here".
 */
function parseUsableSynced(synced: string | null | undefined): LyricLine[] | null {
  if (typeof synced !== 'string' || synced.length === 0) {
    return null;
  }
  const lines = parseLrc(synced);
  return lines.length > 0 ? lines : null;
}

/**
 * Pick the best `/api/search` candidate (design.md fallback rule). Considers
 * only candidates with a non-null `syncedLyrics`; among those, prefers the
 * first whose `duration` is within ±{@link DURATION_TOLERANCE_SEC}s of the
 * signature, otherwise falls back to the first candidate with synced lyrics.
 * Returns `null` when no candidate has synced lyrics.
 */
function pickSearchCandidate(
  candidates: LrclibRecord[],
  sig: TrackSignature,
): LrclibRecord | null {
  const withSynced = candidates.filter(
    (c) => typeof c.syncedLyrics === 'string' && c.syncedLyrics.length > 0,
  );
  if (withSynced.length === 0) {
    return null;
  }
  const withinTolerance = withSynced.find(
    (c) =>
      typeof c.duration === 'number' &&
      Math.abs(c.duration - sig.durationSec) <= DURATION_TOLERANCE_SEC,
  );
  // `withSynced[0]` is defined here because `withSynced.length > 0` above.
  return withinTolerance ?? withSynced[0] ?? null;
}

/**
 * Fallback path: `GET /api/search?q=...` (Requirement 6.1 loose match).
 *
 * Trigger (documented per task 2.6): invoked ONLY when the exact `/api/get`
 * request "misses" — i.e. yields a `no_lyrics` outcome (HTTP 404, or a 200 with
 * null/absent/unparseable `syncedLyrics`). It is NOT invoked for transport
 * failures (timeout/network/parse/non-404 HTTP), which are reported directly as
 * `retrieval_failed`.
 *
 * Query construction: `q = "{trackName} {artistName}"` (see
 * {@link buildSearchUrl}). On a usable candidate the parsed lines are returned;
 * otherwise — including when the search request itself fails — the result is
 * `no_lyrics`, preserving the original `/api/get` no-result signal (the
 * fallback is a best-effort enhancement, never a way to turn a clean
 * no-lyrics into a transport failure).
 */
async function searchFallback(
  base: string,
  sig: TrackSignature,
  fetchImpl: FetchFn | undefined,
  timeoutMs: number | undefined,
): Promise<LyricsResult> {
  const searchResult = await fetchWithTimeout<LrclibRecord[]>(
    buildSearchUrl(base, sig),
    buildFetchOptions(fetchImpl, timeoutMs),
  );

  if (!searchResult.ok) {
    // Fallback failed; the primary signal was a clean miss → no_lyrics.
    return { ok: false, reason: 'no_lyrics' };
  }

  const candidates = Array.isArray(searchResult.data) ? searchResult.data : [];
  const picked = pickSearchCandidate(candidates, sig);
  if (picked !== null) {
    const lines = parseUsableSynced(picked.syncedLyrics);
    if (lines !== null) {
      return { ok: true, lines };
    }
  }
  return { ok: false, reason: 'no_lyrics' };
}

/**
 * Classify a non-OK `/api/get` fetch failure into a {@link LyricsResult}, or
 * signal (via `null`) that the caller should attempt the search fallback.
 *
 * Failure-reason mapping (documented per task 2.6):
 * - HTTP 404            → `no_lyrics` (signalled here by returning `null` so the
 *   caller runs the search fallback first).
 * - HTTP non-404        → `retrieval_failed`.
 * - `timeout`           → `retrieval_failed` (Requirements 6.5, 17.2).
 * - `network`           → `retrieval_failed`.
 * - `parse`             → `retrieval_failed`.
 */
function classifyGetFailure(
  failure: Extract<FetchResult<unknown>, { ok: false }>,
): LyricsResult | null {
  if (failure.reason === 'http' && failure.status === 404) {
    return null; // 404 → no_lyrics; let the caller try the fallback first
  }
  return { ok: false, reason: 'retrieval_failed' };
}

/**
 * Request time-synced lyrics from LRCLIB for a track signature (Requirement
 * 6.1) and classify the outcome (Requirements 6.2, 6.4, 6.5, 17.3).
 *
 * Flow:
 * 1. `GET {base}/api/get?...signature` via the shared `fetchWithTimeout`.
 * 2. On 200 with non-null, parseable `syncedLyrics` → `{ ok: true, lines }`.
 * 3. On 200 with null/absent/unparseable `syncedLyrics`, or HTTP 404 → attempt
 *    the `/api/search` fallback; return its result (`{ ok: true }` or
 *    `no_lyrics`).
 * 4. On timeout/network/parse/non-404 HTTP → `{ ok: false, retrieval_failed }`.
 *
 * @param sig     - The track signature (track/artist/album/duration).
 * @param options - Base URL, injected `fetchImpl`, and timeout overrides.
 */
export async function fetchSynced(
  sig: TrackSignature,
  options: LyricsServiceOptions = {},
): Promise<LyricsResult> {
  const base = options.baseUrl ?? DEFAULT_LRCLIB_BASE_URL;
  const { fetchImpl, timeoutMs } = options;

  const getResult = await fetchWithTimeout<LrclibRecord>(
    buildGetUrl(base, sig),
    buildFetchOptions(fetchImpl, timeoutMs),
  );

  if (getResult.ok) {
    const lines = parseUsableSynced(getResult.data?.syncedLyrics);
    if (lines !== null) {
      return { ok: true, lines };
    }
    // 200 but no usable synced lyrics → no_lyrics → try the loose-match fallback.
    return searchFallback(base, sig, fetchImpl, timeoutMs);
  }

  const classified = classifyGetFailure(getResult);
  if (classified !== null) {
    return classified; // retrieval_failed
  }
  // 404 → no_lyrics → try the loose-match fallback.
  return searchFallback(base, sig, fetchImpl, timeoutMs);
}

/**
 * Build a {@link LyricsService} bound to the given options, conforming to the
 * design interface. Equivalent to calling {@link fetchSynced} with `options`.
 */
export function createLyricsService(options: LyricsServiceOptions = {}): LyricsService {
  return {
    fetchSynced: (sig: TrackSignature) => fetchSynced(sig, options),
  };
}
