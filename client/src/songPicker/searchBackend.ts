/**
 * Song_Picker search backend (task 10.1).
 *
 * Design references:
 * - design.md "Song_Picker": "Calls the search backend, lists candidates with
 *   title + artist (Requirement 3.1)" through the shared request discipline.
 * - design.md "Request Discipline (shared)": every external request (Piped,
 *   LRCLIB, search) goes through one `fetchWithTimeout` helper with an 8000ms
 *   cap (Requirement 17.2). Failures bubble up as typed results the UI maps to
 *   actionable, retryable messages (Requirements 17.1, 17.5) — see
 *   `errorMessages.ts`.
 *
 * This module owns the network + response-shape concern so the controller
 * (`songPickerController.ts`) stays decoupled from any specific backend and
 * deals only in `TrackCandidate`s. The pure mapping function
 * {@link mapPipedSearchResponse} is exported independently so it can be tested
 * in isolation (it is the target of Property 7, task 10.2).
 *
 * ## Assumed backend response shape (documented)
 *
 * The design references "a search backend" generically. This implementation
 * assumes a **Piped-style** search response, matching the audio source already
 * chosen for the Audio_Resolver (design.md technology stack — Piped API). A
 * Piped `GET {instance}/search?q=&filter=music_songs` response is an object
 * with an `items` array; each playable item carries:
 *   - `url`          — a relative watch path like `"/watch?v=VIDEO_ID"`.
 *   - `title`        — the track title.
 *   - `uploaderName` — the channel/artist name (mapped to `artist`).
 *   - `duration`     — length in seconds (forwarded as `durationSec`).
 *   - `type`         — `"stream"` for playable videos (channels/playlists differ).
 *
 * Only fields this module consumes are typed; unknown fields are ignored. The
 * backend is injectable so tests drive it deterministically with no real
 * network (via `fetchWithTimeout`'s `fetchImpl`).
 */

import type { TrackCandidate } from '@glitch/core';
import {
  fetchWithTimeout,
  type FetchFn,
} from '../services/fetchWithTimeout.ts';
import type { SearchFailure } from '../services/errorMessages.ts';

/** One item from a Piped-style search response (only consumed fields typed). */
export interface PipedSearchItem {
  /** Relative watch path, e.g. `"/watch?v=dQw4w9WgXcQ"`. */
  url?: string;
  /** Track title. */
  title?: string;
  /** Channel/artist name; mapped to {@link TrackCandidate.artist}. */
  uploaderName?: string;
  /** Track length in seconds. */
  duration?: number;
  /** Item kind; only `"stream"` items are playable tracks. */
  type?: string;
}

/** A Piped-style search response payload. */
export interface PipedSearchResponse {
  items?: PipedSearchItem[];
}

/**
 * Normalized outcome of a song search. A discriminated union so the controller
 * can branch on `ok`: success carries mapped candidates; failure carries the
 * typed {@link SearchFailure} (forwarded to `mapExternalError` by the UI).
 */
export type SongSearchResult =
  | { ok: true; candidates: TrackCandidate[] }
  | { ok: false; failure: SearchFailure };

/**
 * The injectable search backend the controller depends on: maps a query string
 * to a normalized {@link SongSearchResult}. The default implementation is
 * {@link createPipedSearchBackend}; tests can pass any compatible function.
 */
export type SearchBackend = (query: string) => Promise<SongSearchResult>;

/**
 * Extract a YouTube/Piped video id from a watch URL or path.
 *
 * Handles relative paths (`"/watch?v=ID"`), absolute URLs, and extra query
 * params. Returns `null` when no `v` parameter is present so the mapper can
 * drop unplayable items.
 */
export function extractVideoId(url: string | undefined): string | null {
  if (typeof url !== 'string' || url === '') return null;
  const match = /[?&]v=([^&]+)/.exec(url);
  if (match && match[1]) return decodeURIComponent(match[1]);
  return null;
}

/**
 * Map a Piped-style search response to `TrackCandidate`s.
 *
 * Pure and defensive — tolerates a missing/!array `items`, missing fields, and
 * non-stream items. A candidate is included only when it has a usable
 * `videoId` AND a non-empty `title` AND a non-empty `artist`, satisfying
 * Requirement 3.1 / Property 7 ("search candidates expose title and artist").
 * `durationSec` is the rounded, non-negative `duration` (0 when absent).
 */
export function mapPipedSearchResponse(resp: PipedSearchResponse | null | undefined): TrackCandidate[] {
  const items = resp?.items;
  if (!Array.isArray(items)) return [];

  const candidates: TrackCandidate[] = [];
  for (const item of items) {
    if (!item) continue;
    // Skip non-playable items (channels, playlists). Items with no `type` are
    // treated as streams for tolerance against minimal fixtures.
    if (item.type !== undefined && item.type !== 'stream') continue;

    const videoId = extractVideoId(item.url);
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const artist = typeof item.uploaderName === 'string' ? item.uploaderName.trim() : '';
    const durationSec =
      typeof item.duration === 'number' && Number.isFinite(item.duration) && item.duration > 0
        ? Math.round(item.duration)
        : 0;

    // Requirement 3.1 / Property 7: candidates MUST carry title AND artist.
    if (videoId === null || title === '' || artist === '') continue;

    candidates.push({ videoId, title, artist, durationSec });
  }
  return candidates;
}

/** Options for {@link createPipedSearchBackend}. */
export interface PipedSearchBackendOptions {
  /** Base URL of a Piped API instance, e.g. `https://pipedapi.kavin.rocks`. */
  instance: string;
  /** Injected fetch implementation; defaults to global `fetch` via the helper. */
  fetchImpl?: FetchFn;
  /** Optional request timeout (clamped to the 8000ms cap by the helper). */
  timeoutMs?: number;
  /** Piped search filter; defaults to `"music_songs"`. */
  filter?: string;
}

/**
 * Build a {@link SearchBackend} backed by a Piped instance, using the shared
 * `fetchWithTimeout` discipline (Requirement 17.2). On success it maps the
 * response to candidates; on any transport failure it forwards the typed
 * {@link SearchFailure} for the UI to present (Requirements 17.1, 17.5).
 */
export function createPipedSearchBackend(options: PipedSearchBackendOptions): SearchBackend {
  const { instance, fetchImpl, timeoutMs, filter = 'music_songs' } = options;
  const base = instance.replace(/\/+$/, '');

  return async (query: string): Promise<SongSearchResult> => {
    const url = `${base}/search?q=${encodeURIComponent(query)}&filter=${encodeURIComponent(filter)}`;

    const result = await fetchWithTimeout<PipedSearchResponse>(url, {
      ...(fetchImpl ? { fetchImpl } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });

    if (result.ok) {
      return { ok: true, candidates: mapPipedSearchResponse(result.data) };
    }

    // The fetch failure arm is structurally a SearchFailure; rebuild it
    // conditionally so an absent `status` is never set to `undefined`
    // (exactOptionalPropertyTypes).
    const { reason } = result;
    const failure: SearchFailure =
      result.status !== undefined ? { ok: false, reason, status: result.status } : { ok: false, reason };
    return { ok: false, failure };
  };
}
