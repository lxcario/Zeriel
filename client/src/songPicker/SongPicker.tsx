/**
 * Song_Picker React view (task 10.1) — a Premium_Entry_Surface.
 *
 * Design references:
 * - design.md "Song_Picker": Premium_Entry_Surface for searching/selecting a
 *   track. Lists candidates with title + artist (3.1), records the pending
 *   track on selection (3.2), shows a loading indicator and blocks resubmission
 *   while a search is in flight (3.4, 3.5), gates control by mode/role (3.6),
 *   and uses its OWN art direction with NO Spotify branding (3.3, 18.5).
 * - Requirement 18.1: present the Song_Picker with a clean layout, refined
 *   typography, and a dark premium color palette.
 * - Requirement 13.5 (spirit): semantic labels for interactive controls.
 *
 * This view is a thin shell over {@link SongPickerController}: all search/state
 * logic lives in the controller (testable without a DOM). The component
 * subscribes to controller `onChange` notifications via local React state.
 *
 * ## No Spotify branding (Requirements 3.3, 18.5)
 * The styling uses the project's own dark premium palette (neutral/indigo
 * Tailwind tokens) and original copy. It deliberately does NOT use Spotify's
 * name, wordmark, logo, brand green (#1DB954), or any trademarked asset. The
 * art direction is "Spotify-style" only in polish, not in brand reproduction.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { TrackCandidate } from '@glitch/core';
import {
  createSongPickerController,
  type ModeContext,
  type SongPickerState,
} from './songPickerController.ts';
import type { SearchBackend } from './searchBackend.ts';
import { mapExternalError } from '../services/errorMessages.ts';

/** Props for {@link SongPicker}. */
export interface SongPickerProps {
  /** Injected search backend (network behind it; deterministic in tests). */
  backend: SearchBackend;
  /** Play mode + viewer role; gates control per Requirement 3.6. */
  mode: ModeContext;
  /** Optional callback fired when a candidate is recorded as pending (3.2). */
  onSelect?: (candidate: TrackCandidate) => void;
}

