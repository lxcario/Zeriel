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

/** Props for {@link ScorecardScreen}. */
export interface ScorecardScreenProps {
  /** The finalized Round result to display + export (Requirement 11.1). */
  result: RoundResult;
  /** Start a new Round from the Lobby (Requirement 10.6). */
  onPlayAgain: () => void;
}

/** The end-of-round surface: heading, the Scorecard, and a play-again control. */
export function ScorecardScreen({ result, onPlayAgain }: ScorecardScreenProps) {
  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-16">
        <header className="text-center">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-indigo-300">
            Zeriel
          </p>
          <h1 className="mt-1 text-4xl font-bold tracking-tight text-neutral-50">
            Round complete
          </h1>
        </header>

        <Scorecard result={result} />

        <div className="flex justify-center">
          <button
            type="button"
            onClick={onPlayAgain}
            className="inline-flex items-center justify-center rounded-full bg-indigo-500 px-8 py-3 text-base font-semibold text-white transition-colors hover:bg-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-400/60"
          >
            Play again
          </button>
        </div>
      </div>
    </main>
  );
}

export default ScorecardScreen;
