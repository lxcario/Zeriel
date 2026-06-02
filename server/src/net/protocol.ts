/**
 * WebSocket message protocol — SERVER side (task 16.9).
 *
 * design.md "Message protocol (WebSocket, JSON for v1)" defines the wire
 * messages exchanged between Client and Game_Server. This module declares the
 * TypeScript shapes and pure (de)serialization/validation for the messages the
 * authoritative server consumes and produces. The CLIENT side of the same
 * protocol is the separate Net Client task (17.3); the shapes here are the
 * server's half of that contract.
 *
 * | Dir | Message      | Payload                                             |
 * | --- | ------------ | --------------------------------------------------- |
 * | C→S | `join`       | roomCode, displayName?, reconnectToken?             |
 * | C→S | `cursor`     | x, y                                                |
 * | C→S | `grab`       | letterId, clientTick                                |
 * | C→S | `release`    | letterId                                            |
 * | C→S | `startRound` | trackRef                                            |
 * | S→C | `welcome`    | playerId, serverClock, roomState                    |
 * | S→C | `roster`     | players[]                                           |
 * | S→C | `snapshot`   | letters[], locks[], cursors[], provisionalScore, tick |
 * | S→C | `grabResult` | letterId, granted, ownerId                          |
 * | S→C | `roundState` | state, result?                                      |
 *
 * Parsing is defensive: {@link parseClientMessage} returns `null` for anything
 * that is not a well-formed client message (a stale, malformed, or hostile
 * client cannot throw on the authoritative server — it is simply ignored). This
 * is pure logic with no `ws`/DOM dependency so it is unit-testable directly.
 *
 * SECURITY NOTE: messages arrive from UNTRUSTED clients. The parser validates
 * the discriminant and the shape of every field it reads before the server acts
 * on it; numeric fields are checked finite. Access to a Room is by Room_Code
 * only (no accounts, Requirement 1.6) — the design's intended model.
 */

import type {
  RoundState,
  Snapshot,
  PlayerId,
  RoomCode,
  RoundResult,
} from '@glitch/core';

// ---------------------------------------------------------------------------
// C→S (client → server) messages
// ---------------------------------------------------------------------------

/** C→S `join`: enter a Room by code, optionally with a name / reconnect token. */
export interface JoinMessage {
  type: 'join';
  roomCode: RoomCode;
  displayName?: string;
  reconnectToken?: string;
}

/** C→S `cursor`: the player's latest pointer position (sent ≥15/s while playing). */
export interface CursorMessage {
  type: 'cursor';
  x: number;
  y: number;
}

/** C→S `grab`: request an Ownership_Lock on a rope-letter (with client tick). */
export interface GrabMessage {
  type: 'grab';
  letterId: string;
  clientTick: number;
}

/** C→S `release`: release a previously grabbed rope-letter. */
export interface ReleaseMessage {
  type: 'release';
  letterId: string;
}

/** C→S `startRound`: the Host starts a Round with a selected track reference. */
export interface StartRoundMessage {
  type: 'startRound';
  trackRef: string;
}

/** Any message the server accepts from a client. Discriminated by `type`. */
export type ClientMessage =
  | JoinMessage
  | CursorMessage
  | GrabMessage
  | ReleaseMessage
  | StartRoundMessage;

// ---------------------------------------------------------------------------
// S→C (server → client) messages
// ---------------------------------------------------------------------------

/** S→C `welcome`: assigned identity + server clock + initial room state (16.5). */
export interface WelcomeMessage {
  type: 'welcome';
  playerId: PlayerId;
  serverClock: number;
  roomState: RoundState;
  /** Reconnect token issued to this player so a dropped client can return (2.6). */
  reconnectToken: string;
}

/** One roster entry broadcast in {@link RosterMessage} (Requirement 2.3). */
export interface RosterEntry {
  playerId: PlayerId;
  displayName: string;
  isHost: boolean;
  connected: boolean;
}

/** S→C `roster`: the current Player roster (broadcast on change, ≤1s) (2.3). */
export interface RosterMessage {
  type: 'roster';
  players: RosterEntry[];
}

/** S→C `snapshot`: authoritative state for ≥15Hz broadcast / join-in-progress. */
export interface SnapshotMessage {
  type: 'snapshot';
  snapshot: Snapshot;
}

/** S→C `grabResult`: outcome of a grab (granted + current owner) (8.1, 8.2, 8.7). */
export interface GrabResultMessage {
  type: 'grabResult';
  letterId: string;
  granted: boolean;
  ownerId: PlayerId | null;
}

/** S→C `roundState`: a lifecycle transition, with the finalized result on scoring. */
export interface RoundStateMessage {
  type: 'roundState';
  state: RoundState;
  result?: RoundResult;
}

/** Any message the server sends to a client. Discriminated by `type`. */
export type ServerMessage =
  | WelcomeMessage
  | RosterMessage
  | SnapshotMessage
  | GrabResultMessage
  | RoundStateMessage;

// ---------------------------------------------------------------------------
// Pure (de)serialization + validation
// ---------------------------------------------------------------------------

/** True for a finite JS number (rejects NaN/Infinity arriving over the wire). */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** True for a non-empty string. */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Parse and validate a raw inbound payload (the JSON text or already-parsed
 * object from a `ws` `message` event) into a typed {@link ClientMessage}, or
 * `null` if it is not a well-formed client message.
 *
 * Accepts either a JSON string or a pre-parsed value; a string that is not valid
 * JSON yields `null` (never throws). Every field the server will act on is shape-
 * and finiteness-checked, so a malformed/hostile message is safely ignored
 * rather than corrupting authoritative state.
 */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;

  const msg = value as Record<string, unknown>;
  switch (msg.type) {
    case 'join':
      if (!isNonEmptyString(msg.roomCode)) return null;
      return {
        type: 'join',
        roomCode: msg.roomCode,
        ...(isNonEmptyString(msg.displayName) ? { displayName: msg.displayName } : {}),
        ...(isNonEmptyString(msg.reconnectToken) ? { reconnectToken: msg.reconnectToken } : {}),
      };
    case 'cursor':
      if (!isFiniteNumber(msg.x) || !isFiniteNumber(msg.y)) return null;
      return { type: 'cursor', x: msg.x, y: msg.y };
    case 'grab':
      if (!isNonEmptyString(msg.letterId)) return null;
      return {
        type: 'grab',
        letterId: msg.letterId,
        clientTick: isFiniteNumber(msg.clientTick) ? msg.clientTick : 0,
      };
    case 'release':
      if (!isNonEmptyString(msg.letterId)) return null;
      return { type: 'release', letterId: msg.letterId };
    case 'startRound':
      if (!isNonEmptyString(msg.trackRef)) return null;
      return { type: 'startRound', trackRef: msg.trackRef };
    default:
      return null;
  }
}

/** Serialize a {@link ServerMessage} to the JSON wire string. */
export function serializeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}