/** Format a track duration (seconds) as `m:ss`; blank when unknown. */
function formatDuration(durationSec: number): string {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return '';
  const total = Math.round(durationSec);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * The Song_Picker premium entry surface. Renders a search input + submit, a
 * loading indicator and blocked submit while searching, a candidate list with
 * title + artist, a "no results" message, and selection wiring — all gated by
 * the viewer's control authorization.
 */
export function SongPicker({ backend, mode, onSelect }: SongPickerProps) {
  // The controller is created once and notifies us of state changes. We mirror
  // its state into React state so the view re-renders on each transition.
  const [state, setState] = useState<SongPickerState>(() => ({
    query: '',
    candidates: [],
    isSearching: false,
    noResults: false,
    pendingTrack: null,
    lastError: null,
  }));

  const controllerRef = useRef(
    createSongPickerController({ backend, onChange: setState }),
  );

  // Local controlled value for the input (separate from the committed query).
  const [inputValue, setInputValue] = useState('');

  // Initialize state from the controller on mount.
  useEffect(() => {
    setState(controllerRef.current.getState());
  }, []);

  const canControl = useMemo(
    () => controllerRef.current.canControl(mode),
    [mode],
  );

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!canControl) return; // Requirement 3.6: non-controllers cannot search.
      const query = inputValue.trim();
      if (query === '') return;
      // Requirement 3.5: the controller ignores this if a search is in flight.
      void controllerRef.current.search(query);
    },
    [canControl, inputValue],
  );

  const handleSelect = useCallback(
    (candidate: TrackCandidate) => {
      if (!canControl) return; // Requirement 3.6.
      controllerRef.current.select(candidate);
      onSelect?.(candidate);
    },
    [canControl, onSelect],
  );

  const { isSearching, candidates, noResults, pendingTrack, lastError } = state;

  // Submit is blocked while searching (3.5), when the viewer can't control
  // (3.6), or when the query is empty.
  const submitDisabled = isSearching || !canControl || inputValue.trim() === '';

  const errorPresentation = lastError ? mapExternalError(lastError) : null;

  return (
    <section
      aria-labelledby="song-picker-heading"
      className="xmb-panel mx-auto w-full max-w-2xl p-6 text-neutral-100"
    >
      <header className="mb-5">
        <h2
          id="song-picker-heading"
          className="xmb-title text-2xl font-semibold tracking-tight text-white"
        >
          Pick a song
        </h2>
        <p className="mt-1 text-sm text-sky-200/70">
          Search for a track to queue up for the next round.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="flex items-stretch gap-2" role="search">
        <label htmlFor="song-picker-search" className="sr-only">
          Search for a song by title or artist
        </label>
        <input
          id="song-picker-search"
          name="song-search"
          type="search"
          autoComplete="off"
          placeholder="Search songs and artists"
          value={inputValue}
          disabled={!canControl}
          aria-disabled={!canControl}
          onChange={(e) => setInputValue(e.target.value)}
          className="flex-1 rounded-lg border border-sky-300/25 bg-[#0a1226]/70 px-4 py-2.5 text-base text-white placeholder:text-sky-200/40 focus:border-sky-300/70 focus:outline-none focus:ring-2 focus:ring-sky-400/40 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={submitDisabled}
          aria-disabled={submitDisabled}
          className="xmb-button inline-flex items-center justify-center rounded-lg px-5 py-2.5 text-base font-medium text-white transition-transform hover:scale-[1.03] focus:outline-none focus:ring-2 focus:ring-sky-300/70 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100"
        >
          {isSearching ? 'Searching…' : 'Search'}
        </button>
      </form>

      {/* Control-gating notice for non-controllers in multiplayer (3.6). */}
      {!canControl && (
        <p className="mt-3 text-sm text-amber-300/90" role="note">
          Only the host can search for and choose a song.
        </p>
      )}

      {/* Loading indicator while a search is in flight (Requirement 3.5). */}
      {isSearching && (
        <div
          className="mt-4 flex items-center gap-2 text-sm text-sky-100/80"
          role="status"
          aria-live="polite"
        >
          <span
            aria-hidden="true"
            className="h-4 w-4 animate-spin rounded-full border-2 border-sky-300/30 border-t-sky-300"
          />
          <span>Searching for tracks…</span>
        </div>
      )}

      {/* No-results message for a completed empty search (Requirement 3.4). */}
      {!isSearching && noResults && (
        <p className="mt-4 text-sm text-sky-100/80" role="status" aria-live="polite">
          No results found{state.query ? ` for “${state.query}”` : ''}. Try a different search.
        </p>
      )}

      {/* Actionable error message for a failed search (Requirements 17.1, 17.5). */}
      {!isSearching && errorPresentation && (
        <div className="mt-4 rounded-lg border border-red-400/40 bg-red-500/10 p-3" role="alert">
          <p className="text-sm text-red-200">{errorPresentation.message}</p>
        </div>
      )}

      {/* Candidate list with title + artist (Requirement 3.1). */}
      {!isSearching && candidates.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2" aria-label="Search results">
          {candidates.map((candidate) => {
            const isPending =
              pendingTrack !== null && pendingTrack.videoId === candidate.videoId;
            const duration = formatDuration(candidate.durationSec);
            return (
              <li key={candidate.videoId}>
                <button
                  type="button"
                  disabled={!canControl}
                  aria-disabled={!canControl}
                  aria-pressed={isPending}
                  onClick={() => handleSelect(candidate)}
                  className={[
                    'group flex w-full items-center justify-between gap-4 rounded-lg border px-4 py-3 text-left transition-all',
                    isPending
                      ? 'border-sky-300/70 bg-sky-400/15 shadow-[0_0_18px_rgba(120,180,255,0.25)]'
                      : 'border-sky-300/15 bg-[#0a1226]/50 hover:border-sky-300/45 hover:bg-sky-400/10 hover:translate-x-1',
                    'disabled:cursor-not-allowed disabled:opacity-60',
                  ].join(' ')}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-white">
                      {candidate.title}
                    </span>
                    <span className="block truncate text-sm text-sky-200/60">
                      {candidate.artist}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    {duration && (
                      <span className="text-sm tabular-nums text-sky-200/50">{duration}</span>
                    )}
                    {isPending && (
                      <span className="rounded-full bg-sky-400/25 px-2 py-0.5 text-xs font-medium text-sky-100 ring-1 ring-sky-300/40">
                        Selected
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Pending-track confirmation (Requirement 3.2). */}
      {pendingTrack && (
        <p className="mt-4 text-sm text-sky-100/80" aria-live="polite">
          Pending track:{' '}
          <span className="font-medium text-white">{pendingTrack.title}</span>
          {' — '}
          <span className="text-sky-200/60">{pendingTrack.artist}</span>
        </p>
      )}
    </section>
  );
}

export default SongPicker;
