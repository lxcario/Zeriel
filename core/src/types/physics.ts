/**
 * Physics data models for the Verlet rope-letter engine.
 *
 * These types describe the pure, deterministic physics state owned by
 * `GameCore`. They contain no behavior — integration, constraint relaxation,
 * bounds, and stacking are implemented in later tasks (3.x, 4.x).
 *
 * Design references: design.md "Data Models — Physics" and "Verlet Physics Model".
 */

import type { PlayerId } from './identity.js';

/**
 * A 2D vector. Instances are pre-allocated and reused inside the physics loops
 * rather than re-created per frame (Requirement 14.3).
 */
export interface Vec2 {
  x: number;
  y: number;
}

/**
 * An axis-aligned rectangle, used for the play-area bounds and spawn band.
 * Stored as a top-left origin plus width/height.
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A single Verlet particle. Velocity is implicit in `x - prev`
 * (design.md "Particle integration").
 */
export interface Particle {
  /** Current position. */
  x: Vec2;
  /** Previous position; implicit velocity is `x - prev`. */
  prev: Vec2;
  /** True while grabbed/anchored; pinned particles do not move. */
  pinned: boolean;
  /** Inverse mass; 0 for pinned/infinite-mass particles. */
  invMass: number;
}

/**
 * A distance constraint connecting two particles (by index) within a
 * {@link RopeLetter}. Resolved over several relaxation iterations per tick,
 * preserving `restLength` within a configured tolerance (Requirement 7.3).
 */
export interface Constraint {
  /** Index of the first particle in the owning letter's `particles` array. */
  a: number;
  /** Index of the second particle in the owning letter's `particles` array. */
  b: number;
  /** Target separation distance to preserve. */
  restLength: number;
  /** Constraint stiffness in [0, 1]; 1 is fully rigid. */
  stiffness: number;
}

/**
 * A single letter or word rendered as a chain of Verlet particles joined by
 * distance constraints (Requirement 7.1).
 */
export interface RopeLetter {
  /** Stable unique identifier used in inputs, snapshots, and grab results. */
  id: string;
  /** The letter or word text. */
  glyph: string;
  /** Identifier of the {@link LyricLine} this letter belongs to. */
  lineId: string;
  /** Particles composing the rope chain. */
  particles: Particle[];
  /** Distance constraints joining the particles. */
  constraints: Constraint[];
  /** Coarse circular collider radius at particle nodes (Requirement 7.5). */
  colliderRadius: number;
  /** Ownership_Lock holder; `null` when unlocked (Requirements 8.1, 8.4). */
  ownerId: PlayerId | null;
  /** Solution_Slot index when at rest within tolerance, else `null` (Requirement 9.2). */
  placedSlot: number | null;
  /** This letter's correct position in the line (Requirement 9.1). */
  correctIndex: number;
  /** Deterministic seed for ransom-note placement variation (Requirement 12.1). */
  spawnJitterSeed: number;
}
