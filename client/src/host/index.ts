/**
 * Barrel for the client `host` module (tasks 13.1 + 17.6).
 *
 * Exports the host abstraction shared by single-player and multiplayer
 * ({@link GameHost} / {@link GameHostMode}), the in-browser {@link LocalGameHost}
 * (task 13.1), the WebSocket-backed {@link RemoteGameHost} plus its thin
 * `WebSocket`→`NetSocket` adapter and the pure non-owned snapshot interpolation
 * helpers (task 17.6), and the pure fixed-timestep stepping math
 * ({@link planFixedSteps}) so the UI shell (task 14.1), host-switching
 * (task 18.1), and the optional tests (13.2 / 18.2) can import from a single
 * entry point.
 */

export type { GameHost, GameHostMode } from './GameHost.ts';

export {
  LocalGameHost,
  DEFAULT_DROP_WINDOW_MS,
  type LocalGameHostConfig,
  type FrameCallback,
  type FrameHandle,
} from './LocalGameHost.ts';

export {
  RemoteGameHost,
  type RemoteGameHostConfig,
} from './RemoteGameHost.ts';

export {
  createWebSocketNetSocket,
  WS_OPEN,
  type BrowserWebSocketLike,
  type WebSocketFactory,
  type WebSocketNetSocketOptions,
} from './WebSocketNetSocket.ts';

export {
  snapshotInterpolationAlpha,
  interpolateLetterParticles,
} from './snapshotInterpolation.ts';

export {
  planFixedSteps,
  DEFAULT_STEP_MS,
  DEFAULT_MAX_STEPS_PER_FRAME,
  type FixedStepPlan,
} from './fixedTimestep.ts';
