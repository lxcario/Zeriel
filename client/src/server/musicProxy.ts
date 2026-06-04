/**
 * Server-side music proxy logic (dev middleware + deploy adapter).
 *
 * ## Why this exists
 * Zeriel's browser cannot call Piped/Invidious/YouTube directly: those public
 * endpoints either send no CORS headers (so the browser blocks reading the
 * response) or are intermittently down. This module mirrors the proven approach
 * from the sibling "CinePurr" project: do search + stream resolution on the
 * SERVER, then hand same-origin results to the browser. Server-to-server fetches
 * have no CORS restriction, and proxying the audio bytes through our own origin
 * makes playback (and the Web Audio AnalyserNode) CORS-clean.
 *
 * This file is Node-only (uses global `fetch` + `node:stream`). It is imported
 * ONLY by `vite.config.ts` (dev/preview middleware) and any deploy adapter
 * (Vercel function / Node server) — never by the browser bundle, so it adds
 * nothing to client JS.
 *
 * ## Search resolution chain (most reliable first)
 * 1. YouTube Data API v3 (when `YOUTUBE_API_KEY` is set) — official, reliable.
 * 2. Piped `/search?filter=music_songs` across several instances.
 *
 * ## Audio resolution chain (VPS deployment)
 * `resolveAudioUrl` tries, in order: (1) the `yt-dlp` binary (PRIMARY — most
 * reliable, actively maintained), (2) `@distube/ytdl-core` (JS-native fallback),
 * (3) Piped + Invidious public instances raced via `Promise.any` (last-ditch).
 * The caller then proxies those bytes (with Range support) to the browser.
 * Resolved URLs are cached briefly since googlevideo URLs are short-lived.
 */

import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * A YouTube video id is exactly 11 chars of `[A-Za-z0-9_-]`. The audio endpoint
 * interpolates this id into shell-invoked (`yt-dlp`) and HTTP URLs, so it MUST
 * be validated before use to prevent argument/SSRF injection (the client encodes
 * it, but the server cannot trust that). Anything else is rejected.
 */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** True when `id` is a syntactically valid YouTube video id (see {@link VIDEO_ID_RE}). */
export function isValidVideoId(id: string): boolean {
  return typeof id === 'string' && VIDEO_ID_RE.test(id);
}

/**
 * Absolute path / binary name for the `yt-dlp` executable. Defaults to `yt-dlp`
 * (resolved on `PATH`); override with `YTDLP_PATH` on a VPS where it lives
 * elsewhere. yt-dlp is the PRIMARY audio backend (actively maintained, adapts to
 * YouTube changes fastest); the JS extractor and public instances are fallbacks.
 */
const YTDLP_BIN = process.env.YTDLP_PATH ?? 'yt-dlp';

/** Whether the yt-dlp primary backend is enabled (set `YTDLP_DISABLE=1` to skip). */
const YTDLP_ENABLED = process.env.YTDLP_DISABLE !== '1';

/** Hard cap on a single yt-dlp extraction before it is killed (ms). */
const YTDLP_TIMEOUT_MS = 20_000;

/** Resolved-URL cache TTL (ms). googlevideo URLs are short-lived + IP-bound. */
const AUDIO_URL_TTL_MS = 5 * 60_000;

/**
 * Decode the small set of HTML entities the YouTube Data API emits in titles
 * and channel names (e.g. `Don&#39;t Lie`, `Rock &amp; Roll`, `&quot;x&quot;`).
 *
 * The YouTube API HTML-escapes these fields. Zeriel renders them as PLAIN TEXT
 * via React (which is already XSS-safe by escaping on render), so the escaping
 * is redundant and shows up literally as `&#39;` on screen. We decode here so
 * the stored/displayed strings are clean human text. This handles named
 * entities plus decimal (`&#39;`) and hex (`&#x27;`) numeric references.
 */
function decodeHtmlEntities(input: string): string {
  if (typeof input !== 'string' || input.indexOf('&') === -1) return input;
  const named: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
  };
  return input
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => named[m] ?? m)
    .replace(/&#(\d+);/g, (_m, dec: string) => safeFromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => safeFromCodePoint(Number.parseInt(hex, 16)));
}

