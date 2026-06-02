/**
 * `GameServer` — the authoritative server orchestrator (task 16.9).
 *
 * Wires together the three server subsystems the design names (design.md
 * "Game_Server Subsystems"):
 * - the pure {@link RoomManager} (task 16.1) — Room/identity/lock lifecycle;
 * - one {@link GameRoom} per Room — the authoritative `GameCore` 30Hz tick +
 *   State Broadcaster decisions (this task);
 * - the message protocol routing (`join`/`cursor`/`grab`/`release`/`startRound`
 *   → manager/room; `welcome`/`roster`/`snapshot`/`grabResult`/`roundState`
 *   → clients).
 *
 * ## Transport-agnostic (testability)
 * `GameServer` depends only on the tiny {@link ClientSocket} abstraction and an
 * INJECTED clock + timer, NOT on `ws`. Tests drive it with fake sockets and
 * synthetic time (call {@link handleConnection} with a fake socket, push frames,
 * call {@link tickAll}); the real `ws` listening server is a thin separate
 * adapter (`wsServer.ts`) that constructs a `GameServer` and feeds it adapted
 * sockets. This keeps every routing/broadcast DECISION unit-testable without
 * opening a port — the pure rate/scheduling/join decisions live in
 * `tickPlan.ts` / `broadcastSchedule.ts` / `joinInProgress.ts`.
 *
 * ## The ~30Hz loop
 * {@link start} begins an injected interval timer that calls {@link tickAll} on
 * every wake; each call advances every playing {@link GameRoom} to the current
 * clock. The fixed-timestep math in {@link GameRoom} keeps physics at a stable
 * ~30Hz regardless of the timer's actual cadence (Requirement 14.6). A broadcast
 * fans the room's authoritative snapshot out to every connection in that Room at
 * ≥15Hz (Requirements 16.1, 2.4, 9.3). Tests skip {@link start} and call
 * {@link tickAll} directly.
 *
 * ## Roster + join-in-progress
 * On a successful `join`/reconnect the server sends `welcome` (identity + server
 * clock for offset estimation, Requirement 16.5), broadcasts the updated
 * `roster` to the Room (Requirement 2.3), and — iff the Room is mid-Round
 * ({@link shouldSendJoinSnapshot}) — sends the late joiner a full authoritative
 * `snapshot` so they render the same play state as existing Players (Requirement
 * 16.3). On disconnect the server releases the player's locks + removes them via
 * the manager (Requirements 2.5, 8.8) and re-broadcasts the roster.
 */

import { RoomManager, type PlayerInit, type JoinResult } from '../rooms/RoomManager.js';
import { GameRoom, type GameRoomConfig, type RoundSetup } from '../game/GameRoom.js';
import { shouldSendJoinSnapshot } from '../game/joinInProgress.js';
import type { ClientSocket, ConnectionId } from './ClientSocket.js';
import {
  parseClientMessage,
  serializeServerMessage,
  type ClientMessage,
  type ServerMessage,
  type RosterEntry,
} from './protocol.js';
import type {
  GameConfig,
  RoomCode,
  PlayerId,
  RoundState,
  RoundResult,
  Snapshot,
  Room,
} from '@glitch/core';

/** Identity issued to a Room creator: the code, their Player_Id, and a claim token. */
export interface CreatedRoom {
  /** The created Room (creator is its Host). */
  room: Room;
  /** The creator/Host's session-scoped Player_Id. */
  playerId: PlayerId;
  /**
   * The reconnect token the creator presents on a WS `join` to CLAIM this
   * pre-created Host identity (rather than being admitted as a fresh player).
   */
  reconnectToken: string;
}

/** Per-connection state the server tracks for routing and broadcast fan-out. */
interface Connection {
  id: ConnectionId;
  socket: ClientSocket;
  /** Room this connection has joined, or `null` until a successful `join`. */
  roomCode: RoomCode | null;
  /** Player identity assigned on join, or `null` until then. */
  playerId: PlayerId | null;
}

