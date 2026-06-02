/**
 * Barrel for the pure Round state machine (task 6.3).
 *
 * Exports the {@link RoundLifecycle} that enforces the design's Round State
 * Machine edges, the readiness gate (Requirements 10.5, 17.4), and the
 * finalize-before-notify ordering into scoring (Requirement 10.4). Pure module:
 * no DOM/network/audio/React imports — shared by the single-player host (task
 * 13.1) and the authoritative server (task 16.9).
 */

export {
  RoundLifecycle,
  type RoundResolution,
  type RoundTransition,
  type RoundTransitionReason,
  type RoundScoringResult,
} from './RoundLifecycle.js';