/** Convert a numeric code point to a char, leaving invalid values untouched. */
function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** A normalized search result the client maps to a `TrackCandidate`. */
export interface MusicCandidate {
  /** YouTube video id (the stable track key). */
  videoId: string;
  /** Track title. */
  title: string;
  /** Channel / artist name. */
  artist: string;
  /** Duration in seconds (0 when unknown). */
  durationSec: number;
  /** Optional thumbnail URL (unused by gameplay; handy for the picker). */
  thumbnail?: string;
}

/** Piped instances tried for search + stream (curated, Dec 2025 status list). */
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.lunar.icu',
  'https://api.piped.yt',
  'https://pipedapi.r4fo.com',
];

/** Invidious instances tried for stream resolution (fallback to Piped). */
const INVIDIOUS_INSTANCES = [
  'https://invidious.protokolla.fi',
  'https://inv.nadeko.net',
  'https://yewtu.be',
  'https://invidious.privacydev.net',
];

/** A browser-like UA — some instances reject the default Node fetch UA. */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Fetch with an abort-based timeout (ms). Returns `null` on any failure. */
async function fetchJson<T>(url: string, timeoutMs: number): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': BROWSER_UA },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Parse an ISO-8601 duration (`PT1H2M3S`) into seconds. */
function parseIso8601Duration(d: string | undefined): number {
  if (!d) return 0;
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d);
  if (!m) return 0;
  return (
    Number.parseInt(m[1] ?? '0', 10) * 3600 +
    Number.parseInt(m[2] ?? '0', 10) * 60 +
    Number.parseInt(m[3] ?? '0', 10)
  );
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

interface YtSearchResponse {
  items?: Array<{ id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string; thumbnails?: Record<string, { url?: string }> } }>;
}
interface YtVideosResponse {
  items?: Array<{ id?: string; contentDetails?: { duration?: string } }>;
}

/** Search via the official YouTube Data API v3. Returns `null` if unavailable. */
async function searchYouTubeApi(query: string, apiKey: string): Promise<MusicCandidate[] | null> {
  const searchUrl =
    `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=10` +
    `&q=${encodeURIComponent(query)}&key=${apiKey}`;
  const search = await fetchJson<YtSearchResponse>(searchUrl, 10_000);
  if (!search?.items?.length) return null;

  const ids = search.items.map((it) => it.id?.videoId).filter((v): v is string => Boolean(v));
  if (ids.length === 0) return null;

  // Fetch durations in one batch (best-effort; absence just yields 0).
  const durations: Record<string, number> = {};
  const details = await fetchJson<YtVideosResponse>(
    `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids.join(',')}&key=${apiKey}`,
    8_000,
  );
  for (const item of details?.items ?? []) {
    if (item.id) durations[item.id] = parseIso8601Duration(item.contentDetails?.duration);
  }

  const out: MusicCandidate[] = [];
  for (const it of search.items) {
    const videoId = it.id?.videoId;
    const title = it.snippet?.title?.trim();
    const artist = it.snippet?.channelTitle?.trim();
    if (!videoId || !title || !artist) continue;
    const thumb =
      it.snippet?.thumbnails?.high?.url ??
      it.snippet?.thumbnails?.medium?.url ??
      it.snippet?.thumbnails?.default?.url;
    out.push({
      videoId,
      title: decodeHtmlEntities(title),
      artist: decodeHtmlEntities(artist),
      durationSec: durations[videoId] ?? 0,
      ...(thumb ? { thumbnail: thumb } : {}),
    });
  }
  return out.length > 0 ? out : null;
}

interface PipedSearchItem {
  url?: string;
  videoId?: string;
  title?: string;
  uploaderName?: string;
  duration?: number;
  thumbnail?: string;
  type?: string;
}

/** Extract a video id from a Piped `url` (`/watch?v=ID`) or explicit field. */
function pipedItemVideoId(item: PipedSearchItem): string | null {
  if (typeof item.videoId === 'string' && item.videoId) return item.videoId;
  if (typeof item.url === 'string') {
    const m = /[?&]v=([^&]+)/.exec(item.url);
    if (m?.[1]) return decodeURIComponent(m[1]);
  }
  return null;
}

