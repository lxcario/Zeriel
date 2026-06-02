/**
 * `RoundLifecycle` — a pure, deterministic Round state machine (task 6.3).
 *
 * ## Placement decision (where this lives and why)
 * This module lives in `@glitch/core` (`core/src/round/`) because it is **pure
 * coordination logic** — it imports only the shared {@link RoundState} type and
 * has NO DOM/network/audio/React dependencies, exactly like `GameCore` and
 * `LyricScheduler`. Both consumers of the round lifecycle need it:
 * - the **single-player host** (`LocalGameHost`, task 13.1, client), and
 * - the **authoritative server** tick loop (task 16.9).
 *
 * Putting it in `core` lets both import the SAME state machine, so the round
 * lifecycle (and its readiness/finalize rules) is identical in single-player and
 * multiplayer by construction — mirroring the design's "single shared `GameCore`"
 * decision applied to the round lifecycle. It is exported additively from the
 * package barrel.
 *
 * ## What this models (design.md "Round State Machine")
 * The full edge set of the design's state diagram:
 *
 * ```
 * [*]          -> Lobby
 * Lobby        -> Resolving      (Host selects a track)            selectTrack()
 * Resolving    -> Ready          (audio AND lyrics resolved)       reportResolution()
 * Resolving    -> ResolveFailed  (audio OR lyrics failed)          reportResolution()
 * ResolveFailed-> Resolving      (retry / pick different track)    retry()
 * Ready        -> Playing        (Host starts, audio+lyrics ready) start()
 * Ready        -> Lobby          (pick a different track)          pickDifferentTrack()
 * Playing      -> Scoring        (last line closes OR audio ends)  enterScoring(finalize)
 * Scoring      -> Lobby          (Host starts a new Round)         newRound()
 * ```
 *
 * Every transition method ENFORCES the allowed edges and returns a typed
 * {@link RoundTransition} result instead of throwing for the spec'd rejections.
 * A method called from a disallowed state returns `{ ok: false, ... }` and does
 * NOT change state.
 *
 * ## Readiness gate (Requirements 10.5, 17.4)
 * `Playing` may only be entered from `Ready` (design.md: "`Playing` may only be
 * entered from `Ready`; a start attempt while `Resolving`/`ResolveFailed` is
 * rejected as 'track not ready'"). This is enforced two ways that reinforce each
 * other:
 *
 * 1. {@link start} rejects with reason `'not_ready'` from ANY state other than
 *    `'ready'` (covers 10.5: starting from `lobby`/`resolving`/`resolve_failed`
 *    is rejected).
 * 2. `'ready'` is only REACHABLE when BOTH audio AND lyrics resolved. The
 *    resolving phase reports the outcome of audio resolution and lyric retrieval
 *    via {@link reportResolution}; only `audioResolved && lyricsResolved` routes
 *    to `'ready'`. Any failure — crucially the 17.4 case "lyrics available but
 *    audio could not be resolved" (`{ audioResolved: false, lyricsResolved: true }`)
 *    — routes to `'resolve_failed'`, from which {@link start} is impossible. So a
 *    scored Round can never start without resolved audio (Requirement 17.4).
 *
 * The two resolution booleans are tracked as observable state
 * ({@link audioResolved} / {@link lyricsResolved}) so the readiness gate is
 * inspectable and the 17.4 "lyrics-ok-but-audio-failed" path is explicit.
 *
 * ## Finalize-before-notify ordering (Requirement 10.4)
 * Requirement 10.4: "WHEN the Round enters the scoring state, FINALIZE the Round
 * result COMPLETELY BEFORE notifying Clients to display the Scorecard."
 *
 * This ordering is guaranteed *in code* by {@link enterScoring}: it takes a
 * `finalize` callback (the caller wires it to finalize ALL open lines via
 * `GameCore.finalizeLine` and produce the `RoundResult` via
 * `GameCore.getRoundResult`). The method:
 *   1. validates the `playing -> scoring` edge,
 *   2. runs `finalize()` FIRST, while `state` is still `'playing'`,
 *   3. ONLY THEN sets `state = 'scoring'`,
 *   4. returns the finalized result.
 *
 * Because the lifecycle does not expose `'scoring'` (nor the finalized result)
 * until after `finalize()` has fully run, any "notify clients to show the
 * Scorecard" path — which observes `state === 'scoring'` or consumes the
 * returned result — necessarily sees a fully finalized result. The lifecycle
 * never lets a notify path observe `'scoring'` before finalization. If the
 * `finalize` callback throws, the state stays `'playing'` and no Client is
 * notified, which is the correct fail-closed behavior.
 *
 * ## Purity / determinism
 * No imports beyond the shared {@link RoundState} type. Given the same sequence
 * of calls, the lifecycle produces the same states and results. It holds no
 * timers, randomness, or external references — the host decides WHEN to call
 * each transition (e.g. the server tick loop calls {@link enterScoring} when the
 * scheduler is complete and the audio has ended).
 */

