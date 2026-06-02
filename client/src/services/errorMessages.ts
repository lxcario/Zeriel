/**
 * External-error-to-message mapping (task 2.9).
 *
 * Design references:
 * - design.md "Request Discipline (shared)": failures from the resolvers and
 *   the search backend "bubble up as typed results that the UI maps to
 *   actionable, retryable messages (Requirements 17.1, 17.5)."
 * - Requirement 17.1: IF an external service request to a Piped_Instance,
 *   LRCLIB, or a search backend fails, THEN THE Client SHALL display an
 *   actionable error message describing the failure and the available next step.
 * - Requirement 17.5: WHEN a recoverable external service error is displayed,
 *   THE Client SHALL provide a retry control for the failed operation.
 *
 * This is a PURE function (no DOM, no React, no network). It lives in the
 * client `services` layer because the typed failures it maps originate from the
 * client-side resolvers (Audio_Resolver task 2.3, Lyrics_Service task 2.6) and
 * the Song_Picker search (task 10.1). The output is a UI-agnostic descriptor
 * the UI renders into buttons/messages.
 *
 * Compatibility: the input union below mirrors the failure arms of the resolver
 * result types in the design. TypeScript is structural, so a resolver's
 * `{ ok: false, ... }` result is directly assignable to the matching member
 * here — callers can pass the failure result straight in once tasks 2.3 / 2.6
 * land, with no adapter. The `reason` string literals are kept EXACTLY as the
 * design specifies and are globally unique across the three sources, so the
 * union is cleanly discriminated on `reason` alone.
 */

import type { FetchFailureReason } from './fetchWithTimeout.ts';

// ---------------------------------------------------------------------------
// Input: the typed failure union (mirrors the resolver / search result shapes)
// ---------------------------------------------------------------------------

/**
 * One Piped instance attempt outcome, mirroring `InstanceAttempt` from the
 * Audio_Resolver design (task 2.3 will produce a structurally identical type).
 */
export interface InstanceAttempt {
  instance: string;
  outcome: 'ok' | 'error' | 'timeout' | 'no_streams';
}

/**
 * Audio resolution failure — every configured Piped_Instance failed to yield a
 * usable stream URL (Requirement 4.5). Mirrors the failure arm of
 * `AudioResolver.resolve`'s `ResolveResult`.
 */
export interface AudioResolveFailure {
  ok: false;
  reason: 'all_instances_failed';
  attempts: InstanceAttempt[];
}

/**
 * Lyrics retrieval result failures (Requirements 6.4, 6.5). Mirrors the failure
 * arm of `LyricsService.fetchSynced`'s `LyricsResult`:
 * - `no_lyrics`        — LRCLIB matched but had no synced lyrics (a no-result,
 *                         not a transport failure; Requirement 6.4 / 17.3).
 * - `retrieval_failed` — request error/timeout; a retryable error (6.5).
 */
export interface LyricsFailure {
  ok: false;
  reason: 'no_lyrics' | 'retrieval_failed';
}

/**
 * Search backend failure (Requirement 17.1). The Song_Picker search goes
 * through the shared `fetchWithTimeout`, so a failed search surfaces a
 * {@link FetchFailureReason} (`timeout` | `network` | `http` | `parse`). An
 * optional `status` is present for `http` failures.
 */
export interface SearchFailure {
  ok: false;
  reason: FetchFailureReason;
  status?: number;
}

/**
 * The discriminated union of every external-service failure the UI must map to
 * an actionable message. Discriminated on `reason` (each literal is unique to a
 * single source).
 */
export type ExternalServiceFailure =
  | AudioResolveFailure
  | LyricsFailure
  | SearchFailure;

// ---------------------------------------------------------------------------
// Output: the UI-agnostic presentation descriptor
// ---------------------------------------------------------------------------

/**
 * The kind of next-step control offered to the user:
 * - `retry`               — re-run the failed operation (Requirement 17.5).
 * - `pick_different_track` — abandon this track, choose another (Requirement 4.5).
 * - `continue_lyrics_free` — proceed without synced lyrics (Requirement 17.3 / 6.4).
 */
export type ErrorActionKind = 'retry' | 'pick_different_track' | 'continue_lyrics_free';