/** Search via Piped instances (fallback when no YouTube API key / it failed). */
async function searchPiped(query: string): Promise<MusicCandidate[] | null> {
  for (const base of PIPED_INSTANCES) {
    const data = await fetchJson<{ items?: PipedSearchItem[] }>(
      `${base}/search?q=${encodeURIComponent(query)}&filter=music_songs`,
      8_000,
    );
    const items = data?.items;
    if (!Array.isArray(items) || items.length === 0) continue;

    const out: MusicCandidate[] = [];
    for (const item of items) {
      if (item.type !== undefined && item.type !== 'stream') continue;
      const videoId = pipedItemVideoId(item);
      const title = item.title?.trim();
      const artist = item.uploaderName?.trim();
      if (!videoId || !title || !artist) continue;
      out.push({
        videoId,
        title: decodeHtmlEntities(title),
        artist: decodeHtmlEntities(artist),
        durationSec: typeof item.duration === 'number' && item.duration > 0 ? Math.round(item.duration) : 0,
        ...(item.thumbnail ? { thumbnail: item.thumbnail } : {}),
      });
    }
    if (out.length > 0) return out;
  }
  return null;
}

/**
 * Resolve search candidates for `query`: YouTube Data API first (if `apiKey`),
 * then Piped instances. The raw list is ranked + filtered for music relevance
 * ({@link rankMusicCandidates}) so reactions/interviews/loops/tutorials drop
 * out and official tracks rise to the top. Returns `[]` only when every method
 * failed.
 */
export async function searchMusic(query: string, apiKey: string | undefined): Promise<MusicCandidate[]> {
  if (apiKey) {
    const viaApi = await searchYouTubeApi(query, apiKey);
    if (viaApi && viaApi.length > 0) return rankMusicCandidates(viaApi, query);
  }
  const viaPiped = await searchPiped(query);
  return viaPiped ? rankMusicCandidates(viaPiped, query) : [];
}

/**
 * Title substrings that mark a result as NOT a normal playable song for a
 * karaoke round — reactions, interviews, long loops, tutorials, etc. A
 * candidate whose title contains one of these is excluded (unless excluding
 * everything would leave no results — see {@link rankMusicCandidates}).
 */
const NON_MUSIC_PATTERNS: readonly RegExp[] = [
  /\breaction\b/i,
  /\binterview\b/i,
  /\breview\b/i,
  /\breacts?\b/i,
  /\btutorial\b/i,
  /\bhow to\b/i,
  /\blesson\b/i,
  /\bbehind the scenes\b/i,
  /\bmaking of\b/i,
  /\bdocumentar/i,
  /\bpodcast\b/i,
  /\bexplained\b/i,
  /\bbreakdown\b/i,
  /\b\d+\s*hours?\b/i, // "1 hour", "10 hours"
  /\bloop(?:ed)?\b/i,
  /\bfull album\b/i,
  /\bcompilation\b/i,
  /\bplaylist\b/i,
  /\bmegamix\b/i,
  /\bnon[- ]?stop\b/i,
  /\bteaser\b/i,
  /\btrailer\b/i,
  /\bgameplay\b/i,
  /\bkaraoke\b/i, // we want the real track, not a karaoke backing version
  /\binstrumental\b/i,
];

/** Soft-penalty patterns: still a song, but a less ideal pick for a round. */
const SOFT_PENALTY_PATTERNS: readonly RegExp[] = [
  /\blive\b/i,
  /\bcover\b/i,
  /\bremix\b/i,
  /\bsped ?up\b/i,
  /\bslowed\b/i,
  /\b8d audio\b/i,
  /\bnightcore\b/i,
  /\bmashup\b/i,
  /\bacoustic\b/i,
];

/** Boost patterns marking an official, round-friendly track. */
const OFFICIAL_PATTERNS: readonly RegExp[] = [
  /\bofficial\b/i,
  /\bofficial audio\b/i,
  /\bofficial music video\b/i,
  /\bofficial video\b/i,
];

/** Plausible song-length window (seconds): drop very short clips + very long videos. */
const MIN_SONG_SEC = 45;
const MAX_SONG_SEC = 11 * 60; // 11 minutes

/**
 * Rank and filter raw search candidates for music relevance.
 *
 * 1. HARD-exclude obvious non-music ({@link NON_MUSIC_PATTERNS}) and, when the
 *    duration is known, anything outside the {@link MIN_SONG_SEC}..{@link MAX_SONG_SEC}
 *    song-length window.
 * 2. SCORE survivors by: official/VEVO boost, query token overlap (title +
 *    artist), and soft penalties (live/cover/remix/…), with the original result
 *    order as a stable tie-break.
 * 3. Sort by score descending.
 *
 * Safety: if hard-exclusion would remove EVERY candidate (e.g. a deliberately
 * odd query), the original list is ranked instead so the user still sees
 * results rather than an empty list.
 */
