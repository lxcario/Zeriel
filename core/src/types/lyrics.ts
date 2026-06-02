/**
 * Lyrics and scoring data models.
 *
 * Design references: design.md "Data Models — Lyrics & Scoring". Parsing and
 * scoring behavior is implemented in tasks 2.6 and 4.7; these are shapes only.
 */

import type { Vec2 } from './physics.js';
import type { PlayerId } from './identity.js';

/**
 * One target position in the ordered answer area. A {@link RopeLetter} placed
 * within `tolerance` of `position` is marked as occupying this slot (Requirement 9.2).
 */
export interface SolutionSlot {
  /** Ordered slot index, forming the sequence `0..n-1` (Requirement 9.1). */
  index: number;
  /** Target position the letter must rest near. */
  position: Vec2;
  /** Maximum distance from `position` that still counts as placed. */
  tolerance: number;
}

/**
 * A single timestamped line of lyrics that drops into play at `startMs`
 * (Requirements 6.2, 6.3).
 */
export interface LyricLine {
  /** Stable unique identifier for the line. */
  id: string;
  /** Start time in milliseconds, parsed from the LRC tag (Requirement 6.2). */
  startMs: number;
  /** The full line text. */
  text: string;
  /** Ordered target positions for this line's letters (Requirement 9.1). */
  solutionSlots: SolutionSlot[];
}

/**
 * Provisional and finalized score for a single Lyric_Line.
 * `finalized` is `null` until the line's drop window closes (Requirement 9.4).
 */
export interface LineScore {
  lineId: string;
  /** Live score updated during the drop window (Requirement 9.3). */
  provisional: number;
  /** Final score at window close, else `null` (Requirement 9.4). */
  finalized: number | null;
}

/**
 * The final result of a completed Round (Requirements 9.5, 9.6).
 */
export interface RoundResult {
  /** Title of the played track. */
  trackTitle: string;
  /** Sum of finalized per-line scores (Requirement 9.5). */
  totalScore: number;
  /** Per-Player correctly-placed-letter counts (Requirement 9.6). */
  contributions: Record<PlayerId, number>;
}
