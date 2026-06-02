/**
 * Identity and Room data models.
 *
 * Design references: design.md "Data Models — Identity & Rooms" and the Round
 * state machine. These are data shapes only; Room Manager behavior is built in
 * task 16.x.
 */

import type { Vec2 } from './physics.js';
import type { TrackCandidate } from './track.js';
import type { GameCoreContract } from './game-core.js';

/** Short, URL-safe Room identifier, collision-checked on creation. */
export type RoomCode = string;

/** Session-scoped Player identifier, unique within the server process. */
export type PlayerId = string;

/**
 * Lifecycle state of a Round within a Room (design.md "Round State Machine").
 * `playing` may only be entered from `ready` (Requirement 10.5).
 */
export type RoundState =
  | 'lobby'
  | 'resolving'
  | 'ready'
  | 'playing'
  | 'scoring'
  | 'resolve_failed';

/**
 * A connected participant in a Room.
 */
export interface Player {
  /** Session-scoped unique id (Requirement 2.1). */
  id: PlayerId;
  /** Display name; a generated default is assigned when none is provided (Requirement 2.2). */
  displayName: string;
  /** Latest known cursor position used for grabbing/dragging and presence. */
  cursor: Vec2;
  /** Whether the Player currently has a live connection. */
  connected: boolean;
  /** Opaque token enabling reconnection within the window (Requirement 2.6). */
  reconnectToken: string;
  /** Count of correctly placed letters credited to this Player (Requirement 9.6). */
  contribution: number;
}

/**
 * A shared game session keyed by {@link RoomCode}.
 */
export interface Room {
  /** Unique, collision-checked join code (Requirement 1.1). */
  code: RoomCode;
  /** The creating Player, who holds round-control privileges (Requirement 1.1). */
  hostId: PlayerId;
  /** Connected Players keyed by id. */
  players: Map<PlayerId, Player>;
  /** Configured maximum Player capacity (Requirement 1.5). */
  maxPlayers: number;
  /** Current Round lifecycle state. */
  state: RoundState;
  /** Track selected for the next Round, if any (Requirement 3.2). */
  pendingTrack?: TrackCandidate;
  /** Active gameplay engine while a Round is in progress (contract type). */
  game?: GameCoreContract;
}
