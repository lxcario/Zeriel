/**
 * Song_Picker controller (task 10.1).
 *
 * Framework-agnostic logic implementing the `SongPicker` contract from
 * design.md so it is unit/property testable WITHOUT a DOM. The React view
 * (`SongPicker.tsx`) is a thin shell over this controller.
 *
 * Design references (design.md "Song_Picker", Requirement 3):
 *
 * ```typescript
 * interface SongPicker {
 *   search(query: string): Promise<TrackCandidate[]>;  // 3.1 returns title+artist candidates
 *   select(candidate: TrackCandidate): void;           // 3.2 records pending track
 *   readonly isSearching: boolean;                      // 3.5 blocks resubmission while true
 *   canControl(ctx: ModeContext): boolean;             // 3.6 SP: player; MP: host only
 * }
 * ```
 *
 * Behaviors implemented here:
 * - {@link SongPickerController.search} calls the injected {@link SearchBackend}
 *   (which routes through `fetchWithTimeout`), exposing candidates with title +
 *   artist (Requirement 3.1 / Property 7).
 * - {@link SongPickerController.select} records the chosen candidate as the
 *   pending track (Requirement 3.2 / Property 8).
 * - {@link SongPickerController.isSearching} is `true` while a search is in
 *   flight; a `search()` call made while already searching is ignored and the
 *   in-flight promise is returned, so AT MOST ONE search is ever in flight
 *   (Requirement 3.5 / Property 9).
 * - A completed search that returned zero candidates raises {@link
 *   SongPickerController.noResults}; a new query is only accepted after the
 *   current request completes (Requirement 3.4).
 * - {@link SongPickerController.canControl} grants control to the single player
 *   in single mode and to the Host only in multiplayer (Requirement 3.6 /
 *   Property 10).
 *
 * The controller is observable: pass an `onChange` callback (the React view
 * subscribes to it) to re-read state after each transition. All network is
 * behind the injected backend, keeping this module deterministic in tests.
 */

import type { TrackCandidate } from '@glitch/core';
import type { SearchFailure } from '../services/errorMessages.ts';
import type { SearchBackend, SongSearchResult } from './searchBackend.ts';

/**
 * Identifies the play mode and the viewer's role, used by {@link
 * SongPickerController.canControl} to gate search/selection (Requirement 3.6).
 *
 * Shape:
 * - `{ mode: 'single' }` — Single_Player_Mode. The single Player always
 *   controls the picker (`isHost` is irrelevant and optional).
 * - `{ mode: 'multi', isHost: boolean }` — multiplayer. Only the Host may
 *   search/select; non-hosts get a read-only picker.
 */
export type ModeContext =
  | { mode: 'single'; isHost?: boolean }
  | { mode: 'multi'; isHost: boolean };

/**
 * Decide whether the current viewer may search/select in the Song_Picker
 * (Requirement 3.6 / Property 10). Pure and total:
 * - single mode → always `true` (the single Player controls).
 * - multi mode  → `true` iff the viewer is the Host.
 */
export function canControl(ctx: ModeContext): boolean {
  if (ctx.mode === 'single') return true;
  return ctx.isHost === true;
}

/** Immutable view of the controller state, consumed by the React view. */
export interface SongPickerState {
  /** The most recent committed search query (empty before any search). */
  query: string;
  /** Candidates from the last completed search (Requirement 3.1). */
  candidates: TrackCandidate[];
  /** `true` while a search request is in flight (Requirement 3.5). */
  isSearching: boolean;
  /**
   * `true` when the last COMPLETED search returned zero candidates
   * (Requirement 3.4). Reset to `false` while a new search is in flight.
   */
  noResults: boolean;
  /** The candidate recorded as the pending track, if any (Requirement 3.2). */
  pendingTrack: TrackCandidate | null;
  /** The typed failure from the last search, if it failed (Requirements 17.1). */
  lastError: SearchFailure | null;
}

/** Construction options for {@link SongPickerController}. */
export interface SongPickerControllerOptions {
  /** The injected search backend (network behind it). */
  backend: SearchBackend;
  /** Optional subscriber notified after every state transition. */
  onChange?: (state: SongPickerState) => void;
}

/**
 * Framework-agnostic Song_Picker controller implementing the `SongPicker`
 * contract logic. Holds search state, enforces single-in-flight, records the
 * pending track, and answers control authorization.
 */
