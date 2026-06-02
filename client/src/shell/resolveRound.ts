/**
 * Round asset resolution for the single-player flow (task 14.1).
 *
 * Bridges the Song_Picker's selected {@link TrackCandidate} to the two external
 * resolvers and produces a {@link RoundPlan} the in-round host can run:
 *
 *   Song_Picker → Audio_Resolver (Piped) → Lyrics_Service (LRCLIB) → RoundPlan
 *
 * Design references:
 * - design.md "Single-Player vs Multiplayer Topology": single-player resolves
 *   audio + lyrics in-browser, then a `LocalGameHost` runs the Round.
 * - Requirement 4: resolve a playable audio stream via Piped multi-instance
 *   fallback; on total failure, offer the Host to pick a different track (4.5).
 * - Requirement 6 / 17.3: retrieve synced lyrics; `no_lyrics` lets the Host
 *   continue in a lyrics-free listening state OR pick a different track; a
 *   retrieval failure is retryable (6.5).
 * - Requirement 17.4: lyrics may be available but audio unresolved — a scored
 *   Round must NOT start without resolved audio, so audio failure always blocks.
 *
 * This module is framework-free and fully injectable (the two resolver
 * functions are parameters), so the wiring is unit-testable with no real
 * network. Failures are returned as the shared {@link ExternalServiceFailure}
 * union so the UI maps them through `mapExternalError` (Requirements 17.1/17.5).
 */

import type { LyricLine, TrackCandidate, TrackSignature } from '@glitch/core';
import { resolveAudio, type ResolveResult } from '../services/audioResolver.ts';
import { fetchSynced, type LyricsResult } from '../services/lyricsService.ts';
import type {
  AudioResolveFailure,
  LyricsFailure,
} from '../services/errorMessages.ts';
import {
  DEFAULT_LRCLIB_BASE_URL,
  DEFAULT_PIPED_INSTANCES,
} from './config.ts';

/**
 * Everything the in-round host needs to run a single-player Round, produced by a
 * successful {@link resolveRoundAssets}.
 */
export interface RoundPlan {
  /** The track the Round plays (drives the Scorecard title, Requirement 11.1). */
  candidate: TrackCandidate;
  /** The resolved playable audio stream URL (Requirement 4.4). */
  streamUrl: string;
  /** Whether the stream is expected to carry CORS headers (audio-reactive layer). */
  corsReliable: boolean;
  /** Track duration in seconds, forwarded from Piped (or the candidate). */
  durationSec: number;
  /** Ordered Lyric_Lines to schedule; EMPTY when continuing lyrics-free (17.3). */
  lines: LyricLine[];
  /** True when the Round runs without synced lyrics (lyrics-free listening, 17.3). */
  lyricsFree: boolean;
}

/**
 * Result of {@link resolveRoundAssets}. On failure the UI maps `failure`
 * through `mapExternalError`; `stage` lets the UI label which resolver failed.
 */
export type ResolveRoundResult =
  | { ok: true; plan: RoundPlan }
  | { ok: false; stage: 'audio' | 'lyrics'; failure: AudioResolveFailure | LyricsFailure };

/** Injected resolver functions + endpoints; defaults wire the real services. */
export interface ResolveRoundDeps {
  /** Ordered Piped instances to try (Requirement 4.2/4.3). */
  instances?: readonly string[];
  /** LRCLIB base origin (Requirement 6.1). */
  lrclibBaseUrl?: string;
  /** Audio resolver fn; defaults to the real {@link resolveAudio}. */
  resolveAudioFn?: (
    videoId: string,
    instances: string[],
  ) => Promise<ResolveResult>;
  /** Lyrics fetcher fn; defaults to the real {@link fetchSynced}. */
  fetchSyncedFn?: (sig: TrackSignature) => Promise<LyricsResult>;
  /**
   * When `true`, a `no_lyrics` outcome resolves SUCCESSFULLY with empty lines
   * (the Host chose to continue lyrics-free, Requirement 17.3). When `false`
   * (default), `no_lyrics` is returned as a failure so the UI can offer the
   * "Continue without lyrics" / "Pick a different track" choice.
   */
  continueLyricsFree?: boolean;
}

/**
 * Resolve audio then lyrics for `candidate`, producing a {@link RoundPlan}.
 *
 * Order and rules:
 * 1. Resolve audio via the Piped multi-instance fallback. On failure return
 *    `{ stage: 'audio' }` — audio is mandatory for a scored Round (17.4, 4.5).
 * 2. Build the LRCLIB signature from the candidate + the Piped-forwarded
 *    duration and fetch synced lyrics.
 *    - success → plan with the parsed lines.
 *    - `retrieval_failed` → `{ stage: 'lyrics' }` (retryable, 6.5).
 *    - `no_lyrics` → success with empty lines IF `continueLyricsFree`, else
 *      `{ stage: 'lyrics' }` so the UI offers the lyrics-free / pick-different
 *      choice (17.3).
 */
export async function resolveRoundAssets(
  candidate: TrackCandidate,
  deps: ResolveRoundDeps = {},
): Promise<ResolveRoundResult> {
  const instances = (deps.instances ?? DEFAULT_PIPED_INSTANCES).slice();
  const lrclibBaseUrl = deps.lrclibBaseUrl ?? DEFAULT_LRCLIB_BASE_URL;
  const resolveAudioFn = deps.resolveAudioFn ?? resolveAudio;
  const fetchSyncedFn =
    deps.fetchSyncedFn ?? ((sig: TrackSignature) => fetchSynced(sig, { baseUrl: lrclibBaseUrl }));

  // 1) Audio resolution (Requirement 4). Mandatory — failure blocks the Round.
  const audio = await resolveAudioFn(candidate.videoId, instances);
  if (!audio.ok) {
    return { ok: false, stage: 'audio', failure: audio };
  }

  // Prefer the Piped-forwarded duration; fall back to the candidate's.
  const durationSec = audio.durationSec > 0 ? audio.durationSec : candidate.durationSec;

  // 2) Lyrics retrieval (Requirement 6) using the track signature.
  const signature: TrackSignature = {
    trackName: candidate.title,
    artistName: candidate.artist,
    albumName: '',
    durationSec,
  };
  const lyrics = await fetchSyncedFn(signature);

  if (lyrics.ok) {
    return {
      ok: true,
      plan: {
        candidate,
        streamUrl: audio.streamUrl,
        corsReliable: audio.corsReliable,
        durationSec,
        lines: lyrics.lines,
        lyricsFree: false,
      },
    };
  }

  // no_lyrics + the Host opted to continue lyrics-free → success, empty lines.
  if (lyrics.reason === 'no_lyrics' && deps.continueLyricsFree === true) {
    return {
      ok: true,
      plan: {
        candidate,
        streamUrl: audio.streamUrl,
        corsReliable: audio.corsReliable,
        durationSec,
        lines: [],
        lyricsFree: true,
      },
    };
  }

  // no_lyrics (no opt-in) or retrieval_failed → surface the typed failure.
  return { ok: false, stage: 'lyrics', failure: lyrics };
}
