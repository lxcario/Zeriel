/**
 * Zeriel — root React UI shell (task 14.1).
 *
 * Wires the complete SINGLE-PLAYER flow end-to-end as a routed screen state
 * machine over the design's Round State Machine (design.md "Round State
 * Machine"):
 *
 *   Landing_Page → Lobby (Song_Picker → resolve audio + lyrics)
 *     → Round (LocalGameHost drives GameCore + Renderer + Audio on the canvas)
 *       → Scorecard  → [play again] → Lobby
 *
 * Responsibilities:
 * - Owns the top-level screen route and the effective Reduce_Motion_Mode. The
 *   reduce-motion value is threaded into the in-round Renderer (Requirement
 *   13.1) and the Landing_Page headline reveal (Requirement 19.6); the toggle
 *   on the Lobby persists an explicit choice (Requirement 13.3).
 * - Hosts the Premium_Entry_Surfaces (Landing_Page, Lobby) in the clean dark
 *   theme (Requirements 18.1, 18.2), kept separate from the in-round handmade
 *   aesthetic which lives entirely in the Renderer-backed Round canvas
 *   (Requirements 18.3, 18.4).
 * - Composes the Song_Picker search backend (Piped) and threads it into the
 *   Lobby, which drives `Song_Picker → resolvers → RoundPlan`; the Round screen
 *   then runs `LocalGameHost → Renderer → Scorecard`.
 *
 * React owns ONLY this top-level route — never the per-frame physics loop, which
 * the LocalGameHost drives on its own fixed-timestep accumulator (design.md
 * "decouple physics from React render cycles").
 */

import { useCallback, useMemo, useState } from 'react';
import type { RoundResult } from '@glitch/core';
import { getEffectiveReduceMotion } from './theme/index.ts';
import { createProxySearchBackend, resolveAudioViaProxy } from './services/musicProxyClient.ts';
import {
  LandingPage,
  Lobby,
  RoundScreen,
  ScorecardScreen,
  type RoundPlan,
  type ResolveRoundDeps,
} from './shell/index.ts';

/** The top-level screen route (mirrors the Round State Machine surfaces). */
type Screen =
  | { name: 'landing' }
  | { name: 'lobby' }
  | { name: 'round'; plan: RoundPlan }
  | { name: 'scorecard'; result: RoundResult };

/** The root application shell. */
export default function App() {
  const [reduceMotion, setReduceMotion] = useState<boolean>(() => getEffectiveReduceMotion());
  const [screen, setScreen] = useState<Screen>({ name: 'landing' });

  // The same-origin proxy-backed Song_Picker search backend, created once.
  // Routing search through our own server sidesteps the browser CORS wall and
  // uses the reliable YouTube Data API path on the server when a key is set.
  const searchBackend = useMemo(() => createProxySearchBackend(), []);

  // Resolve audio through the same-origin proxy too: the returned stream URL is
  // same-origin (CORS-clean for the Web Audio AnalyserNode). Lyrics still go to
  // LRCLIB directly (it sends permissive CORS headers).
  const resolveDeps = useMemo<ResolveRoundDeps>(
    () => ({ resolveAudioFn: (videoId) => resolveAudioViaProxy(videoId) }),
    [],
  );

  const goToLobby = useCallback(() => setScreen({ name: 'lobby' }), []);

  const handleStartRound = useCallback((plan: RoundPlan) => {
    setScreen({ name: 'round', plan });
  }, []);

  const handleRoundComplete = useCallback((result: RoundResult) => {
    setScreen({ name: 'scorecard', result });
  }, []);

  const handlePlayAgain = useCallback(() => setScreen({ name: 'lobby' }), []);

  switch (screen.name) {
    case 'landing':
      return <LandingPage onStart={goToLobby} reduceMotion={reduceMotion} />;

    case 'lobby':
      return (
        <Lobby
          backend={searchBackend}
          reduceMotion={reduceMotion}
          onReduceMotionChange={setReduceMotion}
          onStartRound={handleStartRound}
          resolveDeps={resolveDeps}
        />
      );

    case 'round':
      return (
        <RoundScreen
          plan={screen.plan}
          reduceMotion={reduceMotion}
          onRoundComplete={handleRoundComplete}
        />
      );

    case 'scorecard':
      return <ScorecardScreen result={screen.result} onPlayAgain={handlePlayAgain} />;
  }
}
