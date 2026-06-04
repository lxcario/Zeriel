/**
 * Lobby — a Premium_Entry_Surface hosting the Song_Picker and Round controls
 * (task 14.1).
 *
 * Design references:
 * - Requirement 18.1: Lobby presented as a Premium_Entry_Surface (clean dark
 *   layout, refined typography).
 * - Requirement 18.2: the Reduce_Motion_Mode toggle lives on a premium surface;
 *   no Spotify branding (the Song_Picker is brand-free by construction).
 * - Requirement 13.5: semantic headings + labeled controls.
 * - Requirement 3.6: in single-player the lone Player controls the picker.
 * - Requirement 4.5/4.6/6.4/6.5/17.x: resolution status + actionable, retryable
 *   error states (resolving indicator, retry, pick different track, continue
 *   lyrics-free) via the shared `mapExternalError` mapping.
 * - Requirement 10.5/17.4: the Start control is disabled until a track's audio
 *   (and lyrics, unless continuing lyrics-free) are resolved — a scored Round
 *   cannot start without resolved audio.
 *
 * The Lobby owns the selection → resolve → ready sub-flow and hands the final
 * {@link RoundPlan} up to the shell (which mounts the in-round canvas).
 */

import { useCallback, useState } from 'react';
import type { TrackCandidate } from '@glitch/core';
import { SongPicker } from '../songPicker/index.ts';
import type { SearchBackend, ModeContext } from '../songPicker/index.ts';
import { mapExternalError } from '../services/errorMessages.ts';
import { ReduceMotionToggle } from './ReduceMotionToggle.tsx';
import XmbStage from './XmbStage.tsx';
import {
  resolveRoundAssets,
  type ResolveRoundDeps,
  type RoundPlan,
} from './resolveRound.ts';

/** Single-player mode context — the lone Player always controls the picker (3.6). */
const SINGLE_PLAYER_MODE: ModeContext = { mode: 'single' };

/** Phase of the Lobby's selection → resolve → ready sub-flow. */
type ResolvePhase =
  | { kind: 'idle' }
  | { kind: 'resolving'; candidate: TrackCandidate }
  | { kind: 'ready'; plan: RoundPlan }
  | {
      kind: 'failed';
      candidate: TrackCandidate;
      stage: 'audio' | 'lyrics';
      // The typed failure, mapped to an actionable presentation by the UI.
      failure: Parameters<typeof mapExternalError>[0];
      // Whether the failure was specifically "no synced lyrics" (offers lyrics-free).
      noLyrics: boolean;
    };

/** Props for {@link Lobby}. */
export interface LobbyProps {
  /** Search backend injected into the Song_Picker (network behind it). */
  backend: SearchBackend;
  /** Effective Reduce_Motion_Mode value. */
  reduceMotion: boolean;
  /** Persisted toggle handler (lifts the new value to the shell). */
  onReduceMotionChange: (enabled: boolean) => void;
  /** Called with the resolved plan when the Host starts the Round (10.1/10.5). */
  onStartRound: (plan: RoundPlan) => void;
  /** Resolver injection for tests; defaults wire the real Audio/Lyrics services. */
  resolveDeps?: ResolveRoundDeps;
}

/**
 * The pre-Round Lobby. Renders the Song_Picker, the Reduce_Motion toggle, the
 * resolving/failed/ready status for the selected track, and the Start control.
 */
