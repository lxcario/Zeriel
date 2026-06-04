/**
 * Scorecard screen — the end-of-round Premium_Entry_Surface wrapper (task 14.1).
 *
 * Wraps the {@link Scorecard} view (track title, group total, per-Player
 * contributions, copy/download export — Requirement 11) with the premium page
 * chrome and a "Play again" control that returns to the Lobby (Requirement
 * 10.6). The Scorecard itself is rendered for the single Player's result
 * (Requirement 11.6).
 */

import type { RoundResult } from '@glitch/core';
import { Scorecard } from '../scorecard/index.ts';
import XmbStage from './XmbStage.tsx';

/** Props for {@link ScorecardScreen}. */
export interface ScorecardScreenProps {
  /** The finalized Round result to display + export (Requirement 11.1). */
  result: RoundResult;
  /** Start a new Round from the Lobby (Requirement 10.6). */
  onPlayAgain: () => void;
  /** Effective Reduce_Motion_Mode (freezes the XMB backdrop, Requirement 13.1). */
  reduceMotion?: boolean;
}

/** The end-of-round surface: heading, the Scorecard, and a play-again control. */
export function ScorecardScreen({ result, onPlayAgain, reduceMotion = false }: ScorecardScreenProps) {
  return (
    <XmbStage reduceMotion={reduceMotion} className="text-neutral-100">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-16">
        <header className="text-center">
          <p className="text-sm font-medium uppercase tracking-[0.3em] text-sky-300">
            Zeriel
          </p>
          <h1 className="xmb-title mt-1 text-4xl font-bold tracking-tight text-white">
            Round complete
          </h1>
        </header>

        <Scorecard result={result} />

        <div className="flex justify-center">
          <button
            type="button"
            onClick={onPlayAgain}
            className="xmb-button inline-flex items-center justify-center rounded-full px-8 py-3 text-base font-semibold text-white transition-transform hover:scale-[1.03] focus:outline-none focus:ring-2 focus:ring-sky-300/70"
          >
            Play again
          </button>
        </div>
      </div>
    </XmbStage>
  );
}

export default ScorecardScreen;
