/**
 * Barrel for the `@glitch/core` shared types.
 *
 * Re-exports every shared data model and the `GameCore` contract so consumers
 * can import from a single entry point. All exports are type-only (no runtime
 * code), keeping `core` pure (no DOM/network/audio/React).
 */

export type { Vec2, Rect, Particle, Constraint, RopeLetter } from './physics.js';

export type {
  RoomCode,
  PlayerId,
  RoundState,
  Player,
  Room,
} from './identity.js';

export type {
  SolutionSlot,
  LyricLine,
  LineScore,
  RoundResult,
} from './lyrics.js';

export type { TrackCandidate, TrackSignature } from './track.js';

export type { RenderOptions, ScrollRevealConfig } from './config.js';

export type {
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
} from './game-core.js';
