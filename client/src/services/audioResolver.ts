/**
 * Audio_Resolver — Piped multi-instance fallback (task 2.3).
 *
 * Design references (design.md "Audio_Resolver (Piped, multi-instance
 * fallback)"):
 * - Iterate a configured ordered list of Piped_Instances, attempting each
 *   **at most once per resolution attempt** (Requirement 4.3).
 * - For each instance request `GET {instance}/streams/{videoId}` with the
 *   shared 8s-capped `fetchWithTimeout` (Requirements 4.1, 17.2).
 * - An instance attempt is a **failure** if the request errors, times out, or
 *   returns no usable `audioStreams`; on failure, advance to the next instance
 *   (Requirement 4.2).
 * - On the first instance that yields a usable stream, return it and report
 *   success (Requirement 4.4) and STOP (do not attempt remaining instances).
 * - If every configured instance fails, report `all_instances_failed`
 *   (Requirement 4.5).
 *
 * Stream selection (CORS-preference layered rule) — design.md:
 *   1. Filter `audioStreams` to entries where `videoOnly === false`.
 *   2. Among those, FIRST prefer "proxied" URLs (host matches the Piped
 *      instance domain — served through the Piped proxy, generally carrying
 *      CORS headers). Pick the highest-bitrate proxied URL → `corsReliable: true`.
 *   3. If NO proxied URL exists, fall back to the highest-bitrate direct
 *      (e.g. `googlevideo`) URL → `corsReliable: false`, so the caller knows
 *      the audio-reactive layer may be unavailable.
 *   "This deliberately trades bitrate for keeping the AnalyserNode reactive
 *   layer alive." The selection is a strict TWO-TIER preference: a lower-bitrate
 *   proxied URL is preferred over any higher-bitrate direct URL.
 *
 * This module lives in the client `services` layer (not `@glitch/core`) because
 * it performs network I/O via `fetchWithTimeout`. `fetchImpl` is injectable and
 * threaded through to the helper so the optional property tests (2.4/2.5) can
 * drive deterministic instance outcomes with no real network.
 */

import { fetchWithTimeout, type FetchFn } from './fetchWithTimeout.ts';
import type { AudioResolveFailure, InstanceAttempt } from './errorMessages.ts';

// Re-export the shared failure/attempt shapes so callers can compose results
// without reaching into the error-mapping module directly.
export type { AudioResolveFailure, InstanceAttempt } from './errorMessages.ts';

// ---------------------------------------------------------------------------
// Piped `/streams/{videoId}` response shape (minimal, tolerant)
// ---------------------------------------------------------------------------

/**
 * A single audio stream entry from a Piped `/streams` response. Only the fields
 * the resolver relies on are typed; Piped returns more (codec, mimeType,
 * quality, etc.) which we deliberately ignore. Fields are typed loosely because
 * the response is untrusted external data — selection guards every value.
 */
export interface PipedAudioStream {
  url: string;
  bitrate: number;
  videoOnly: boolean;
  [extra: string]: unknown;
}

/**
 * The relevant subset of a Piped `/streams/{videoId}` response. `audioStreams`
 * may be missing or a non-array on a malformed/empty response (treated as
 * "no usable streams"). `duration` (seconds) is forwarded to the Lyrics_Service
 * for the LRCLIB signature match — design.md: "The Piped response also provides
 * `duration`, which is forwarded to Lyrics_Service".
 */