export function rankMusicCandidates(candidates: MusicCandidate[], query: string): MusicCandidate[] {
  const queryTokens = tokenSet(query);

  const isPlayableSong = (c: MusicCandidate): boolean => {
    const title = c.title ?? '';
    if (NON_MUSIC_PATTERNS.some((re) => re.test(title))) return false;
    if (c.durationSec > 0 && (c.durationSec < MIN_SONG_SEC || c.durationSec > MAX_SONG_SEC)) {
      return false;
    }
    return true;
  };

  const kept = candidates.filter(isPlayableSong);
  // Never strand the user with nothing: if the filter removed everything, rank
  // the unfiltered list instead.
  const pool = kept.length > 0 ? kept : candidates.slice();

  const score = (c: MusicCandidate): number => {
    const title = c.title ?? '';
    const artist = c.artist ?? '';
    let s = 0;
    if (OFFICIAL_PATTERNS.some((re) => re.test(title))) s += 4;
    if (/vevo$/i.test(artist)) s += 3; // VEVO channels are official uploads
    // Query relevance (title weighted higher than artist).
    s += overlap(queryTokens, tokenSet(title)) * 2;
    s += overlap(queryTokens, tokenSet(artist));
    if (SOFT_PENALTY_PATTERNS.some((re) => re.test(title))) s -= 3;
    return s;
  };

  // Decorate-sort-undecorate with the original index as a STABLE tie-break.
  return pool
    .map((c, index) => ({ c, index, s: score(c) }))
    .sort((a, b) => b.s - a.s || a.index - b.index)
    .map(({ c }) => c);
}

// ---------------------------------------------------------------------------
// Stream resolution (audio URL)
// ---------------------------------------------------------------------------

interface PipedStreamsResponse {
  audioStreams?: Array<{ url?: string; bitrate?: number }>;
  error?: string;
}
interface InvidiousVideoResponse {
  adaptiveFormats?: Array<{ url?: string; type?: string; bitrate?: number }>;
}

/** Try one Piped instance for the highest-bitrate audio URL. Throws on failure. */
async function tryPipedStream(base: string, videoId: string): Promise<string> {
  const data = await fetchJson<PipedStreamsResponse>(`${base}/streams/${videoId}`, 8_000);
  if (!data || data.error) throw new Error('piped miss');
  const audio = (data.audioStreams ?? [])
    .filter((s) => typeof s.url === 'string')
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
  if (!audio?.url) throw new Error('no audio');
  return audio.url;
}

/** Try one Invidious instance for the best audio URL. Throws on failure. */
async function tryInvidiousStream(base: string, videoId: string): Promise<string> {
  const data = await fetchJson<InvidiousVideoResponse>(`${base}/api/v1/videos/${videoId}`, 6_000);
  const audio = (data?.adaptiveFormats ?? [])
    .filter((f) => f.type?.includes('audio') && typeof f.url === 'string')
    .sort((a, b) => {
      const opus = (f: { type?: string }) => (f.type?.includes('opus') ? 1 : 0);
      return opus(b) - opus(a) || (b.bitrate ?? 0) - (a.bitrate ?? 0);
    })[0];
  if (!audio?.url) throw new Error('no audio');
  return audio.url;
}

/**
 * PRIMARY backend: extract a direct audio URL with the `yt-dlp` binary
 * (subprocess). yt-dlp is the most reliable, most actively maintained YouTube
 * extractor — it adapts to YouTube changes within hours, which the JS libraries
 * cannot. Requires `yt-dlp` on `PATH` (or `YTDLP_PATH`) on the VPS.
 *
 * Selects `bestaudio[abr<=128]/bestaudio` (a modest bitrate keeps extraction +
 * proxying fast for a party game) and asks for the direct URL via `--get-url`
 * (no transcode, no temp file). The process is hard-killed after
 * {@link YTDLP_TIMEOUT_MS}. Returns the first emitted URL, or `null` on any
 * failure/timeout/non-zero exit so the caller falls through to the next backend.
 *
 * `videoId` is validated by the caller ({@link resolveAudioUrl}) before reaching
 * here, and is passed as a fixed `watch?v=` URL argument (never shell-interpolated
 * — `spawn` with an args array, no shell), so it cannot inject extra arguments.
 */
