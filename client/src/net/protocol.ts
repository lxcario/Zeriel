/**
 * WebSocket message protocol — CLIENT side (task 17.3).
 *
 * This is the Client half of the wire protocol whose Server half lives in
 * `server/src/net/protocol.ts` (task 16.9) and whose broadcast seam is
 * `server/src/broadcast/RoomBroadcaster.ts`. design.md "Message protocol
 * (WebSocket, JSON for v1)" defines the messages exchanged between Client and
 * Game_Server:
 *
 * | Dir | Message      | Payload                                               |
 * | --- | ------------ | ----------------------------------------------------- |
 * | C→S | `join`       | roomCode, displayName?, reconnectToken?               |
 * | C→S | `cursor`     | x, y                                                  |
 * | C→S | `grab`       | letterId, clientTick                                  |
 * | C→S | `release`    | letterId                                              |
 * | C→S | `startRound` | trackRef                                              |
 * | S→C | `welcome`    | playerId, serverClock, roomState, reconnectToken      |
 * | S→C | `roster`     | players[]                                             |
 * | S→C | `snapshot`   | letters[], locks[], cursors[], provisionalScore, tick |
 * | S→C | `grabResult` | letterId, granted, ownerId                            |
 * | S→C | `roundState` | state, result?                                        |
 *
 * The Client SENDS the C→S set and RECEIVES the S→C set — the exact mirror of
 * the server, which receives C→S and sends S→C. The TypeScript shapes here are
 * deliberately identical to the server's so the two halves agree on the wire;
 * they are re-declared (rather than imported from `server`) because the client
 * package depends only on `@glitch/core`, never on the server package.
 *
 * ## Why this is a pure codec (no WebSocket dependency)
 * The (de)serialization is a pure string/object ⇄ typed-message mapping with no
 * reference to `WebSocket`, the DOM, or any socket. That keeps it unit-testable
 * without a live connection (the Net Client injects a socket-like transport
 * separately; see {@link ../net/NetClient.ts}). It mirrors the server codec's
 * design so a binary encoding could replace JSON later without touching
 * `GameCore` or the Net Client logic.
 *
 * ## Defensive parsing of inbound server messages
 * {@link parseServerMessage} returns `null` for anything that is not a
 * well-formed server message and NEVER throws. Even though the Game_Server is
 * our own code, a frame can be truncated, reordered, or (per the security model)
 * arrive from an untrusted intermediary; a malformed frame must be ignored, not
 * crash the render loop. Every field the Client acts on — including the nested
 * {@link Snapshot} — is shape- and finiteness-checked before use.
 */

import type {
  RoundState,
  RoundResult,
  PlayerId,
  RoomCode,
  Snapshot,
  LetterSnapshot,
  LockSnapshot,
  CursorSnapshot,
  ParticleSnapshot,
  Vec2,
} from '@glitch/core';

// ---------------------------------------------------------------------------
// C→S (client → server) messages — the Client SENDS these
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

/** Any message the Client sends to the server. Discriminated by `type`. */
export type ClientMessage =
  | JoinMessage
  | CursorMessage
  | GrabMessage
  | ReleaseMessage
  | StartRoundMessage;

// ---------------------------------------------------------------------------
// S→C (server → client) messages — the Client RECEIVES these
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

/**
 * One roster entry received in {@link RosterMessage} (Requirement 2.3). The
 * wire-format counterpart of the server's `RosterEntry`
 * (`server/src/broadcast/RoomBroadcaster.ts`).
 */
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

/** Any message the Client receives from the server. Discriminated by `type`. */
export type ServerMessage =
  | WelcomeMessage
  | RosterMessage
  | SnapshotMessage
  | GrabResultMessage
  | RoundStateMessage;

// ---------------------------------------------------------------------------
// Shared validation primitives (pure, allocation-light)
// ---------------------------------------------------------------------------

/** The complete set of valid {@link RoundState} discriminants. */
const ROUND_STATES: ReadonlySet<string> = new Set<RoundState>([
  'lobby',
  'resolving',
  'ready',
  'playing',
  'scoring',
  'resolve_failed',
]);

