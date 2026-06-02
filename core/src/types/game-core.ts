/**
 * The `GameCore` public surface and its supporting contract types.
 *
 * This module defines the CONTRACT only — no physics, scoring, or spawning
 * behavior. Those are implemented in tasks 3.x and 4.x by a concrete class that
 * `implements GameCore`. `GameCore` is pure logic with NO imports of network,
 * DOM, audio, or React (design.md "GameCore public surface").
 *
 * The shapes of {@link GameConfig}, {@link PlayerInput}, {@link InputOutcome},
 * and {@link Snapshot} are derived from the design's tick sequence, the
 * WebSocket message protocol, and the snapshot payload, since the design leaves
 * their internal shape unspecified.
 */

import type { Vec2, Rect } from './physics.js';
import type { PlayerId } from './identity.js';
import type { LyricLine, RoundResult } from './lyrics.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Static configuration for a {@link GameCore} instance. Holds the physics,
 * spawn, placement, and capacity parameters referenced by the design's
 * "Verlet Physics Model", tick sequence, and scoring sections.
 *
 * Determinism note: `GameCore` is constructed with an explicit seed (a separate
 * constructor argument) so a given seed + config + input sequence is fully
 * reproducible. Config holds no per-run mutable state.
 */
export interface GameConfig {
  // --- Physics integration (design.md "Particle integration") ---
  /** Constant acceleration applied each step, e.g. gravity (downward +y). */
  gravity: Vec2;
  /** Damping/friction coefficient `f` applied to implicit velocity each step. */
  damping: number;

  // --- Constraint relaxation (design.md "Distance constraints") ---
  /** Number of relaxation iterations per tick (research: 5–10) (Requirement 7.3). */
  constraintIterations: number;
  /** Sub-steps run per tick with a smaller dt to stabilize fast drags. */
  subSteps: number;
  /** Default constraint stiffness in [0, 1] for spawned rope chains. */
  defaultStiffness: number;
  /** Allowed deviation of a constraint's length from its rest length (Requirement 7.3). */
  constraintTolerance: number;

  // --- Bounds and stacking (design.md "Boundaries and stacking") ---
  /** Play-area rectangle particles are clamped within (Requirement 7.4). */
  bounds: Rect;
  /** Restitution applied when a particle reflects off a wall (Requirement 7.4). */
  restitution: number;
  /** Default coarse collider radius per rope-letter node (Requirement 7.5). */
  colliderRadius: number;

  // --- Spawning (design.md tick / Requirement 7.1) ---
  /** Top band of the play area where new rope-letters spawn (Requirement 7.1). */
  spawnBand: Rect;

  // --- Scoring / placement (Requirement 9.2) ---
  /** Default position tolerance for Solution_Slot placement (Requirement 9.2). */
  placementTolerance: number;

  // --- Session ---
  /** Configured maximum Player capacity for the Room (Requirement 1.5). */
  maxPlayers: number;
  /** Fixed authoritative step size in ms (~33.3 for 30Hz) (Requirement 14.6). */
  stepMs: number;
}

// ---------------------------------------------------------------------------
// Inputs — discriminated union keyed by `type`
// ---------------------------------------------------------------------------

/**
 * A grab request on a rope-letter (Requirements 8.1, 8.5).
 * Mirrors the C→S `grab` message (`letterId`, `clientTick`) plus the
 * `playerId` the server attributes the input to.
 */
export interface GrabInput {
  type: 'grab';
  playerId: PlayerId;
  letterId: string;
  /** Client tick at which the grab was issued, for reconciliation. */
  clientTick: number;
}

/**
 * A release of a previously grabbed rope-letter (Requirement 8.4).
 * Mirrors the C→S `release` message (`letterId`).
 */
export interface ReleaseInput {
  type: 'release';
  playerId: PlayerId;
  letterId: string;
}

/**
 * A cursor position update (Requirement 8.3, presence Requirement 2.4).
 * Mirrors the C→S `cursor` message (`x`, `y`).
 */
export interface CursorInput {
  type: 'cursor';
  playerId: PlayerId;
  x: number;
  y: number;
}

/**
 * Any player input processed in the first step of `GameCore.tick`
 * (design.md tick step 1). Discriminated by `type`.
 */
export type PlayerInput = GrabInput | ReleaseInput | CursorInput;

// ---------------------------------------------------------------------------
// Outcomes — result of applyInput, discriminated union keyed by `type`
// ---------------------------------------------------------------------------

/**
 * Result of a {@link GrabInput}. Mirrors the S→C `grabResult` message
 * (`letterId`, `granted`, `ownerId`) (Requirements 8.1, 8.2, 8.7). When the
 * grab is denied, `ownerId` identifies the current Ownership_Lock holder.
 */
export interface GrabOutcome {
  type: 'grab';
  letterId: string;
  /** True if the lock was assigned to the requesting Player (Requirement 8.1). */
  granted: boolean;
  /** Current lock holder after the attempt; `null` when unlocked. */
  ownerId: PlayerId | null;
}