import type { RoundState } from '../types/index.js';

/**
 * Why a transition was rejected.
 * - `'not_ready'` — {@link start} was attempted while the Round was NOT in the
 *   `'ready'` state. This is the spec'd "track not ready" rejection (Requirement
 *   10.5) and also the guard that prevents starting a scored Round without
 *   resolved audio (Requirement 17.4), since a failed audio resolution lands in
 *   `'resolve_failed'`, never `'ready'`.
 * - `'invalid_transition'` — any other transition method called from a state
 *   that does not have that outgoing edge in the diagram (e.g. {@link retry}
 *   from `'lobby'`, {@link newRound} from `'playing'`).
 */
export type RoundTransitionReason = 'not_ready' | 'invalid_transition';

/**
 * The outcome of audio resolution AND lyric retrieval for the pending track,
 * reported once the resolving phase completes (design.md Round State Machine:
 * `Resolving -> Ready` requires "audio + lyrics resolved"; `Resolving ->
 * ResolveFailed` on "audio or lyrics failed").
 */
export interface RoundResolution {
  /** True iff a playable audio stream was resolved (Audio_Resolver success). */
  audioResolved: boolean;
  /** True iff synced lyrics were retrieved (Lyrics_Service success). */
  lyricsResolved: boolean;
}

/**
 * Result of a transition method. On success the Round moved to `state`; on
 * failure the Round is UNCHANGED and still in `state`, with `reason` explaining
 * the rejection. Discriminated by `ok` so callers branch exhaustively.
 */
export type RoundTransition =
  | { ok: true; state: RoundState }
  | { ok: false; reason: RoundTransitionReason; state: RoundState };

/**
 * Result of {@link RoundLifecycle.enterScoring}. On success the Round entered
 * `'scoring'` AFTER `finalize()` ran to completion, and `result` carries
 * whatever the finalizer returned (typically the finalized `RoundResult`). On
 * failure the finalizer was NEVER invoked and the Round is unchanged in `state`.
 *
 * @typeParam R The finalizer's return type (e.g. `RoundResult`, or `void`).
 */
export type RoundScoringResult<R> =
  | { ok: true; state: 'scoring'; result: R }
  | { ok: false; reason: RoundTransitionReason; state: RoundState };

export class RoundLifecycle {
  /** Current Round lifecycle state (design.md "Round State Machine"). */
  private _state: RoundState;

  /**
   * Whether audio resolution has succeeded for the pending track. Reset to
   * `false` whenever the Round (re-)enters the `'resolving'` phase, and set from
   * the {@link RoundResolution} reported via {@link reportResolution}. Exposed so
   * the readiness gate (and the 17.4 "audio failed" path) is inspectable.
   */
  private _audioResolved = false;

  /**
   * Whether lyric retrieval has succeeded for the pending track. Reset to
   * `false` whenever the Round (re-)enters the `'resolving'` phase, and set from
   * the {@link RoundResolution} reported via {@link reportResolution}.
   */
  private _lyricsResolved = false;

  /**
   * @param initialState Starting state, defaulting to `'lobby'` (`[*] -> Lobby`
   *   in the diagram). An explicit value is accepted so a host/server can
   *   reconstruct a lifecycle at a known state; normal use starts at `'lobby'`.
   */
  constructor(initialState: RoundState = 'lobby') {
    this._state = initialState;
  }

  /** The current Round lifecycle state. */
  get state(): RoundState {
    return this._state;
  }

  /** Whether audio resolution has succeeded for the pending track (see field doc). */
  get audioResolved(): boolean {
    return this._audioResolved;
  }

  /** Whether lyric retrieval has succeeded for the pending track (see field doc). */
  get lyricsResolved(): boolean {
    return this._lyricsResolved;
  }

  // -------------------------------------------------------------------------
  // Transitions (each enforces the diagram's allowed edges)
  // -------------------------------------------------------------------------

  /**
   * `Lobby -> Resolving`: the Host selected a track, so resolution of audio and
   * lyrics begins. Resets the resolution booleans (a fresh track is unresolved).
   * Rejected as `'invalid_transition'` from any state other than `'lobby'`.
   */
  selectTrack(): RoundTransition {
    if (this._state !== 'lobby') return this.reject();
    this.beginResolving();
    return this.ok('resolving');
  }