/** A single actionable next step for the user to take. */
export interface ErrorAction {
  kind: ErrorActionKind;
  /** Human-facing control label (non-empty). */
  label: string;
}

/**
 * A UI-agnostic descriptor for presenting an external-service error. The UI
 * renders `message` as text and each `action` as a control.
 *
 * Invariants (enforced by {@link mapExternalError} and the unit tests):
 * - `message` is always non-empty (Requirement 17.1).
 * - When `recoverable` is `true`, `actions` contains a `retry` action
 *   (Requirement 17.5).
 */
export interface ErrorPresentation {
  /** Actionable, brand-free description of the failure (Requirement 17.1). */
  message: string;
  /** Available next steps (Requirements 17.1, 17.5, 4.5, 6.4). */
  actions: ErrorAction[];
  /** Whether a recoverable retry control is offered (Requirement 17.5). */
  recoverable: boolean;
}

// ---------------------------------------------------------------------------
// Action constructors (stable labels, no brand names per Requirements 3.3/18.5)
// ---------------------------------------------------------------------------

const retryAction = (): ErrorAction => ({ kind: 'retry', label: 'Retry' });
const pickDifferentTrackAction = (): ErrorAction => ({
  kind: 'pick_different_track',
  label: 'Pick a different track',
});
const continueLyricsFreeAction = (): ErrorAction => ({
  kind: 'continue_lyrics_free',
  label: 'Continue without lyrics',
});

/** Build a user-facing message for a search-backend transport failure. */
function searchFailureMessage(failure: SearchFailure): string {
  switch (failure.reason) {
    case 'timeout':
      return 'Song search timed out. Check your connection and try again.';
    case 'network':
      return "Couldn't reach the song search service. Check your connection and try again.";
    case 'http':
      return failure.status !== undefined
        ? `Song search failed (server responded ${failure.status}). Try again.`
        : 'Song search failed because of a server error. Try again.';
    case 'parse':
      return 'Song search returned an unexpected response. Try again.';
  }
}

/** Exhaustiveness guard: makes unhandled future `reason` values a compile error. */
function assertNever(value: never): never {
  throw new Error(`Unhandled external failure reason: ${JSON.stringify(value)}`);
}

/**
 * Map a typed external-service failure to an actionable, retryable UI
 * descriptor (Requirements 17.1, 17.5).
 *
 * Recoverability decisions (documented per task guidance):
 * - `all_instances_failed` (audio) → **recoverable**. The failure is caused by
 *   external Piped instances that may be transiently down, so per Requirement
 *   17.5 a `retry` control is offered for the resolution operation; per
 *   Requirement 4.5 a `pick_different_track` control is also offered.
 * - `retrieval_failed` (lyrics)    → **recoverable**. Requirement 6.5 mandates a
 *   "retrievable error state with a retry option", so a `retry` control.
 * - search failures (timeout/network/http/parse) → **recoverable**. Transport
 *   failures of a recoverable external request, so a `retry` control (17.5).
 * - `no_lyrics` (lyrics)           → **not recoverable by retry**. This is a
 *   no-result, not a transport failure: retrying cannot synthesize lyrics that
 *   do not exist. Per Requirement 6.4 / 17.3 the next steps are
 *   `continue_lyrics_free` and `pick_different_track`; no `retry` is offered.
 *
 * Every returned `message` is non-empty (Requirement 17.1).
 */
export function mapExternalError(failure: ExternalServiceFailure): ErrorPresentation {
  switch (failure.reason) {
    case 'all_instances_failed':
      return {
        message:
          "Couldn't load audio for this track from any available source. You can try again or pick a different track.",
        actions: [retryAction(), pickDifferentTrackAction()],
        recoverable: true,
      };

    case 'no_lyrics':
      return {
        message:
          'No synced lyrics were found for this track. You can continue without lyrics or pick a different track.',
        actions: [continueLyricsFreeAction(), pickDifferentTrackAction()],
        recoverable: false,
      };

    case 'retrieval_failed':
      return {
        message: "Couldn't load synced lyrics for this track. You can try again.",
        actions: [retryAction()],
        recoverable: true,
      };

    case 'timeout':
    case 'network':
    case 'http':
    case 'parse':
      return {
        message: searchFailureMessage(failure),
        actions: [retryAction()],
        recoverable: true,
      };

    default:
      return assertNever(failure);
  }
}