/**
 * Result of a {@link ReleaseInput}: whether a lock held by the requester was
 * cleared (Requirement 8.4).
 */
export interface ReleaseOutcome {
  type: 'release';
  letterId: string;
  released: boolean;
}

/**
 * Result of a {@link CursorInput}: acknowledges the recorded cursor position.
 */
export interface CursorOutcome {
  type: 'cursor';
  accepted: boolean;
}

/**
 * The result of {@link GameCore.applyInput}, discriminated by `type` to match
 * the originating {@link PlayerInput}.
 */
export type InputOutcome = GrabOutcome | ReleaseOutcome | CursorOutcome;

// ---------------------------------------------------------------------------
// Snapshot — authoritative state for broadcast and reconciliation
// ---------------------------------------------------------------------------

/**
 * A single particle's position pair within a {@link LetterSnapshot}. Carrying
 * both `x` and `prev` preserves implicit velocity so a reconstructed letter
 * continues moving identically (design.md "Particle integration").
 */
export interface ParticleSnapshot {
  x: Vec2;
  prev: Vec2;
}

/**
 * Authoritative position state for one rope-letter, sufficient to reconstruct
 * its particle positions and resting placement (Requirement 16.3).
 */
export interface LetterSnapshot {
  id: string;
  particles: ParticleSnapshot[];
  /** Solution_Slot index when at rest within tolerance, else `null`. */
  placedSlot: number | null;
}

/**
 * One Ownership_Lock entry: which Player owns which rope-letter. Only locked
 * letters appear (Requirements 8.1, 16.1).
 */
export interface LockSnapshot {
  letterId: string;
  ownerId: PlayerId;
}

/**
 * One Player's cursor position for presence reconstruction (Requirement 2.4).
 */
export interface CursorSnapshot {
  playerId: PlayerId;
  cursor: Vec2;
}

/**
 * A full authoritative game-state snapshot used for ≥15Hz broadcast and for
 * client reconciliation / join-in-progress (design.md `snapshot` message:
 * `letters[]`, `locks[]`, `cursors[]`, `provisionalScore`, `tick`).
 *
 * Applying a Snapshot to a fresh {@link GameCore} reproduces an equal set of
 * rope-letter positions, Ownership_Locks, and the provisional score
 * (Requirement 16.3, Property 37).
 */
export interface Snapshot {
  /** Authoritative tick number this snapshot was produced at. */
  tick: number;
  /** Position state for every live rope-letter. */
  letters: LetterSnapshot[];
  /** Active Ownership_Locks. */
  locks: LockSnapshot[];
  /** Current cursor positions for connected Players. */
  cursors: CursorSnapshot[];
  /** Current provisional score broadcast to Clients (Requirement 9.3). */
  provisionalScore: number;
}

// ---------------------------------------------------------------------------
// GameCore contract
// ---------------------------------------------------------------------------

/**
 * The pure, deterministic gameplay engine contract — the single source of all
 * gameplay logic shared by the authoritative server and the client prediction
 * copy (design.md "GameCore public surface").
 *
 * This is the CONTRACT only. A concrete implementation (`implements
 * GameCoreContract`) is provided in tasks 3.x/4.x as the `GameCore` class
 * (task 4.1); it is constructed via {@link GameCoreFactory} with an explicit
 * seed and {@link GameConfig}. `Room.game` is typed as this contract.
 *
 * Naming note: design.md shows the implementation as `class GameCore`. To let
 * the class keep that name without a value/type export clash in the package
 * barrel, the contract interface is named `GameCoreContract` and the concrete
 * class is named `GameCore` (see core/src/gameCore/GameCore.ts).
 */
export interface GameCoreContract {
  /** Spawn one {@link RopeLetter} per letter/word token of a line (Requirement 7.1). */
  spawnLine(line: LyricLine): void;
  /** Apply a single player input, enforcing Ownership_Locks (Requirements 8.x). */
  applyInput(input: PlayerInput): InputOutcome;
  /** Advance the deterministic step sequence by `dtMs` (design.md tick ordering). */
  tick(dtMs: number): void;
  /** Produce the authoritative state for broadcast/reconcile (Requirement 16.3). */
  snapshot(): Snapshot;
  /** Reconcile this instance toward an authoritative snapshot (Requirement 16.2). */
  applySnapshot(s: Snapshot): void;
  /** Produce the finalized Round result (Requirements 9.5, 9.6). */
  getRoundResult(): RoundResult;
}

/**
 * Construction contract for a concrete {@link GameCore}. The implementation in
 * later tasks must be constructible with `(seed, config)` — mirroring the
 * design's `new GameCore(seed, config)` — so failures are reproducible from a
 * seed (design.md determinism note).
 */
export type GameCoreFactory = (seed: number, config: GameConfig) => GameCoreContract;
