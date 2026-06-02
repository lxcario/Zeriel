/**
 * @glitch/core — shared, pure, deterministic gameplay logic.
 *
 * This package is the home of the pure `GameCore` module (see design.md).
 * It MUST NOT import network, DOM, audio, or React code so that the same logic
 * can run authoritatively on the server and as a prediction copy in the browser.
 *
 * Task 1.2 adds the shared data models and the `GameCore` contract (types only).
 * Physics, scoring, spawning, and snapshot behavior are implemented in tasks 3.x/4.x.
 */

/** Identifies the shared core package. */
export const CORE_PACKAGE = '@glitch/core' as const;

// Pure Verlet physics primitives (task 3.1): allocation-free Vec2 math plus
// integration and distance-constraint relaxation. These are runtime exports.
export {
  createVec2,
  set,
  copy,
  add,
  sub,
  scale,
  addScaled,
  lengthSq,
  length,
  Vec2Pool,
  integrateParticles,
  solveConstraints,
  resolveBounds,
  resolveOverlap,
} from './physics/index.js';

// Shared data models and the GameCore contract (type-only re-exports).
export type {
  // physics
  Vec2,
  Rect,
  Particle,
  Constraint,
  RopeLetter,
  // identity & rooms
  RoomCode,
  PlayerId,
  RoundState,
  Player,
  Room,
  // lyrics & scoring
  SolutionSlot,
  LyricLine,
  LineScore,
  RoundResult,
  // external-service tracks
  TrackCandidate,
  TrackSignature,
  // render / scroll config
  RenderOptions,
  ScrollRevealConfig,
  // GameCore contract & supporting types
  GameConfig,
  GrabInput,
  ReleaseInput,
  CursorInput,
  PlayerInput,
  GrabOutcome,
  ReleaseOutcome,
  CursorOutcome,
  InputOutcome,
  ParticleSnapshot,
  LetterSnapshot,
  LockSnapshot,
  CursorSnapshot,
  Snapshot,
  GameCoreContract,
  GameCoreFactory,
} from './types/index.js';

// Concrete pure gameplay engine. `GameCore` is the runtime class that
// `implements GameCoreContract`; task 4.1 implements `spawnLine` + Solution_Slot
// generation and a deterministic seeded PRNG. Remaining methods are typed stubs
// filled in by tasks 4.4 / 4.7 / 4.12.
export { GameCore } from './gameCore/index.js';

// Pure, deterministic playback-time-driven lyric scheduler (task 6.1). Drops
// each Lyric_Line exactly once at its start timestamp, in ascending order, via
// a sink the host wires to `GameCore.spawnLine` (Requirements 6.3, 10.2).
export { LyricScheduler, type LyricDropSink } from './scheduler/index.js';

// Pure, deterministic Round state machine (task 6.3). Enforces the design's
// Round State Machine edges, gates `playing` on readiness (Requirements 10.5,
// 17.4), and finalizes the Round result before scoring becomes observable
// (Requirement 10.4). Shared by the single-player host (13.1) and server (16.9).
export {
  RoundLifecycle,
  type RoundResolution,
  type RoundTransition,
  type RoundTransitionReason,
  type RoundScoringResult,
} from './round/index.js';