export function Lobby({
  backend,
  reduceMotion,
  onReduceMotionChange,
  onStartRound,
  resolveDeps,
}: LobbyProps) {
  const [phase, setPhase] = useState<ResolvePhase>({ kind: 'idle' });

  /** Resolve a candidate's audio + lyrics, transitioning the phase. */
  const resolve = useCallback(
    async (candidate: TrackCandidate, continueLyricsFree: boolean) => {
      setPhase({ kind: 'resolving', candidate });
      const result = await resolveRoundAssets(candidate, {
        ...resolveDeps,
        continueLyricsFree,
      });
      if (result.ok) {
        setPhase({ kind: 'ready', plan: result.plan });
        return;
      }
      setPhase({
        kind: 'failed',
        candidate,
        stage: result.stage,
        failure: result.failure,
        noLyrics: result.stage === 'lyrics' && result.failure.reason === 'no_lyrics',
      });
    },
    [resolveDeps],
  );

  /** Selecting a track in the picker kicks off resolution (Requirement 4.1/6.1). */
  const handleSelect = useCallback(
    (candidate: TrackCandidate) => {
      void resolve(candidate, false);
    },
    [resolve],
  );

  const handleRetry = useCallback(() => {
    if (phase.kind === 'failed') void resolve(phase.candidate, false);
  }, [phase, resolve]);

  const handleContinueLyricsFree = useCallback(() => {
    if (phase.kind === 'failed') void resolve(phase.candidate, true);
  }, [phase, resolve]);

  const handlePickDifferent = useCallback(() => {
    setPhase({ kind: 'idle' });
  }, []);

  const handleStart = useCallback(() => {
    if (phase.kind === 'ready') onStartRound(phase.plan);
  }, [phase, onStartRound]);

  const errorPresentation =
    phase.kind === 'failed' ? mapExternalError(phase.failure) : null;

  return (
    <XmbStage reduceMotion={reduceMotion} className="text-neutral-100">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-16">
        <header className="flex items-start justify-between gap-6">
          <div>
            <p className="text-sm font-medium uppercase tracking-[0.3em] text-sky-300">
              Zeriel
            </p>
            <h1 className="xmb-title mt-1 text-4xl font-bold tracking-tight text-white">
              Lobby
            </h1>
            <p className="mt-2 text-base text-sky-100/80">
              Pick a track and start your single-player round.
            </p>
          </div>
        </header>

        {/* Accessibility: Reduce_Motion_Mode toggle on a premium surface (18.2). */}
        <section
          aria-labelledby="settings-heading"
          className="xmb-panel p-5"
        >
          <h2 id="settings-heading" className="sr-only">
            Accessibility settings
          </h2>
          <ReduceMotionToggle enabled={reduceMotion} onChange={onReduceMotionChange} />
        </section>

        {/* Song_Picker (its own premium art direction, no Spotify branding). */}
        <SongPicker backend={backend} mode={SINGLE_PLAYER_MODE} onSelect={handleSelect} />

        {/* Resolution status + actionable error/ready states. */}
        {phase.kind === 'resolving' && (
          <section
            className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5"
            role="status"
            aria-live="polite"
          >
            <div className="flex items-center gap-3 text-neutral-200">
              <span
                aria-hidden="true"
                className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-600 border-t-indigo-400"
              />
              <span>
                Resolving audio and lyrics for{' '}
                <span className="font-medium text-neutral-50">{phase.candidate.title}</span>…
              </span>
            </div>
          </section>
        )}

        {phase.kind === 'failed' && errorPresentation && (
          <section
            className="rounded-2xl border border-red-500/40 bg-red-500/10 p-5"
            role="alert"
          >
            <h2 className="text-base font-semibold text-red-100">
              {phase.stage === 'audio' ? "Couldn't load audio" : "Couldn't load lyrics"}
            </h2>
            <p className="mt-1 text-sm text-red-100/90">{errorPresentation.message}</p>
            <div className="mt-4 flex flex-wrap gap-3">
              {errorPresentation.actions.map((action) => {
                if (action.kind === 'retry') {
                  return (
                    <button
                      key={action.kind}
                      type="button"
                      onClick={handleRetry}
                      className="inline-flex items-center justify-center rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-400/50"
                    >
                      {action.label}
                    </button>
                  );
                }
                if (action.kind === 'continue_lyrics_free') {
                  return (
                    <button
                      key={action.kind}
                      type="button"
                      onClick={handleContinueLyricsFree}
                      className="inline-flex items-center justify-center rounded-lg border border-neutral-600 bg-neutral-900 px-4 py-2 text-sm font-medium text-neutral-100 transition-colors hover:border-neutral-400 hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-indigo-400/40"
                    >
                      {action.label}
                    </button>
                  );
                }
                return (
                  <button
                    key={action.kind}
                    type="button"
                    onClick={handlePickDifferent}
                    className="inline-flex items-center justify-center rounded-lg border border-neutral-600 bg-neutral-900 px-4 py-2 text-sm font-medium text-neutral-100 transition-colors hover:border-neutral-400 hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-indigo-400/40"
                  >
                    {action.label}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {phase.kind === 'ready' && (
          <section
            aria-labelledby="ready-heading"
            className="xmb-panel p-5 ring-1 ring-sky-300/40"
          >
            <h2 id="ready-heading" className="text-base font-semibold text-sky-100">
              Ready to play
            </h2>
            <p className="mt-1 text-sm text-sky-100/90">
              <span className="font-medium">{phase.plan.candidate.title}</span> by{' '}
              {phase.plan.candidate.artist}
              {phase.plan.lyricsFree ? ' — playing without synced lyrics.' : '.'}
            </p>
            <button
              type="button"
              onClick={handleStart}
              className="xmb-button mt-4 inline-flex items-center justify-center rounded-lg px-6 py-2.5 text-base font-semibold text-white transition-transform hover:scale-[1.03] focus:outline-none focus:ring-2 focus:ring-sky-300/70"
            >
              Start round
            </button>
          </section>
        )}
      </div>
    </XmbStage>
  );
}

export default Lobby;