/** True for a finite JS number (rejects NaN/Infinity arriving over the wire). */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** True for a non-empty string. */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** True for a string (possibly empty) — used for fields where '' is meaningful. */
function isString(v: unknown): v is string {
  return typeof v === 'string';
}

/** True for a plain (non-null) object. */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** True for a valid {@link RoundState} discriminant. */
function isRoundState(v: unknown): v is RoundState {
  return typeof v === 'string' && ROUND_STATES.has(v);
}

/** Validate and copy a `{ x, y }` {@link Vec2}, or return `null`. */
function parseVec2(v: unknown): Vec2 | null {
  if (!isObject(v)) return null;
  if (!isFiniteNumber(v.x) || !isFiniteNumber(v.y)) return null;
  return { x: v.x, y: v.y };
}

// ---------------------------------------------------------------------------
// Snapshot validation (the nested S→C payload)
// ---------------------------------------------------------------------------

/** Validate one {@link ParticleSnapshot} (`x`/`prev` position pair). */
function parseParticleSnapshot(v: unknown): ParticleSnapshot | null {
  if (!isObject(v)) return null;
  const x = parseVec2(v.x);
  const prev = parseVec2(v.prev);
  if (x === null || prev === null) return null;
  return { x, prev };
}

/** Validate one {@link LetterSnapshot} (`id`, particles, `placedSlot`). */
function parseLetterSnapshot(v: unknown): LetterSnapshot | null {
  if (!isObject(v)) return null;
  if (!isNonEmptyString(v.id)) return null;
  if (!Array.isArray(v.particles)) return null;
  const particles: ParticleSnapshot[] = [];
  for (const p of v.particles) {
    const parsed = parseParticleSnapshot(p);
    if (parsed === null) return null;
    particles.push(parsed);
  }
  const placedSlot = v.placedSlot;
  if (placedSlot !== null && !isFiniteNumber(placedSlot)) return null;
  return { id: v.id, particles, placedSlot: placedSlot === null ? null : placedSlot };
}

/** Validate one {@link LockSnapshot} (`letterId`, `ownerId`). */
function parseLockSnapshot(v: unknown): LockSnapshot | null {
  if (!isObject(v)) return null;
  if (!isNonEmptyString(v.letterId) || !isNonEmptyString(v.ownerId)) return null;
  return { letterId: v.letterId, ownerId: v.ownerId };
}

/** Validate one {@link CursorSnapshot} (`playerId`, `cursor`). */
function parseCursorSnapshot(v: unknown): CursorSnapshot | null {
  if (!isObject(v)) return null;
  if (!isNonEmptyString(v.playerId)) return null;
  const cursor = parseVec2(v.cursor);
  if (cursor === null) return null;
  return { playerId: v.playerId, cursor };
}

/**
 * Validate and deep-copy a {@link Snapshot} arriving over the wire, or return
 * `null` if any field is malformed. The returned snapshot owns fresh nested
 * objects (no aliasing into the parsed payload), so it is safe to hand straight
 * to `GameCore.applySnapshot`. Used by {@link parseServerMessage}.
 */
export function parseSnapshot(v: unknown): Snapshot | null {
  if (!isObject(v)) return null;
  if (!isFiniteNumber(v.tick)) return null;
  if (!isFiniteNumber(v.provisionalScore)) return null;
  if (!Array.isArray(v.letters) || !Array.isArray(v.locks) || !Array.isArray(v.cursors)) {
    return null;
  }

  const letters: LetterSnapshot[] = [];
  for (const l of v.letters) {
    const parsed = parseLetterSnapshot(l);
    if (parsed === null) return null;
    letters.push(parsed);
  }

  const locks: LockSnapshot[] = [];
  for (const lock of v.locks) {
    const parsed = parseLockSnapshot(lock);
    if (parsed === null) return null;
    locks.push(parsed);
  }

  const cursors: CursorSnapshot[] = [];
  for (const c of v.cursors) {
    const parsed = parseCursorSnapshot(c);
    if (parsed === null) return null;
    cursors.push(parsed);
  }

  return { tick: v.tick, letters, locks, cursors, provisionalScore: v.provisionalScore };
}

