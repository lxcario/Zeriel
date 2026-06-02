/**
 * External-service track data models.
 *
 * Design references: design.md "External Service Interfaces" (Audio_Resolver,
 * Lyrics_Service). These are pure data shapes shared across packages; the
 * resolver/lyrics clients themselves live outside `core` (they touch network).
 */

/**
 * A track candidate surfaced by search and selectable as the pending track
 * (Requirements 3.1, 3.2). `videoId` feeds the Audio_Resolver; `durationSec`
 * is forwarded to the Lyrics_Service for the LRCLIB signature match.
 */
export interface TrackCandidate {
  videoId: string;
  title: string;
  artist: string;
  durationSec: number;
}

/**
 * The signature used to request synced lyrics from LRCLIB (Requirement 6.1).
 * LRCLIB matches on duration within ±2s, so `durationSec` is passed through
 * from the resolved audio.
 */
export interface TrackSignature {
  trackName: string;
  artistName: string;
  albumName: string;
  durationSec: number;
}