function tryYtDlp(videoId: string): Promise<string | null> {
  return new Promise((resolve) => {
    const args = [
      '-f',
      'bestaudio[abr<=128]/bestaudio',
      '--get-url',
      '--no-warnings',
      '--no-playlist',
      '--no-call-home',
      `https://www.youtube.com/watch?v=${videoId}`,
    ];

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null); // binary missing / not spawnable
      return;
    }

    let stdout = '';
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), YTDLP_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      // --get-url may print one line per selected format; take the first URL.
      const url = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('http'));
      finish(url ?? null);
    });
  });
}

/**
 * FALLBACK backend: extract a direct audio URL with `@distube/ytdl-core` (a
 * JS-native, maintained fork of `ytdl-core`). No subprocess, so it works even
 * where a `yt-dlp` binary is unavailable. Lazy-imported so it never touches the
 * browser bundle and a load failure is non-fatal. Returns `null` on any failure.
 */
async function tryDistubeYtdl(videoId: string): Promise<string | null> {
  try {
    const mod = await import('@distube/ytdl-core');
    const ytdl = (mod as unknown as { default?: typeof import('@distube/ytdl-core') }).default ?? mod;
    const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`, {
      requestOptions: { headers: { 'User-Agent': BROWSER_UA } },
    });
    const format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
    return format?.url ?? null;
  } catch {
    return null;
  }
}

/**
 * Short-lived cache of resolved audio URLs. Resolved googlevideo URLs are
 * time-limited and IP-bound, so an entry is only reused for {@link AUDIO_URL_TTL_MS}.
 * This avoids re-running yt-dlp for the SAME track on a Range re-request or a
 * quick replay, which is the common case for a party game.
 */
const audioUrlCache = new Map<string, { url: string; expiresAt: number }>();

/** Read a non-expired cached audio URL for `videoId`, or `null`. */
function getCachedAudioUrl(videoId: string): string | null {
  const entry = audioUrlCache.get(videoId);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    audioUrlCache.delete(videoId);
    return null;
  }
  return entry.url;
}

/**
 * Resolve a direct (CDN) audio URL for `videoId` (assumed already validated by
 * {@link isValidVideoId}).
 *
 * Resolution order (per the VPS deployment plan — most reliable first):
 *   1. `yt-dlp` subprocess — PRIMARY (actively maintained, adapts fastest).
 *   2. `@distube/ytdl-core` — JS-native fallback (no subprocess needed).
 *   3. Piped + Invidious public instances raced via `Promise.any` (last-ditch;
 *      frequently down/blocked, hence demoted below direct extraction).
 *
 * Successful resolutions are cached for {@link AUDIO_URL_TTL_MS}. Returns `null`
 * only when every backend fails.
 */
export async function resolveAudioUrl(videoId: string): Promise<string | null> {
  const cached = getCachedAudioUrl(videoId);
  if (cached) return cached;

  let url: string | null = null;

  // 1) yt-dlp (primary).
  if (YTDLP_ENABLED) {
    url = await tryYtDlp(videoId);
  }

  // 2) @distube/ytdl-core (JS-native fallback).
  if (!url) {
    url = await tryDistubeYtdl(videoId);
  }

  // 3) Public instances (last-ditch), raced.
  if (!url) {
    const attempts: Array<Promise<string>> = [
      ...PIPED_INSTANCES.map((b) => tryPipedStream(b, videoId)),
      ...INVIDIOUS_INSTANCES.map((b) => tryInvidiousStream(b, videoId)),
    ];
    try {
      url = await Promise.any(attempts);
    } catch {
      url = null;
    }
  }

  if (url) {
    audioUrlCache.set(videoId, { url, expiresAt: Date.now() + AUDIO_URL_TTL_MS });
  }
  return url;
}

// ---------------------------------------------------------------------------
// HTTP handlers (connect-style; used by Vite dev/preview middleware)
// ---------------------------------------------------------------------------

/**
 * Send a JSON response. Successful (2xx) payloads are cached briefly; error
 * responses set `no-store` so a transient failure is never cached and a retry
 * hits the server fresh.
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', status >= 200 && status < 300 ? 'public, max-age=300' : 'no-store');
  res.end(payload);
}

/** Handle `GET /api/music/search?q=` → `{ results: MusicCandidate[] }`. */
export async function handleSearch(
  query: string | null,
  apiKey: string | undefined,
  res: ServerResponse,
): Promise<void> {
  if (!query || query.trim() === '') {
    sendJson(res, 400, { results: [], error: 'Query required' });
    return;
  }
  try {
    const results = await searchMusic(query.trim(), apiKey);
    sendJson(res, 200, { results });
  } catch {
    sendJson(res, 503, { results: [], error: 'Search service unavailable' });
  }
}

/**
 * Handle `GET /api/music/audio?id=` by resolving the audio URL and PROXYING the
 * bytes (with Range support) so playback is same-origin and CORS-clean. This is
 * what lets the browser's `<audio crossorigin="anonymous">` + AnalyserNode work
 * without tainting.
 */
export async function handleAudio(
  videoId: string | null,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!videoId) {
    sendJson(res, 400, { error: 'Video id required' });
    return;
  }
  // SECURITY: the id is interpolated into a subprocess argument and outbound
  // URLs, so reject anything that is not a syntactically valid YouTube id
  // before it reaches the resolver (defends against argument/SSRF injection).
  if (!isValidVideoId(videoId)) {
    sendJson(res, 400, { error: 'Invalid video id' });
    return;
  }

  const audioUrl = await resolveAudioUrl(videoId);
  if (!audioUrl) {
    sendJson(res, 503, {
      error: 'audio_unavailable',
      message: 'Could not resolve an audio stream. The upstream services may be blocking or down.',
    });
    return;
  }

  // Forward the client's Range header so seeking + progressive playback work.
  // Guard the upstream byte fetch with an AbortController so a hung CDN cannot
  // wedge the response open indefinitely.
  const range = req.headers['range'];
  const controller = new AbortController();
  const upstreamTimer = setTimeout(() => controller.abort(), 15_000);
  let upstream: Response;
  try {
    upstream = await fetch(audioUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': BROWSER_UA,
        ...(typeof range === 'string' ? { Range: range } : {}),
      },
    });
  } catch {
    clearTimeout(upstreamTimer);
    // A cached URL may have expired/become invalid; drop it so a retry re-resolves.
    audioUrlCache.delete(videoId);
    sendJson(res, 502, { error: 'upstream_unreachable' });
    return;
  }
  clearTimeout(upstreamTimer);

  if (!upstream.ok && upstream.status !== 206) {
    audioUrlCache.delete(videoId); // stale/expired URL — force re-resolution next time.
    sendJson(res, 502, { error: 'upstream_failed', status: upstream.status });
    return;
  }

  res.statusCode = upstream.status;
  // Copy through the headers a media element needs for seeking/streaming.
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (!upstream.headers.get('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
  // Audio bytes are large + URL-specific; don't let an intermediary cache them.
  res.setHeader('Cache-Control', 'no-store');

  if (!upstream.body) {
    res.end();
    return;
  }
  // Pipe the web ReadableStream to the Node response. Abort the upstream if the
  // client disconnects mid-stream so we don't keep pulling bytes for no one.
  const nodeStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
  res.on('close', () => {
    if (!res.writableEnded) {
      try {
        controller.abort();
      } catch {
        /* already aborted */
      }
    }
  });
  nodeStream.on('error', () => {
    if (!res.headersSent) res.statusCode = 502;
    res.end();
  });
  nodeStream.pipe(res);
}

// ---------------------------------------------------------------------------
// Lyrics proxy (LRCLIB) — routes the request server-side so ISP/firewall blocks
// on the client's network don't prevent lyrics loading.
// ---------------------------------------------------------------------------

/** Default LRCLIB base (same as the client `lyricsService.ts` uses). */
const LRCLIB_BASE = 'https://lrclib.net';

/**
 * Clean a messy YouTube-style title + channel into a best-guess (track, artist)
 * pair for LRCLIB. YouTube titles carry noise LRCLIB does not store — "(Official
 * Video)", "[Lyrics]", "(TM)", VEVO channel suffixes, "Artist - Title" prefixes
 * — which makes the exact `/api/get` lookup miss even when lyrics exist. This
 * normalizes the common shapes so the lookup (and the search fallback) hit.
 *
 * Order matters: literal "(TM)"/"™"/"(R)" are stripped FIRST so a following
 * noise-parenthetical regex can match an outer group that contained them.
 */
export function cleanTrackMeta(
  rawTitle: string,
  rawArtist: string,
): { track: string; artist: string } {
  const NOISE =
    'official|lyric|lyrics|audio|video|hd|hq|4k|mv|m\\/v|visualizer|visualiser|live|remaster(?:ed)?|explicit|clean|color coded|sub|subtitulado|legendado';

  let title = (rawTitle ?? '').toString();
  // 1) Drop trademark/registered marks (literal and unicode) so nested groups
  //    like "(The Official ... World Cup(TM) Song)" become matchable.
  title = title.replace(/\(tm\)|\(r\)|[\u2122\u00ae]/gi, '');
  // 2) Remove bracketed/parenthetical segments that contain a noise keyword.
  const noiseParen = new RegExp(`\\((?:[^)]*\\b(?:${NOISE})\\b[^)]*)\\)`, 'gi');
  const noiseBracket = new RegExp(`\\[(?:[^\\]]*\\b(?:${NOISE})\\b[^\\]]*)\\]`, 'gi');
  title = title.replace(noiseParen, '').replace(noiseBracket, '');

  // 3) Split a leading "Artist - Title" (en/em dash or hyphen).
  let artist = (rawArtist ?? '').toString();
  const dash = title.split(/\s+[-–—]\s+/);
  let track = title;
  if (dash.length >= 2 && (dash[0] ?? '').trim().length > 0) {
    artist = (dash[0] ?? '').trim();
    track = dash.slice(1).join(' - ').trim();
  }

  // 4) Normalize the artist: drop VEVO / "- Topic" suffixes and "feat." tails.
  artist = artist
    .replace(/vevo$/i, '')
    .replace(/\s*-\s*topic$/i, '')
    .replace(/\s*\bofficial\b\s*$/i, '')
    .trim();

  // 5) Tidy the track: drop a trailing "feat./ft." clause, collapse whitespace,
  //    and trim stray dangling punctuation left by removed groups.
  track = track
    .replace(/\s*[([]\s*(?:feat|ft)\.?[^)\]]*[)\]]/gi, '')
    .replace(/\s*\b(?:feat|ft)\.?\s+.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,(\[-]+$/g, '')
    .replace(/^[\s,)\]-]+/g, '')
    .trim();

  // Never return empty fields — fall back to the raw values if cleaning emptied
  // them (better a messy query than no query).
  if (track.length === 0) track = (rawTitle ?? '').toString().trim();
  if (artist.length === 0) artist = (rawArtist ?? '').toString().trim();
  return { track, artist };
}

/**
 * Handle `GET /api/music/lyrics?track=&artist=&album=&duration=` by proxying
 * the request to LRCLIB server-side. This avoids any ISP-level block on
 * `lrclib.net` that the browser would hit when calling it directly.
 *
 * Returns the LRCLIB JSON response verbatim (the client's `parseLrc` handles
 * the `syncedLyrics` field). On failure returns a JSON error so the client's
 * existing error-mapping produces the right UI.
 */
export async function handleLyrics(
  params: URLSearchParams,
  res: ServerResponse,
): Promise<void> {
  const rawTrack = params.get('track');
  const rawArtist = params.get('artist');
  const duration = params.get('duration');

  if (!rawTrack || !rawArtist) {
    sendJson(res, 400, { error: 'track and artist params required' });
    return;
  }

  // Clean the messy YouTube-style title/channel into LRCLIB-friendly metadata.
  // The raw values are kept as a fallback so a clean miss can retry raw.
  const { track, artist } = cleanTrackMeta(rawTrack, rawArtist);

  // Try the exact signature with the CLEANED metadata first.
  const cleanGet = await lrclibGet(track, artist, duration);
  if (cleanGet.kind === 'ok') {
    sendJson(res, 200, cleanGet.record);
    return;
  }
  if (cleanGet.kind === 'error') {
    sendJson(res, 502, { error: 'lrclib_error' });
    return;
  }

  // 404 on the cleaned signature → search fallback with cleaned metadata.
  const cleanSearch = await lrclibSearchFallback(track, artist, duration);
  if (cleanSearch) {
    sendJson(res, 200, cleanSearch);
    return;
  }

  // Last resort: a raw search (in case cleaning removed something meaningful).
  if (rawTrack !== track || rawArtist !== artist) {
    const rawSearch = await lrclibSearchFallback(rawTrack, rawArtist, duration);
    if (rawSearch) {
      sendJson(res, 200, rawSearch);
      return;
    }
  }

  sendJson(res, 404, { syncedLyrics: null });
}

/** Outcome of a single LRCLIB `/api/get` request. */
type LrclibGetResult =
  | { kind: 'ok'; record: Record<string, unknown> }
  | { kind: 'miss' } // 404 / no usable synced lyrics — caller should try search
  | { kind: 'error' }; // timeout/network/non-404 HTTP

/**
 * Request the exact LRCLIB `/api/get` signature. Returns `ok` with the record
 * only when it carries non-empty `syncedLyrics`; a 404 or a 200 without synced
 * lyrics is a `miss` (try the search fallback); transport failures are `error`.
 */
async function lrclibGet(
  track: string,
  artist: string,
  duration: string | null,
): Promise<LrclibGetResult> {
  const url = new URL(`${LRCLIB_BASE}/api/get`);
  url.searchParams.set('track_name', track);
  url.searchParams.set('artist_name', artist);
  url.searchParams.set('album_name', '');
  if (duration) url.searchParams.set('duration', duration);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const upstream = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': BROWSER_UA },
    });
    clearTimeout(timer);
    if (upstream.status === 404) return { kind: 'miss' };
    if (!upstream.ok) return { kind: 'error' };
    const record = (await upstream.json()) as Record<string, unknown>;
    const synced = record?.syncedLyrics;
    if (typeof synced === 'string' && synced.length > 0) return { kind: 'ok', record };
    return { kind: 'miss' };
  } catch {
    clearTimeout(timer);
    return { kind: 'error' };
  }
}

/** Lowercased alphanumeric token set of a string (for relevance overlap). */
function tokenSet(s: string): Set<string> {
  const out = new Set<string>();
  for (const tok of (s ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length > 0) out.add(tok);
  }
  return out;
}

/** Count of shared tokens between two token sets. */
function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

/**
 * LRCLIB `/api/search` fallback when the exact signature misses (404).
 *
 * Among candidates that have synced lyrics, picks the BEST by relevance:
 *   - title/artist token overlap with the query (so "Waka Waka" doesn't match a
 *     random remix), then
 *   - duration within ±2s when available, then
 *   - original result order.
 * Returns the chosen record, or `null` when nothing usable is found.
 */
async function lrclibSearchFallback(
  track: string,
  artist: string,
  duration: string | null,
): Promise<Record<string, unknown> | null> {
  const searchUrl = new URL(`${LRCLIB_BASE}/api/search`);
  searchUrl.searchParams.set('q', `${track} ${artist}`.trim());

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);

  try {
    const upstream = await fetch(searchUrl.toString(), {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': BROWSER_UA },
    });
    clearTimeout(timer);
    if (!upstream.ok) return null;

    const candidates = (await upstream.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(candidates)) return null;

    const withSynced = candidates.filter(
      (c) => typeof c.syncedLyrics === 'string' && (c.syncedLyrics as string).length > 0,
    );
    if (withSynced.length === 0) return null;

    const durationNum = duration ? Number.parseFloat(duration) : 0;
    const wantTrack = tokenSet(track);
    const wantArtist = tokenSet(artist);

    let best: Record<string, unknown> | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < withSynced.length; i++) {
      const c = withSynced[i]!;
      const tName = typeof c.trackName === 'string' ? c.trackName : '';
      const aName = typeof c.artistName === 'string' ? c.artistName : '';
      // Token-overlap relevance (track weighted higher than artist).
      let score =
        overlap(wantTrack, tokenSet(tName)) * 3 + overlap(wantArtist, tokenSet(aName)) * 2;
      // Duration agreement bonus (±2s like LRCLIB's own matching).
      if (durationNum > 0 && typeof c.duration === 'number' && Math.abs(c.duration - durationNum) <= 2) {
        score += 2;
      }
      // Stable tie-break toward earlier results.
      score -= i * 0.001;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best ?? withSynced[0] ?? null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}