/**
 * Resolves the Lyric_Lines (and seed/title) for a `startRound` request. The
 * authoritative server does not itself fetch lyrics/audio — the design resolves
 * those client-side; this hook lets the host/wiring supply a resolved
 * {@link RoundSetup} for a `trackRef`, or `null` to reject the start. Injectable
 * so tests can provide deterministic lines.
 */
export type RoundSetupResolver = (
  trackRef: string,
  room: Room,
) => RoundSetup | null;

/** Construction options for {@link GameServer}; clock + timer are injectable. */
export interface GameServerOptions {
  /** Static `GameCore` configuration used for every Round. */
  gameConfig: GameConfig;
  /** Monotonic clock in ms. Defaults to `Date.now`; injected for deterministic tests. */
  now?: () => number;
  /** Pre-constructed {@link RoomManager}; defaults to a fresh one. */
  roomManager?: RoomManager;
  /**
   * Tick interval in ms for the authoritative loop. Defaults to ~16ms (~60Hz
   * wake) so the ~30Hz physics and ≥15Hz broadcast both have ample headroom.
   */
  tickIntervalMs?: number;
  /** Per-{@link GameRoom} broadcast spacing in ms (forwarded; ≥15Hz enforced there). */
  broadcastIntervalMs?: number;
  /** Resolver supplying lines/seed/title for a `startRound` (else the start is rejected). */
  resolveRound?: RoundSetupResolver;
  /** Interval timer factory; defaults to `setInterval`. Injected for tests. */
  setTimer?: (cb: () => void, intervalMs: number) => unknown;
  /** Interval timer canceller; defaults to `clearInterval`. */
  clearTimer?: (handle: unknown) => void;
}

/** Default authoritative loop wake interval (~60Hz) — physics still ticks at 30Hz. */
const DEFAULT_TICK_INTERVAL_MS = 1000 / 60;