export class SongPickerController {
  private readonly backend: SearchBackend;
  private readonly onChange: ((state: SongPickerState) => void) | undefined;

  private _query = '';
  private _candidates: TrackCandidate[] = [];
  private _noResults = false;
  private _pendingTrack: TrackCandidate | null = null;
  private _lastError: SearchFailure | null = null;

  /**
   * The single in-flight search promise, or `null` when idle. Its presence IS
   * the "searching" state and the lock that enforces at-most-one-in-flight
   * (Requirement 3.5 / Property 9).
   */
  private inFlight: Promise<TrackCandidate[]> | null = null;

  constructor(options: SongPickerControllerOptions) {
    this.backend = options.backend;
    this.onChange = options.onChange;
  }

  /** `true` while a search request is pending (Requirement 3.5). */
  get isSearching(): boolean {
    return this.inFlight !== null;
  }

  /** The candidate recorded as the pending track, or `null` (Requirement 3.2). */
  get pendingTrack(): TrackCandidate | null {
    return this._pendingTrack;
  }

  /** Snapshot the current state (a fresh object; arrays are copied). */
  getState(): SongPickerState {
    return {
      query: this._query,
      candidates: this._candidates.slice(),
      isSearching: this.isSearching,
      noResults: this._noResults,
      pendingTrack: this._pendingTrack,
      lastError: this._lastError,
    };
  }

  /**
   * Search the backend for track candidates (Requirement 3.1).
   *
   * Enforces single-in-flight (Requirement 3.5 / Property 9): if a search is
   * already running, the new call is IGNORED and the existing in-flight promise
   * is returned, so a caller can never launch a second concurrent request and
   * resubmission is blocked until the current search completes (Requirement
   * 3.4 also depends on this — a new query is only honored once idle).
   *
   * Resolves to the candidate list (empty on no-results or failure). Never
   * rejects: a backend failure is captured in `lastError` and surfaced via the
   * error-mapping layer; the promise resolves to `[]`.
   */
  search(query: string): Promise<TrackCandidate[]> {
    // Requirement 3.5 / 3.4: block resubmission while a request is pending.
    if (this.inFlight !== null) {
      return this.inFlight;
    }

    this._query = query;
    this._noResults = false;
    this._lastError = null;

    const run = this.runSearch(query);
    this.inFlight = run;
    // Entering the searching state (isSearching flips true).
    this.emit();
    return run;
  }

  /** Execute the backend call and settle controller state exactly once. */
  private async runSearch(query: string): Promise<TrackCandidate[]> {
    let result: SongSearchResult;
    try {
      result = await this.backend(query);
    } catch {
      // Defensive: a backend that rejects is treated as a network failure so
      // the contract "search never rejects" holds.
      result = { ok: false, failure: { ok: false, reason: 'network' } };
    }

    if (result.ok) {
      this._candidates = result.candidates;
      this._noResults = result.candidates.length === 0; // Requirement 3.4
      this._lastError = null;
    } else {
      this._candidates = [];
      this._noResults = false;
      this._lastError = result.failure;
    }

    // Clear the in-flight lock BEFORE notifying so observers (and any queued
    // resubmission) see an idle, ready-to-search controller (Requirement 3.4).
    this.inFlight = null;
    this.emit();
    return this._candidates;
  }

  /**
   * Record the selected candidate as the pending track for the next Round
   * (Requirement 3.2 / Property 8). Selection is independent of search state.
   */
  select(candidate: TrackCandidate): void {
    this._pendingTrack = candidate;
    this.emit();
  }

  /**
   * Whether the given mode/role context may search and select (Requirement
   * 3.6 / Property 10). Delegates to the pure {@link canControl}.
   */
  canControl(ctx: ModeContext): boolean {
    return canControl(ctx);
  }

  /** Notify the subscriber, if any, with a fresh state snapshot. */
  private emit(): void {
    this.onChange?.(this.getState());
  }
}

/**
 * Factory mirroring the typical `create*` style used elsewhere in the client.
 * Returns a ready {@link SongPickerController}.
 */
export function createSongPickerController(
  options: SongPickerControllerOptions,
): SongPickerController {
  return new SongPickerController(options);
}