// ---------------------------------------------------------------------------
// RoundResult validation (the optional `roundState` payload)
// ---------------------------------------------------------------------------

/** Validate a {@link RoundResult} (`trackTitle`, `totalScore`, `contributions`). */
function parseRoundResult(v: unknown): RoundResult | null {
  if (!isObject(v)) return null;
  if (!isString(v.trackTitle)) return null;
  if (!isFiniteNumber(v.totalScore)) return null;
  if (!isObject(v.contributions)) return null;
  const contributions: Record<PlayerId, number> = {};
  for (const [key, value] of Object.entries(v.contributions)) {
    if (!isFiniteNumber(value)) return null;
    contributions[key] = value;
  }
  return { trackTitle: v.trackTitle, totalScore: v.totalScore, contributions };
}

// ---------------------------------------------------------------------------
// Pure (de)serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a {@link ClientMessage} to the JSON wire string the server's
 * {@link parseClientMessage} consumes. Pure: no socket reference. The Net Client
 * passes the result to its injected transport's `send`.
 */
export function serializeClientMessage(message: ClientMessage): string {
  return JSON.stringify(message);
}

/**
 * Parse and validate a raw inbound payload (the JSON text or already-parsed
 * object from the transport's `message` event) into a typed
 * {@link ServerMessage}, or `null` if it is not a well-formed server message.
 *
 * Accepts either a JSON string or a pre-parsed value; a string that is not valid
 * JSON yields `null` (never throws). Every field the Client will act on is shape-
 * and finiteness-checked — including the nested {@link Snapshot} and the optional
 * {@link RoundResult} — so a malformed/partial frame is safely ignored rather
 * than corrupting the prediction state or the render loop.
 */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isObject(value)) return null;

  const msg = value;
  switch (msg.type) {
    case 'welcome':
      if (!isNonEmptyString(msg.playerId)) return null;
      if (!isFiniteNumber(msg.serverClock)) return null;
      if (!isRoundState(msg.roomState)) return null;
      if (!isNonEmptyString(msg.reconnectToken)) return null;
      return {
        type: 'welcome',
        playerId: msg.playerId,
        serverClock: msg.serverClock,
        roomState: msg.roomState,
        reconnectToken: msg.reconnectToken,
      };

    case 'roster': {
      if (!Array.isArray(msg.players)) return null;
      const players: RosterEntry[] = [];
      for (const entry of msg.players) {
        if (!isObject(entry)) return null;
        if (!isNonEmptyString(entry.playerId)) return null;
        if (!isString(entry.displayName)) return null;
        if (typeof entry.isHost !== 'boolean' || typeof entry.connected !== 'boolean') {
          return null;
        }
        players.push({
          playerId: entry.playerId,
          displayName: entry.displayName,
          isHost: entry.isHost,
          connected: entry.connected,
        });
      }
      return { type: 'roster', players };
    }

    case 'snapshot': {
      const snapshot = parseSnapshot(msg.snapshot);
      if (snapshot === null) return null;
      return { type: 'snapshot', snapshot };
    }

    case 'grabResult': {
      if (!isNonEmptyString(msg.letterId)) return null;
      if (typeof msg.granted !== 'boolean') return null;
      const ownerId = msg.ownerId;
      if (ownerId !== null && !isNonEmptyString(ownerId)) return null;
      return {
        type: 'grabResult',
        letterId: msg.letterId,
        granted: msg.granted,
        ownerId: ownerId === null ? null : ownerId,
      };
    }

    case 'roundState': {
      if (!isRoundState(msg.state)) return null;
      if (msg.result === undefined) {
        return { type: 'roundState', state: msg.state };
      }
      const result = parseRoundResult(msg.result);
      if (result === null) return null;
      return { type: 'roundState', state: msg.state, result };
    }

    default:
      return null;
  }
}