export class GameServer {
  private readonly gameConfig: GameConfig;
  private readonly now: () => number;
  private readonly rooms: RoomManager;
  private readonly tickIntervalMs: number;
  private readonly broadcastIntervalMs: number | undefined;
  private readonly resolveRound: RoundSetupResolver | undefined;
  private readonly setTimer: (cb: () => void, intervalMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  /** Live connections keyed by connection id. */
  private readonly connections = new Map<ConnectionId, Connection>();
  /** Connection ids per Room for broadcast fan-out. */
  private readonly roomConnections = new Map<RoomCode, Set<ConnectionId>>();
  /** Authoritative simulation per Room, created lazily on first need. */
  private readonly gameRooms = new Map<RoomCode, GameRoom>();

  /** Monotonic connection-id source. */
  private nextConnectionId = 1;
  /** Loop timer handle while running, else `null`. */
  private timerHandle: unknown = null;

  constructor(options: GameServerOptions) {
    this.gameConfig = options.gameConfig;
    this.now = options.now ?? Date.now;
    this.rooms = options.roomManager ?? new RoomManager({ maxPlayers: options.gameConfig.maxPlayers });
    this.tickIntervalMs =
      options.tickIntervalMs && options.tickIntervalMs > 0
        ? options.tickIntervalMs
        : DEFAULT_TICK_INTERVAL_MS;
    this.broadcastIntervalMs = options.broadcastIntervalMs;
    this.resolveRound = options.resolveRound;
    this.setTimer =
      options.setTimer ?? ((cb, ms) => setInterval(cb, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  }

  // -------------------------------------------------------------------------
  // Loop control
  // -------------------------------------------------------------------------

  /**
   * Start the authoritative ~30Hz loop: a repeating timer that calls
   * {@link tickAll} with the current clock on every wake. Idempotent. Tests
   * normally skip this and call {@link tickAll} directly with synthetic time.
   */
  start(): void {
    if (this.timerHandle !== null) return;
    this.timerHandle = this.setTimer(() => this.tickAll(this.now()), this.tickIntervalMs);
  }

  /** Stop the authoritative loop timer. Idempotent. */
  stop(): void {
    if (this.timerHandle === null) return;
    this.clearTimer(this.timerHandle);
    this.timerHandle = null;
  }

  /**
   * Advance every {@link GameRoom} to monotonic time `nowMs` (the loop body).
   * Each room ticks its `GameCore` the appropriate number of fixed steps and
   * broadcasts when due; round-end transitions fire through `onRoundState`.
   */
  tickAll(nowMs: number): void {
    for (const room of this.gameRooms.values()) {
      room.advance(nowMs);
    }
  }

  // -------------------------------------------------------------------------
  // Connection handling
  // -------------------------------------------------------------------------

  /**
   * Register a new client connection (a real `ws` socket adapted to
   * {@link ClientSocket}, or a fake in tests). Wires the inbound-message and
   * close handlers and returns the assigned {@link ConnectionId}. No protocol
   * action happens until the client sends a `join`.
   */
  handleConnection(socket: ClientSocket): ConnectionId {
    const id = this.nextConnectionId++;
    const conn: Connection = { id, socket, roomCode: null, playerId: null };
    this.connections.set(id, conn);
    socket.onMessage((raw) => this.onMessage(conn, raw));
    socket.onClose(() => this.onClose(conn));
    return id;
  }

  /** Number of live connections (diagnostic / tests). */
  get connectionCount(): number {
    return this.connections.size;
  }

  /**
   * Create a new Room out-of-band (the design's `RoomManager.createRoom`, called
   * by a lobby/HTTP flow — there is no `create` WS message). The creator is the
   * Host (Requirement 1.1) and receives a {@link CreatedRoom.reconnectToken}
   * they present on a subsequent WS `join` to CLAIM this Host identity rather
   * than being admitted as a fresh player. Returns the Room, the Host's
   * Player_Id, and that token.
   */
  createRoom(creator: PlayerInit = {}): CreatedRoom {
    const room = this.rooms.createRoom(creator);
    const host = room.players.get(room.hostId)!;
    return { room, playerId: room.hostId, reconnectToken: host.reconnectToken };
  }

  // -------------------------------------------------------------------------
  // Inbound message routing
  // -------------------------------------------------------------------------

  /** Parse + dispatch one inbound frame; malformed frames are ignored. */
  private onMessage(conn: Connection, raw: string): void {
    const msg = parseClientMessage(raw);
    if (!msg) return; // malformed/hostile frame: safely ignored.
    switch (msg.type) {
      case 'join':
        this.handleJoin(conn, msg);
        return;
      case 'cursor':
      case 'grab':
      case 'release':
        this.handleGameInput(conn, msg);
        return;
      case 'startRound':
        this.handleStartRound(conn, msg);
        return;
    }
  }

  /**
   * Route a `join`. A token-bearing join first tries to CLAIM an active,
   * pre-created identity in the target Room (the Host from {@link createRoom},
   * who exists in the roster but has no live connection yet); failing that it
   * tries to {@link RoomManager.reconnect} a retained (dropped) player
   * (Requirement 2.6); a tokenless join admits a fresh player (Requirements 2.1,
   * 2.2, 1.5). On success record the connection's room/player, send `welcome`,
   * broadcast the `roster`, and hydrate a mid-Round joiner with a full
   * `snapshot` (Requirement 16.3).
   */
  private handleJoin(conn: Connection, msg: Extract<ClientMessage, { type: 'join' }>): void {
    const result = this.resolveJoin(conn, msg);

    if (!result.ok) {
      // A failed join is reported to the joining socket only; the server keeps
      // the connection open so the client can surface "room not found"/"full".
      this.sendTo(conn, { type: 'roundState', state: 'lobby' });
      return;
    }

    conn.roomCode = result.room.code;
    conn.playerId = result.playerId;
    this.addRoomConnection(result.room.code, conn.id);

    const player = result.room.players.get(result.playerId);
    const reconnectToken = player ? player.reconnectToken : '';

    this.sendTo(conn, {
      type: 'welcome',
      playerId: result.playerId,
      serverClock: this.now(),
      roomState: result.room.state,
      reconnectToken,
    });

    this.broadcastRoster(result.room);

    // Join-in-progress: hydrate the late joiner with the authoritative state so
    // they render the same play state as existing Players (Requirement 16.3).
    if (shouldSendJoinSnapshot(result.room.state)) {
      const game = this.gameRooms.get(result.room.code);
      const snap = game ? game.snapshot() : null;
      if (snap) this.sendTo(conn, { type: 'snapshot', snapshot: snap });
    }
  }

  /**
   * Resolve a `join` to a {@link JoinResult}, choosing among the three paths:
   * claim an active pre-created identity by token, reconnect a retained player,
   * or admit a fresh player. Bound `conn` is used only to avoid binding the same
   * already-bound identity twice.
   */
  private resolveJoin(
    conn: Connection,
    msg: Extract<ClientMessage, { type: 'join' }>,
  ): JoinResult {
    if (msg.reconnectToken) {
      // 1) Claim an ACTIVE pre-created identity (e.g. the Host from createRoom)
      //    whose token matches and who has no live connection yet.
      const claim = this.claimActiveIdentity(msg.roomCode, msg.reconnectToken);
      if (claim) return claim;
      // 2) Otherwise reconnect a retained (dropped) player (Requirement 2.6).
      return this.rooms.reconnect(msg.roomCode, msg.reconnectToken);
    }
    // 3) Fresh admission (Requirements 2.1, 2.2, 1.5).
    void conn;
    return this.rooms.joinRoom(msg.roomCode, this.toPlayerInit(msg));
  }

  /**
   * If `token` matches an ACTIVE player already in Room `code` (the pre-created
   * Host who exists in the roster but is not yet bound to a live connection),
   * return a success {@link JoinResult} binding to that identity. Returns `null`
   * if no such active identity exists (so the caller falls back to reconnect).
   * An identity already bound to a live connection is NOT claimable again.
   */
  private claimActiveIdentity(code: RoomCode, token: string): JoinResult | null {
    const room = this.rooms.getRoom(code);
    if (!room) return null;
    for (const player of room.players.values()) {
      if (player.reconnectToken !== token) continue;
      // Reject a double-claim of an identity already bound to a connection.
      for (const c of this.connections.values()) {
        if (c.roomCode === code && c.playerId === player.id) return null;
      }
      return { ok: true, room, playerId: player.id };
    }
    return null;
  }

  /**
   * Route a `cursor`/`grab`/`release` into the connection's {@link GameRoom}
   * (Requirements 8.1–8.4, 2.4). The server attributes the input to the
   * connection's `playerId`. A `grab` echoes a `grabResult` back to the
   * requesting client (Requirements 8.1, 8.2, 8.7); the new authoritative lock
   * state also reaches everyone via the next broadcast.
   */
  private handleGameInput(
    conn: Connection,
    msg: Extract<ClientMessage, { type: 'cursor' | 'grab' | 'release' }>,
  ): void {
    if (conn.roomCode === null || conn.playerId === null) return;
    const game = this.gameRooms.get(conn.roomCode);
    if (!game) return;
    const playerId = conn.playerId;

    if (msg.type === 'cursor') {
      game.applyInput({ type: 'cursor', playerId, x: msg.x, y: msg.y });
      return;
    }
    if (msg.type === 'release') {
      game.applyInput({ type: 'release', playerId, letterId: msg.letterId });
      return;
    }
    // grab
    const outcome = game.applyInput({
      type: 'grab',
      playerId,
      letterId: msg.letterId,
      clientTick: msg.clientTick,
    });
    if (outcome.type === 'grab') {
      this.sendTo(conn, {
        type: 'grabResult',
        letterId: outcome.letterId,
        granted: outcome.granted,
        ownerId: outcome.ownerId,
      });
    }
  }

  /**
   * Route a `startRound`: only the Room's Host may start (Requirement 3.6 /
   * round control). The injected {@link RoundSetupResolver} supplies the
   * resolved lines/seed/title for the `trackRef`; a `null` resolution or a
   * non-host requester is rejected silently (the lifecycle also rejects a start
   * from a non-ready state). On success the `GameRoom` notifies `playing` and
   * begins broadcasting.
   */
  private handleStartRound(
    conn: Connection,
    msg: Extract<ClientMessage, { type: 'startRound' }>,
  ): void {
    if (conn.roomCode === null || conn.playerId === null) return;
    const room = this.rooms.getRoom(conn.roomCode);
    if (!room) return;
    if (room.hostId !== conn.playerId) return; // round control is host-only.
    if (!this.resolveRound) return; // no resolver wired: cannot start.

    const setup = this.resolveRound(msg.trackRef, room);
    if (!setup) return;

    const game = this.ensureGameRoom(room);
    game.startRound(setup);
  }

  // -------------------------------------------------------------------------
  // Disconnect
  // -------------------------------------------------------------------------

  /**
   * Handle a connection closing: release the player's Ownership_Locks and remove
   * them from the roster via the manager (Requirements 2.5, 8.8), drop the
   * connection from the Room fan-out set, and re-broadcast the roster to the
   * remaining Players (Requirement 2.3). Idempotent for an unknown connection.
   */
  private onClose(conn: Connection): void {
    this.connections.delete(conn.id);
    if (conn.roomCode === null) return;

    const set = this.roomConnections.get(conn.roomCode);
    if (set) {
      set.delete(conn.id);
      if (set.size === 0) this.roomConnections.delete(conn.roomCode);
    }

    if (conn.playerId !== null) {
      this.rooms.leave(conn.roomCode, conn.playerId);
    }
    const room = this.rooms.getRoom(conn.roomCode);
    if (room) this.broadcastRoster(room);
  }

  // -------------------------------------------------------------------------
  // GameRoom lifecycle + broadcast wiring
  // -------------------------------------------------------------------------

  /**
   * Get or lazily create the {@link GameRoom} for `room`, wiring its broadcast
   * and round-state sinks to fan out to every connection in the Room. The
   * snapshot/roundState messages are the ≥15Hz authoritative stream and the
   * lifecycle notifications respectively.
   */
  private ensureGameRoom(room: Room): GameRoom {
    let game = this.gameRooms.get(room.code);
    if (game) return game;

    const config: GameRoomConfig = {
      room,
      gameConfig: this.gameConfig,
      now: this.now,
      onBroadcast: (snapshot: Snapshot) =>
        this.broadcastToRoom(room.code, { type: 'snapshot', snapshot }),
      onRoundState: (state: RoundState, result?: RoundResult) =>
        this.broadcastToRoom(room.code, {
          type: 'roundState',
          state,
          ...(result !== undefined ? { result } : {}),
        }),
      ...(this.broadcastIntervalMs !== undefined
        ? { broadcastIntervalMs: this.broadcastIntervalMs }
        : {}),
    };
    game = new GameRoom(config);
    this.gameRooms.set(room.code, game);
    return game;
  }

  /** Build and broadcast the current roster for `room` (Requirement 2.3). */
  private broadcastRoster(room: Room): void {
    const players: RosterEntry[] = [];
    for (const player of room.players.values()) {
      players.push({
        playerId: player.id,
        displayName: player.displayName,
        isHost: player.id === room.hostId,
        connected: player.connected,
      });
    }
    this.broadcastToRoom(room.code, { type: 'roster', players });
  }

  // -------------------------------------------------------------------------
  // Low-level send helpers
  // -------------------------------------------------------------------------

  /** Track a connection id under its Room for broadcast fan-out. */
  private addRoomConnection(code: RoomCode, id: ConnectionId): void {
    let set = this.roomConnections.get(code);
    if (!set) {
      set = new Set();
      this.roomConnections.set(code, set);
    }
    set.add(id);
  }

  /** Send one server message to a single connection. */
  private sendTo(conn: Connection, message: ServerMessage): void {
    conn.socket.send(serializeServerMessage(message));
  }

  /** Send one server message to every live connection in a Room. */
  private broadcastToRoom(code: RoomCode, message: ServerMessage): void {
    const set = this.roomConnections.get(code);
    if (!set) return;
    const frame = serializeServerMessage(message);
    for (const id of set) {
      const conn = this.connections.get(id);
      if (conn) conn.socket.send(frame);
    }
  }

  /** Map a `join` message into the manager's {@link PlayerInit} shape. */
  private toPlayerInit(msg: Extract<ClientMessage, { type: 'join' }>): PlayerInit {
    return {
      ...(msg.displayName !== undefined ? { displayName: msg.displayName } : {}),
      ...(msg.reconnectToken !== undefined ? { reconnectToken: msg.reconnectToken } : {}),
    };
  }
}
