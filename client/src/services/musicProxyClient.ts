/**
 * Same-origin music proxy client (browser side).
 *
 * Talks to the server-side proxy (`/api/music/*`, see
 * `client/src/server/musicProxy.ts` + the Vite middleware) instead of calling
 * Piped/Invidious/YouTube directly. Because these requests go to the app's OWN
 * origin, there is no CORS wall — the resolution + audio bytes are served back
 * with same-origin/clean headers.
 *
 * It adapts the proxy responses to the SAME contracts the existing tested
 * modules already use:
 * - {@link createProxySearchBackend} → a `SearchBackend` (drop-in for the
 *   Piped backend the `SongPickerController` consumes).
 * - {@link resolveAudioViaProxy} → an audio-resolver function matching the
 *   shape `resolveRoundAssets` expects (`ResolveResult`).
 *
 * Keeping these as thin adapters means none of the gameplay, scoring, or UI
 * logic changes — only WHERE the data comes from.
 */

import type { TrackCandidate } from '@glitch/core';
import type { SearchBackend, SongSearchResult } from '../songPicker/searchBackend.ts';
import type { ResolveResult } from './audioResolver.ts';

/** One result row from `GET /api/music/search`. */
interface ProxyCandidate {
  videoId: string;
  title: string;
  artist: string;
  durationSec: number;
  thumbnail?: string;
}
interface ProxySearchResponse {
  results?: ProxyCandidate[];
  error?: string;
}

/** Default same-origin base for the proxy endpoints. */
const DEFAULT_BASE = '/api/music';

/** Map a proxy candidate to the shared `TrackCandidate` shape. */
function toTrackCandidate(c: ProxyCandidate): TrackCandidate | null {
  if (!c || typeof c.videoId !== 'string' || c.videoId === '') return null;
  const title = typeof c.title === 'string' ? c.title.trim() : '';
  const artist = typeof c.artist === 'string' ? c.artist.trim() : '';
  if (title === '' || artist === '') return null;
  return {
    videoId: c.videoId,
    title,
    artist,
    durationSec: typeof c.durationSec === 'number' && c.durationSec > 0 ? Math.round(c.durationSec) : 0,
  };
}

/**
 * Build a {@link SearchBackend} that queries the same-origin proxy. Returns a
 * typed {@link SongSearchResult} so it slots directly into the existing
 * `SongPickerController` with no other changes.
 *
 * @param baseUrl Proxy base, defaults to `/api/music`.
 * @param fetchImpl Injected fetch (tests); defaults to global `fetch`.
 */
export function createProxySearchBackend(
  baseUrl: string = DEFAULT_BASE,
  fetchImpl: typeof fetch = fetch,
): SearchBackend {
  return async (query: string): Promise<SongSearchResult> => {
    try {
      const res = await fetchImpl(`${baseUrl}/search?q=${encodeURIComponent(query)}`);
      if (!res.ok) {
        return { ok: false, failure: { ok: false, reason: 'http', status: res.status } };
      }
      const data = (await res.json()) as ProxySearchResponse;
      const candidates: TrackCandidate[] = [];
      for (const row of data.results ?? []) {
        const mapped = toTrackCandidate(row);
        if (mapped) candidates.push(mapped);
      }
      return { ok: true, candidates };
    } catch {
      return { ok: false, failure: { ok: false, reason: 'network' } };
    }
  };
}

/**
 * Resolve a playable, same-origin audio stream URL for a video id via the
 * proxy. The returned URL points at `/api/music/audio?id=...`, which streams
 * the bytes through our origin — so it is always CORS-reliable for the Web
 * Audio AnalyserNode (`corsReliable: true`).
 *
 * Matches the `resolveAudioFn` signature `resolveRoundAssets` expects. The
 * `instances` argument is ignored (the server owns instance selection now) but
 * kept for signature compatibility.
 *
 * @param videoId The YouTube video id from the selected candidate.
 * @param baseUrl Proxy base, defaults to `/api/music`.
 * @param fetchImpl Injected fetch (tests); defaults to global `fetch`.
 */
export async function resolveAudioViaProxy(
  videoId: string,
  _instances: string[] = [],
  baseUrl: string = DEFAULT_BASE,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolveResult> {
  const streamUrl = `${baseUrl}/audio?id=${encodeURIComponent(videoId)}`;
  try {
    // HEAD-style probe via GET Range:0-0 so we fail fast with an actionable
    // error instead of handing the <audio> element a dead URL.
    const probe = await fetchImpl(streamUrl, { headers: { Range: 'bytes=0-0' } });
    if (!probe.ok && probe.status !== 206) {
      return { ok: false, reason: 'all_instances_failed', attempts: [] };
    }
    return {
      ok: true,
      streamUrl,
      instanceUsed: 'proxy',
      corsReliable: true,
      durationSec: 0,
    };
  } catch {
    return { ok: false, reason: 'all_instances_failed', attempts: [] };
  }
}
