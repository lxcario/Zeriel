/**
 * Barrel for the single-player UI shell (task 14.1).
 *
 * Re-exports the routed screens (Landing_Page, Lobby, in-round canvas,
 * Scorecard), the resolution wiring, the session-mode abstraction + host-
 * selection factory (task 18.1), and the shell config so the app entry
 * (`App.tsx`), the multiplayer host-switch, and the optional static-audit /
 * mode-equivalence tests (tasks 14.2 / 18.2) can import from a single entry point.
 */

export { LandingPage, type LandingPageProps } from './LandingPage.tsx';
export { Lobby, type LobbyProps } from './Lobby.tsx';
export { RoundScreen, type RoundScreenProps } from './RoundScreen.tsx';
export { RoundCanvas, type RoundCanvasProps, type RoundCanvasDeps } from './RoundCanvas.tsx';
export { ScorecardScreen, type ScorecardScreenProps } from './ScorecardScreen.tsx';
export { ReduceMotionToggle, type ReduceMotionToggleProps } from './ReduceMotionToggle.tsx';
export { HeadlineReveal, canAnimateScroll, type HeadlineRevealProps } from './HeadlineReveal.tsx';

export {
  resolveRoundAssets,
  type RoundPlan,
  type ResolveRoundResult,
} from './resolveRound.ts';
export type { ResolveRoundDeps } from './resolveRound.ts';

export {
  SINGLE_PLAYER_SESSION,
  singlePlayerSession,
  multiplayerSession,
  type SessionMode,
  type SinglePlayerSession,
  type MultiplayerSession,
} from './sessionMode.ts';

export {
  selectGameHost,
  type HostSelection,
  type HostSelectionDeps,
} from './selectGameHost.ts';

export {
  defaultGameConfig,
  defaultRenderOptions,
  PLAY_AREA,
  LOCAL_PLAYER_ID,
  DEFAULT_OFF_GRID_OFFSET_PX,
  DEFAULT_PIPED_INSTANCES,
  DEFAULT_LRCLIB_BASE_URL,
} from './config.ts';
