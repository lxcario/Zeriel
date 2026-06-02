/**
 * Round screen — hosts the in-round gameplay canvas (task 14.1, session-aware
 * in task 18.1).
 *
 * This screen frames the gameplay {@link RoundCanvas} with minimal page chrome
 * and forwards the active session topology so the canvas can switch between the
 * single-player {@link LocalGameHost} and the multiplayer {@link RemoteGameHost}
 * (Requirements 15.1/15.4/16.1). Per Requirement 18.3/18.4 the in-round PLAY
 * AREA (the canvas) uses the handmade aesthetic and never the premium art
 * direction; the surrounding page is kept intentionally bare so it does not
 * bleed the premium look into the play area.
 */

import type { RoundResult } from '@glitch/core';
import { RoundCanvas, type RoundCanvasDeps } from './RoundCanvas.tsx';
import type { RoundPlan } from './resolveRound.ts';
import type { SessionMode } from './sessionMode.ts';

/** Props for {@link RoundScreen}. */
export interface RoundScreenProps {
  /** The resolved assets for this Round. */
  plan: RoundPlan;
  /**
   * The session topology for this Round (Requirements 15.1/15.4). Omitted →
   * single-player; a multiplayer session layers presence/cursor/locks on top.
   */
  sessionMode?: SessionMode;
  /** Effective Reduce_Motion_Mode for the gameplay Renderer (Requirement 13.1). */
  reduceMotion: boolean;
  /** Called once the Round finalizes, to advance to the Scorecard (10.4). */
  onRoundComplete: (result: RoundResult) => void;
  /** Pipeline injection hooks for tests. */
  canvasDeps?: RoundCanvasDeps;
}

/** The in-round screen: a bare dark stage hosting the handmade-aesthetic canvas. */
export function RoundScreen({
  plan,
  sessionMode,
  reduceMotion,
  onRoundComplete,
  canvasDeps,
}: RoundScreenProps) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-black p-4">
      <RoundCanvas
        plan={plan}
        reduceMotion={reduceMotion}
        onRoundComplete={onRoundComplete}
        {...(sessionMode ? { sessionMode } : {})}
        {...(canvasDeps ? { deps: canvasDeps } : {})}
      />
    </main>
  );
}

export default RoundScreen;