export interface PipedStreamsResponse {
  audioStreams?: PipedAudioStream[];
  duration?: number;
  [extra: string]: unknown;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * Successful audio resolution.
 *
 * Mirrors the design's `ResolveResult` success arm exactly
 * (`streamUrl` / `instanceUsed` / `corsReliable`) and ADDS one documented
 * field: `durationSec`. The design's `ResolveResult` type does not list a
 * duration, but the design narrative states the Piped response's `duration` is
 * forwarded to the Lyrics_Service; this field carries it through. `durationSec`
 * matches the naming used by `TrackCandidate`/`TrackSignature` in `@glitch/core`.
 */
export interface AudioResolveSuccess {
  ok: true;
  /** The selected playable audio stream URL (Requirement 4.4). */
  streamUrl: string;
  /** The Piped instance that produced the usable stream. */
  instanceUsed: string;
  /**
   * Whether the selected URL is expected to carry CORS headers: `true` for a
   * proxied URL, `false` when only a direct/non-CORS URL was available.
   */
  corsReliable: boolean;
  /**
   * Forwarded Piped `duration` in seconds (documented extension to the design's
   * success arm); `0` when the response omitted or malformed `duration`.
   */
  durationSec: number;
}

/**
 * Audio resolution result. The failure arm reuses the shared
 * {@link AudioResolveFailure} shape from the error-mapping module so the result
 * composes directly with `mapExternalError` (Requirements 4.5, 17.1).
 */
export type ResolveResult = AudioResolveSuccess | AudioResolveFailure;

/** Optional dependency-injection hooks for {@link resolveAudio}. */
export interface ResolveOptions {
  /**
   * Injected fetch implementation, threaded through to `fetchWithTimeout`.
   * Defaults to the global `fetch`. Tests supply a fake to drive deterministic
   * per-instance outcomes with no network.
   */
  fetchImpl?: FetchFn;
}

/**
 * The Audio_Resolver interface from the design. `createAudioResolver` binds a
 * `fetchImpl` so the resulting object matches this two-argument signature.
 */
export interface AudioResolver {
  resolve(videoId: string, instances: string[]): Promise<ResolveResult>;
}

// ---------------------------------------------------------------------------
// Proxied-URL detection
// ---------------------------------------------------------------------------

/**
 * Parse a URL string and return its lower-cased hostname, or `null` if the
 * string is not a parseable absolute URL. Used to (a) detect proxied URLs and
 * (b) treat unparseable stream URLs as not-usable.
 */
function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Approximate the registrable domain as the last two dot-separated labels
 * (e.g. `pipedproxy.kavin.rocks` → `kavin.rocks`). This is a deliberate
 * heuristic: it does not consult the Public Suffix List, so multi-part TLDs
 * (e.g. `*.co.uk`) collapse to two labels. That is acceptable here because the
 * comparison is only ever made between two hosts that are either the same Piped
 * deployment or an unrelated CDN (`*.googlevideo.com`), which never collide.
 */
function registrableDomain(hostname: string): string {
  const labels = hostname.split('.').filter((label) => label.length > 0);
  if (labels.length <= 2) {
    return labels.join('.');
  }
  return labels.slice(-2).join('.');
}

/**
 * Decide whether `streamUrl` is served through the Piped proxy of `instanceUrl`.
 *
 * MATCHING RULE (documented per task guidance):
 * A stream URL is "proxied" when, comparing hostnames case-insensitively via the
 * WHATWG URL API, EITHER
 *   (a) the stream hostname exactly equals the instance hostname, OR
 *   (b) the stream hostname shares the instance's registrable domain (its last
 *       two labels) — e.g. instance `pipedapi.kavin.rocks` and proxied media
 *       `pipedproxy.kavin.rocks` both reduce to `kavin.rocks`.
 *
 * Rationale: real Piped deployments serve the API on one subdomain
 * (`pipedapi.<domain>`) and proxied media on a sibling subdomain
 * (`pipedproxy.<domain>`), so an exact-host-only rule would misclassify every
 * real proxied URL as direct and defeat the entire CORS-preference feature.
 * Direct streams come from `*.googlevideo.com`, whose registrable domain
 * (`googlevideo.com`) never matches a Piped instance's, so they are correctly
 * classified as NOT proxied. Unparseable URLs (either side) are NOT proxied.
 */
export function isProxiedUrl(streamUrl: string, instanceUrl: string): boolean {
  const streamHost = safeHostname(streamUrl);
  const instanceHost = safeHostname(instanceUrl);
  if (streamHost === null || instanceHost === null) {
    return false;
  }
  if (streamHost === instanceHost) {
    return true;
  }
  const streamDomain = registrableDomain(streamHost);
  const instanceDomain = registrableDomain(instanceHost);
  return streamDomain !== '' && streamDomain === instanceDomain;
}

// ---------------------------------------------------------------------------
// Stream selection (CORS-preference layered rule) — pure, independently tested
// ---------------------------------------------------------------------------

/** A stream that passed validation, paired with whether it is proxied. */
interface UsableStream {
  url: string;
  bitrate: number;
  proxied: boolean;
}

/** Coerce an untrusted bitrate into a finite number for comparison (default 0). */
function toBitrate(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Pick the highest-bitrate stream from a non-empty list. On a tie, the first
 * element (i.e. the order Piped returned) wins, keeping selection stable.
 */
function highestBitrate(streams: UsableStream[]): UsableStream {
  return streams.reduce((best, candidate) =>
    candidate.bitrate > best.bitrate ? candidate : best,
  );
}

/**
 * Select the best audio stream URL for a Piped instance using the CORS-preference
 * layered rule (design.md "Stream selection").
 *
 * Steps:
 *   1. Keep only entries with `videoOnly === false` and a parseable URL string
 *      (unparseable URLs are not usable).
 *   2. If any proxied URL exists, return the highest-bitrate PROXIED URL with
 *      `corsReliable: true` — even if a higher-bitrate direct URL exists.
 *   3. Otherwise return the highest-bitrate direct URL with `corsReliable: false`.
 *   4. If nothing is usable, return `null`.
 *
 * @param streams     Raw `audioStreams` from a Piped `/streams` response.
 * @param instanceUrl The Piped instance base URL, used for proxied detection.
 * @returns The chosen URL and its CORS reliability, or `null` if none usable.
 */
export function selectAudioStream(
  streams: PipedAudioStream[],
  instanceUrl: string,
): { url: string; corsReliable: boolean } | null {
  if (!Array.isArray(streams)) {
    return null;
  }

  const usable: UsableStream[] = [];
  for (const stream of streams) {
    if (stream == null || stream.videoOnly !== false) {
      continue;
    }
    if (typeof stream.url !== 'string' || safeHostname(stream.url) === null) {
      // Filter, not videoOnly, but defends against malformed/unparseable URLs.
      continue;
    }
    usable.push({
      url: stream.url,
      bitrate: toBitrate(stream.bitrate),
      proxied: isProxiedUrl(stream.url, instanceUrl),
    });
  }

  if (usable.length === 0) {
    return null;
  }

  // Tier 1: proxied URLs only.
  const proxied = usable.filter((stream) => stream.proxied);
  if (proxied.length > 0) {
    return { url: highestBitrate(proxied).url, corsReliable: true };
  }

  // Tier 2: no proxied URL — fall back to the highest-bitrate direct URL.
  return { url: highestBitrate(usable).url, corsReliable: false };
}

// ---------------------------------------------------------------------------
// Multi-instance resolution
// ---------------------------------------------------------------------------

/** Remove a single trailing slash so `{instance}/streams/...` never doubles up. */
function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/** Forward the Piped `duration` (seconds), defaulting to 0 when absent/invalid. */
function toDurationSec(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Resolve a playable audio stream URL for `videoId` by trying each Piped
 * instance in order (Requirement 4).
 *
 * For each instance (attempted at most once — Requirement 4.3):
 *   - Request `GET {instance}/streams/{videoId}` via `fetchWithTimeout` (the 8s
 *     cap is enforced by the helper; no larger timeout is passed).
 *   - Map the outcome to an {@link InstanceAttempt}: a fetch timeout →
 *     `'timeout'`; a network/http/parse failure → `'error'`; a 200 with no
 *     usable stream after selection → `'no_streams'`; a usable stream → `'ok'`.
 *   - On any failure, advance to the next instance (Requirement 4.2).
 *
 * Returns the first usable stream (Requirement 4.4), or `all_instances_failed`
 * with one attempt per instance in order when every instance fails
 * (Requirement 4.5).
 */
export async function resolveAudio(
  videoId: string,
  instances: string[],
  options: ResolveOptions = {},
): Promise<ResolveResult> {
  const { fetchImpl } = options;
  // Build helper options without an explicit `fetchImpl: undefined`, which
  // `exactOptionalPropertyTypes` would reject; omitting it lets the helper fall
  // back to the global `fetch`.
  const fetchOptions = fetchImpl ? { fetchImpl } : {};
  const attempts: InstanceAttempt[] = [];

  for (const instance of instances) {
    const url = `${trimTrailingSlash(instance)}/streams/${videoId}`;
    const result = await fetchWithTimeout<PipedStreamsResponse>(url, fetchOptions);

    if (!result.ok) {
      // timeout -> 'timeout'; network/http/parse -> 'error'. Advance (4.2).
      const outcome: InstanceAttempt['outcome'] =
        result.reason === 'timeout' ? 'timeout' : 'error';
      attempts.push({ instance, outcome });
      continue;
    }

    const streams = Array.isArray(result.data?.audioStreams)
      ? result.data.audioStreams
      : [];
    const selected = selectAudioStream(streams, instance);

    if (selected === null) {
      // 200 but no usable audioStreams after filtering -> 'no_streams' (4.2).
      attempts.push({ instance, outcome: 'no_streams' });
      continue;
    }

    // First usable stream: return immediately and stop (4.4).
    return {
      ok: true,
      streamUrl: selected.url,
      instanceUsed: instance,
      corsReliable: selected.corsReliable,
      durationSec: toDurationSec(result.data?.duration),
    };
  }

  // Every configured instance failed (4.5).
  return { ok: false, reason: 'all_instances_failed', attempts };
}

/**
 * Build an {@link AudioResolver} that matches the design's two-argument
 * `resolve(videoId, instances)` signature, with the `fetchImpl` bound up front.
 * Convenience for wiring; `resolveAudio` can also be called directly.
 */
export function createAudioResolver(options: ResolveOptions = {}): AudioResolver {
  return {
    resolve: (videoId, instances) => resolveAudio(videoId, instances, options),
  };
}