  /**
   * `Resolving -> Ready` (when `audioResolved && lyricsResolved`) or
   * `Resolving -> ResolveFailed` (otherwise). Records the reported resolution
   * booleans and routes to the correct state (design.md Round State Machine).
   *
   * The 17.4 case — lyrics available but audio could not be resolved
   * (`{ audioResolved: false, lyricsResolved: true }`) — routes to
   * `'resolve_failed'`, NOT `'ready'`, so {@link start} can never succeed for it.
   *
   * Rejected as `'invalid_transition'` from any state other than `'resolving'`.
   */
  reportResolution(resolution: RoundResolution): RoundTransition {
    if (this._state !== 'resolving') return this.reject();
    this._audioResolved = resolution.audioResolved;
    this._lyricsResolved = resolution.lyricsResolved;
    const next: RoundState =
      resolution.audioResolved && resolution.lyricsResolved ? 'ready' : 'resolve_failed';
    this._state = next;
    return this.ok(next);
  }

  /**
   * `ResolveFailed -> Resolving`: retry resolution / resolve a newly picked
   * track after a failure. Resets the resolution booleans for the new attempt.
   * Rejected as `'invalid_transition'` from any state other than
   * `'resolve_failed'`.
   */
  retry(): RoundTransition {
    if (this._state !== 'resolve_failed') return this.reject();
    this.beginResolving();
    return this.ok('resolving');
  }

  /**
   * `Ready -> Playing`: the Host starts the Round. Allowed ONLY from `'ready'`.
   * From any other state this returns `{ ok: false, reason: 'not_ready' }` and
   * does not change state — the "track not ready" rejection of Requirement 10.5
   * (covering `lobby`/`resolving`/`resolve_failed`) and the scored-round audio
   * guard of Requirement 17.4 (a failed audio resolution sits in
   * `'resolve_failed'`, never `'ready'`).
   */
  start(): RoundTransition {
    if (this._state !== 'ready') {
      return { ok: false, reason: 'not_ready', state: this._state };
    }
    this._state = 'playing';
    return this.ok('playing');
  }

  /**
   * `Ready -> Lobby`: the Host abandons the ready track to pick a different one,
   * returning to the Lobby. Clears the resolution booleans. Rejected as
   * `'invalid_transition'` from any state other than `'ready'`.
   */
  pickDifferentTrack(): RoundTransition {
    if (this._state !== 'ready') return this.reject();
    this.toLobby();
    return this.ok('lobby');
  }

  /**
   * `Playing -> Scoring`: the last Lyric_Line's drop window closed OR the audio
   * track ended (Requirement 10.3). FINALIZES the Round result COMPLETELY BEFORE
   * entering `'scoring'` (Requirement 10.4): `finalize()` runs FIRST while still
   * `'playing'`, and only after it returns is `state` set to `'scoring'` and the
   * result handed back. See the class "Finalize-before-notify" note — this call
   * order is exactly what guarantees no Client is notified to show the Scorecard
   * before the result is fully finalized.
   *
   * Typical wiring: `enterScoring(() => { for (const id of lineIds)
   * game.finalizeLine(id); return game.getRoundResult(); })`.
   *
   * Rejected as `'invalid_transition'` from any state other than `'playing'`,
   * in which case `finalize` is NEVER invoked. If `finalize` throws, the error
   * propagates and the Round stays `'playing'` (fail-closed: no scoring, no
   * notify).
   *
   * @typeParam R The finalizer's return type (e.g. the finalized `RoundResult`).
   */
  enterScoring<R>(finalize: () => R): RoundScoringResult<R> {
    if (this._state !== 'playing') {
      return { ok: false, reason: 'invalid_transition', state: this._state };
    }
    // 10.4: finalize COMPLETELY before the scoring state becomes observable.
    const result = finalize();
    this._state = 'scoring';
    return { ok: true, state: 'scoring', result };
  }

  /**
   * `Scoring -> Lobby`: a Round has ended and the Host starts a new Round with a
   * newly selected track (Requirement 10.6). Returns to the Lobby and clears the
   * resolution booleans so the next track resolves from scratch. Rejected as
   * `'invalid_transition'` from any state other than `'scoring'`.
   */
  newRound(): RoundTransition {
    if (this._state !== 'scoring') return this.reject();
    this.toLobby();
    return this.ok('lobby');
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Enter the `'resolving'` phase with both resolution booleans reset. */
  private beginResolving(): void {
    this._audioResolved = false;
    this._lyricsResolved = false;
    this._state = 'resolving';
  }

  /** Return to `'lobby'` with both resolution booleans cleared. */
  private toLobby(): void {
    this._audioResolved = false;
    this._lyricsResolved = false;
    this._state = 'lobby';
  }

  /** Build a successful transition result for the new `state`. */
  private ok(state: RoundState): RoundTransition {
    return { ok: true, state };
  }

  /** Build an `'invalid_transition'` rejection carrying the unchanged state. */
  private reject(): RoundTransition {
    return { ok: false, reason: 'invalid_transition', state: this._state };
  }
}
