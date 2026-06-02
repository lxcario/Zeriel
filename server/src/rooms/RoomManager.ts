/**
 * Room Manager (task 16.1) — pure, in-memory session/identity logic for the
 * authoritative Game_Server.
 *
 * Implements the design's `RoomManager` interface (design.md "Game_Server
 * Subsystems — Room Manager"):
 *
 * ```ts
 * interface RoomManager {
 *   createRoom(creator: PlayerInit): Room;                        // 1.1
 *   joinRoom(code: RoomCode, player: PlayerInit): JoinResult;     // 1.5, 2.1
 *   leave(roomCode: RoomCode, playerId: PlayerId): void;          // 2.5, 8.8
 *   reconnect(code: RoomCode, token: ReconnectToken): JoinResult; // 2.6
 * }
 * type JoinResult =
 *   | { ok: true; room: Room; playerId: PlayerId }
 *   | { ok: false; reason: 'not_found' | 'room_full' };
 * ```
 *
 * This module is the PURE Room Manager logic only. There is NO WebSocket wiring
 * here — the authoritative tick loop and `ws` transport that route the design's
 * `join`/`cursor`/`grab`/… messages onto this manager are task 16.9. Keeping the
 * logic transport-free makes it deterministic and directly unit/property
 * testable (Properties 1, 3, 4, 5, 6).
 *
 * ## Injected, deterministic sources (testability)
 * Room_Code, Player_Id, reconnect-token, default-name, and clock are all
 * INJECTABLE via {@link RoomManagerOptions}. Production defaults use real random
 * generators and `Date.now`; tests inject deterministic sequences so creation,
 * collision handling, and the reconnection window are fully reproducible.
 *
 * ## Requirement → behavior map
 * - **1.1** {@link RoomManager.createRoom} creates a Room with a unique,
 *   collision-checked Room_Code and designates the creator as Host.
 * - **1.5** {@link RoomManager.joinRoom} rejects a join at capacity with
 *   `{ ok:false, reason:'room_full' }`.
 * - **1.6 / 2.6** {@link RoomManager.reconnect} restores a dropped player to the
 *   SAME Room with the SAME display name (and the SAME Player_Id) within the
 *   reconnection window.
 * - **2.1** every admitted player gets a session-scoped, process-unique
 *   Player_Id; **2.2** a generated default display name when none is provided.
 * - **2.5 / 8.8** {@link RoomManager.leave} releases ALL of the player's
 *   Ownership_Locks and removes them from the roster (synchronously, hence
 *   "within 2s").
 * - **1.6 / 6 (no account/install)**: identity is session-scoped and generated;
 *   nothing here requires an account or install.
 */

import type {
  Room,
  Player,
  RoomCode,
  PlayerId,
  GameCoreContract,
} from '@glitch/core';

/**
 * Opaque token a dropped client presents to reconnect within the window
 * (design.md `reconnect(code, token: ReconnectToken)` and the `join` message's
 * optional `reconnectToken`). A plain string; issued by the manager on admit.
 */
export type ReconnectToken = string;

/**
 * Initialization data for a player being admitted to a Room (design.md
 * `PlayerInit`). Mirrors the client-controllable fields of the `join` message.
 *
 * - `displayName` — optional desired name. When absent or blank
 *   (empty/whitespace-only), a generated default is assigned before the player
 *   enters the Room (Requirement 2.2).
 * - `reconnectToken` — optional token a returning client may carry. It is part
 *   of `PlayerInit` to mirror the design's `join` message shape, but
 *   {@link RoomManager.createRoom}/{@link RoomManager.joinRoom} do NOT consume it
 *   for admission — they always ISSUE a fresh token. Reconnection is the
 *   dedicated {@link RoomManager.reconnect} path; the server wiring (task 16.9)
 *   routes a `join` carrying a token to `reconnect` rather than `joinRoom`.
 */
export interface PlayerInit {
  displayName?: string;
  reconnectToken?: ReconnectToken;
}

/**
 * Result of a join/reconnect attempt (design.md `JoinResult`). The failure arm's
 * `reason` is `'not_found'` (unknown Room_Code, or an unknown/expired reconnect
 * token) or `'room_full'` (Room at capacity, Requirement 1.5). `'not_found'` is
 * the same literal the join-link layer composes against for the "room not found"
 * UI (Requirement 1.4; see client `joinLink.ts`).
 */
export type JoinResult =
  | { ok: true; room: Room; playerId: PlayerId }
  | { ok: false; reason: 'not_found' | 'room_full' };

/**
 * Construction options for {@link RoomManager}. Every source is optional and
 * defaults to a production-grade implementation; tests override them for
 * determinism.
 */
export interface RoomManagerOptions {
  /** Default Room capacity when {@link RoomManager.createRoom} is not given one (Requirement 1.5). Default 8. */
  maxPlayers?: number;
  /**
   * Reconnection window in milliseconds (Requirements 1.6, 2.6). A dropped
   * player may {@link RoomManager.reconnect} only while
   * `now() - disconnectedAt <= reconnectWindowMs`. Default 30000 (30s).
   */
  reconnectWindowMs?: number;
  /**
   * Room_Code source. The manager calls it repeatedly until it yields a code not
   * in use by a LIVE Room (collision check, Requirement 1.1). Default: a short
   * URL-safe random-code generator.
   */
  codeGen?: () => RoomCode;
  /**
   * Player_Id source. Called repeatedly until it yields an id never assigned in
   * this process (uniqueness, Requirement 2.1 / Property 4). Default: a random
   * id generator.
   */
  idGen?: () => PlayerId;
  /**
   * Reconnect-token source. Default: a random token generator. The manager
   * regenerates on the rare collision with a currently-retained token.
   */
  tokenGen?: () => ReconnectToken;
  /**
   * Default-display-name source, given a monotonically increasing sequence
   * number (Requirement 2.2). MUST return a non-empty string (Property 4).
   * Default: `Player-<seq>`.
   */
  nameGen?: (seq: number) => string;
  /**
   * Monotonic clock used to timestamp disconnects and check the reconnection
   * window. Default: `Date.now`. Injectable so window expiry is deterministic in
   * tests.
   */
  now?: () => number;
}

/** Default Room capacity (Requirement 1.5). */
const DEFAULT_MAX_PLAYERS = 8;
/** Default reconnection window: 30 seconds (Requirements 1.6, 2.6). */
const DEFAULT_RECONNECT_WINDOW_MS = 30_000;
/** Bound on generator retry loops so a degenerate injected source cannot spin forever. */
const MAX_GEN_ATTEMPTS = 1000;
/** Unambiguous alphabet for default Room_Codes (no 0/O/1/I/L to reduce share-link confusion). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** Length of a default Room_Code. */
const CODE_LENGTH = 6;

/**
 * A player removed from the active roster on disconnect but retained so they can
 * be restored within the reconnection window (Requirements 1.6, 2.6). Keyed by
 * the player's {@link ReconnectToken} in {@link RoomManager.retained}.
 */
interface RetainedPlayer {
  /** The removed player (with `connected: false`); restored verbatim on reconnect. */
  player: Player;
  /** Room the player belonged to; reconnect must target the same Room. */
  roomCode: RoomCode;
  /** `now()` at the moment of disconnect; window is measured from here. */
  disconnectedAt: number;
}

/**
 * In-memory, transport-free Room Manager.
 *
 * ## Key documented decisions
 *
 * - **Unique Room_Codes (1.1).** {@link generateRoomCode} calls `codeGen()` and
 *   regenerates while the candidate collides with a LIVE Room (`rooms.has`), so
 *   every created Room has a code distinct from all other live Rooms (Property
 *   1). Codes of departed/empty rooms are only "freed" once their Room object is
 *   gone; this manager does not auto-delete rooms (see room lifecycle below).
 *
 * - **Unique Player_Ids (2.1 / Property 4).** {@link allocatePlayerId} draws from
 *   `idGen()` and regenerates against {@link assignedIds}, the set of EVERY id
 *   ever assigned in this process. Ids are never recycled — even after a player
 *   leaves — so an id is unique among connected players and process-wide.
 *
 * - **Lock release on disconnect (2.5 / 8.8).** {@link leave} releases every
 *   Ownership_Lock the player holds by reading `room.game!.snapshot().locks` and
 *   calling `room.game!.applyInput({ type:'release', playerId, letterId })` for
 *   each lock owned by the player. This uses ONLY the existing
 *   `GameCoreContract` surface — NO new core helper was added (the simplest
 *   option that does not touch the pure `@glitch/core` package). The release is
 *   synchronous, which satisfies "within 2 seconds"; the 2s ceiling is a timing
 *   concern owned by the server tick (task 16.9), not this pure call.
 *
 * - **Disconnect retainer + reconnection window (1.6 / 2.6).** Requirement 2.5
 *   says remove the player from the roster within 2s, while 2.6 says restore the
 *   SAME identity on reconnect. These are reconciled by REMOVING the player from
 *   `room.players` on {@link leave} (satisfying 2.5) while RETAINING a copy in
 *   {@link retained}, keyed by reconnect token with a `disconnectedAt`
 *   timestamp. {@link reconnect} restores the retained player if
 *   `now() - disconnectedAt <= reconnectWindowMs`; otherwise the entry is
 *   discarded and the attempt fails as `'not_found'`.
 *
 * - **Player_Id preserved on reconnect (decision).** Reconnection RESTORES the
 *   original Player_Id (and display name and reconnect token), rather than
 *   issuing a new one. Preserving the id keeps anything keyed by Player_Id
 *   coherent across the drop (e.g. score contributions in `GameCore`) and is the
 *   natural reading of "restore the Player to the same Room with the same
 *   display name" (2.6).
 *
 * - **Capacity on reconnect (decision).** Because {@link leave} frees the
 *   player's roster slot, a returning member is re-admitted only if the Room is
 *   below capacity at reconnect time; if some other player took the slot in the
 *   interim the Room is full and reconnect returns `'room_full'`. Retained
 *   (disconnected) players do NOT count toward capacity, so a join while a member
 *   is away is allowed and may legitimately fill the Room.
 *
 * - **Host reassignment on leave (decision).** If the departing player was the
 *   Host and at least one connected player remains, the Host role moves to the
 *   first remaining player (insertion order). If NO connected player remains,
 *   `hostId` is left pointing at the departed Host, who can {@link reconnect}
 *   within the window and resume control. (Property 1 only constrains
 *   host-at-creation; this keeps a sensible Host afterward.)
 *
 * - **Room lifecycle (decision).** This task does not auto-delete empty Rooms;
 *   keeping the Room alive lets a sole player who dropped reconnect to the SAME
 *   Room (2.6). Room teardown/GC is a server concern wired in task 16.9.
 */
export class RoomManager {
  /** Live Rooms keyed by Room_Code. */
  private readonly rooms = new Map<RoomCode, Room>();
  /** Recently-disconnected players retained for reconnection, keyed by token. */
  private readonly retained = new Map<ReconnectToken, RetainedPlayer>();
  /** Every Player_Id ever assigned in this process (never recycled) — for uniqueness. */
  private readonly assignedIds = new Set<PlayerId>();

  private readonly defaultMaxPlayers: number;
  private readonly reconnectWindowMs: number;
  private readonly codeGen: () => RoomCode;
  private readonly idGen: () => PlayerId;
  private readonly tokenGen: () => ReconnectToken;
  private readonly nameGen: (seq: number) => string;
  private readonly now: () => number;

  /** Monotonic sequence feeding {@link nameGen} for generated default names (Requirement 2.2). */
  private nameSeq = 0;

  constructor(options: RoomManagerOptions = {}) {
    this.defaultMaxPlayers = options.maxPlayers ?? DEFAULT_MAX_PLAYERS;
    this.reconnectWindowMs = options.reconnectWindowMs ?? DEFAULT_RECONNECT_WINDOW_MS;
    this.codeGen = options.codeGen ?? defaultCodeGen;
    this.idGen = options.idGen ?? defaultIdGen;
    this.tokenGen = options.tokenGen ?? defaultTokenGen;
    this.nameGen = options.nameGen ?? defaultNameGen;
    this.now = options.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // createRoom (Requirement 1.1)
  // -------------------------------------------------------------------------

  /**
   * Create a new Room with a unique Room_Code and admit `creator` as the first
   * player and Host (Requirement 1.1). The creator receives a session-scoped
   * Player_Id (2.1), a generated default name when none is provided (2.2), and a
   * reconnect token (2.6). The Room starts in the `lobby` state with the
   * configured capacity.
   *
   * @param creator Initialization data for the creating player.
   * @param maxPlayers Optional capacity override; defaults to the manager's
   *   configured `maxPlayers`.
   * @returns The newly created {@link Room}.
   */
  createRoom(creator: PlayerInit, maxPlayers: number = this.defaultMaxPlayers): Room {
    const code = this.generateRoomCode();
    const host = this.makePlayer(creator);
    const players = new Map<PlayerId, Player>();
    players.set(host.id, host);

    const room: Room = {
      code,
      hostId: host.id,
      players,
      maxPlayers,
      state: 'lobby',
    };
    this.rooms.set(code, room);
    return room;
  }

  // -------------------------------------------------------------------------
  // joinRoom (Requirements 1.5, 2.1, 2.2)
  // -------------------------------------------------------------------------

  /**
   * Admit a new player to an existing Room (Requirements 2.1, 2.2), enforcing
   * capacity (Requirement 1.5).
   *
   * - Unknown `code` → `{ ok:false, reason:'not_found' }`.
   * - Room at capacity (`players.size >= maxPlayers`) →
   *   `{ ok:false, reason:'room_full' }` (1.5, Property 3).
   * - Otherwise the player is admitted with a fresh unique Player_Id (2.1), a
   *   generated default name when none is provided (2.2), and a reconnect token,
   *   and `{ ok:true, room, playerId }` is returned.
   */
  joinRoom(code: RoomCode, player: PlayerInit): JoinResult {
    const room = this.rooms.get(code);
    if (!room) {
      return { ok: false, reason: 'not_found' };
    }
    if (room.players.size >= room.maxPlayers) {
      return { ok: false, reason: 'room_full' };
    }
    const admitted = this.makePlayer(player);
    room.players.set(admitted.id, admitted);
    return { ok: true, room, playerId: admitted.id };
  }

  // -------------------------------------------------------------------------
  // leave (Requirements 2.5, 8.8)
  // -------------------------------------------------------------------------

  /**
   * Handle a player disconnecting from a Room: release ALL Ownership_Locks held
   * by that player (Requirements 2.5, 8.8) and remove them from the active
   * roster (2.5), while RETAINING their identity for the reconnection window so
   * {@link reconnect} can restore them (2.6).
   *
   * Unknown Room or unknown player → no-op (idempotent; a duplicate disconnect or
   * a stale id cannot throw).
   *
   * Lock release uses only the {@link GameCoreContract} surface (snapshot +
   * `release` input) — see the class decision note. Host reassignment follows
   * the documented rule.
   */
  leave(roomCode: RoomCode, playerId: PlayerId): void {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    const player = room.players.get(playerId);
    if (!player) return;

    // 1) Release every Ownership_Lock held by this player (2.5, 8.8).
    this.releaseAllLocks(room.game, playerId);

    // 2) Remove from the active roster (2.5) and retain for reconnection (2.6).
    player.connected = false;
    room.players.delete(playerId);
    this.retained.set(player.reconnectToken, {
      player,
      roomCode,
      disconnectedAt: this.now(),
    });

    // 3) Reassign the Host if the departing player held the role.
    if (room.hostId === playerId) {
      const next = room.players.values().next();
      if (!next.done) {
        room.hostId = next.value.id;
      }
      // else: no connected players remain — leave hostId on the departed Host,
      // who may reconnect within the window and resume control.
    }
  }

  // -------------------------------------------------------------------------
  // reconnect (Requirements 1.6, 2.6)
  // -------------------------------------------------------------------------

  /**
   * Restore a dropped player to the SAME Room with the SAME identity (Player_Id
   * and display name) when they present a valid reconnect `token` within the
   * window (Requirements 1.6, 2.6).
   *
   * Failure cases all return `{ ok:false, reason:'not_found' }`:
   * - unknown `code` (the Room no longer exists),
   * - unknown `token` (never issued, or already consumed),
   * - the token belongs to a DIFFERENT Room than `code`,
   * - the reconnection window has elapsed (the retained entry is then discarded).
   *
   * If the Room is at capacity when the member returns (some other player took
   * the freed slot), the result is `{ ok:false, reason:'room_full' }` and the
   * retained entry is kept so a later retry can still succeed within the window.
   *
   * On success the original {@link Player} is re-added to the roster with
   * `connected: true`, the retained entry is consumed, and
   * `{ ok:true, room, playerId }` is returned with the preserved Player_Id.
   */
  reconnect(code: RoomCode, token: ReconnectToken): JoinResult {
    const room = this.rooms.get(code);
    if (!room) {
      return { ok: false, reason: 'not_found' };
    }
    const entry = this.retained.get(token);
    if (!entry || entry.roomCode !== code) {
      return { ok: false, reason: 'not_found' };
    }
    // Window check: a fully-elapsed window discards the entry and fails.
    if (this.now() - entry.disconnectedAt > this.reconnectWindowMs) {
      this.retained.delete(token);
      return { ok: false, reason: 'not_found' };
    }
    // Capacity re-check: the slot was freed on leave, but another join may have
    // taken it. Keep the retained entry so a retry within the window can succeed.
    if (room.players.size >= room.maxPlayers) {
      return { ok: false, reason: 'room_full' };
    }

    // Restore the SAME player (same id, name, token) to the SAME room (2.6).
    const player = entry.player;
    player.connected = true;
    room.players.set(player.id, player);
    this.retained.delete(token);
    return { ok: true, room, playerId: player.id };
  }

  // -------------------------------------------------------------------------
  // Read accessors (not part of the design interface; convenient for wiring/tests)
  // -------------------------------------------------------------------------

  /** Look up a live Room by code, or `undefined` if none exists. */
  getRoom(code: RoomCode): Room | undefined {
    return this.rooms.get(code);
  }

  /** Number of live Rooms currently tracked. */
  get roomCount(): number {
    return this.rooms.size;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Release every Ownership_Lock held by `playerId` on `game`, using only the
   * {@link GameCoreContract} surface: read the authoritative locks from
   * `snapshot()` and issue a `release` input for each lock the player owns
   * (Requirements 2.5, 8.8). No-op when the Room has no active game.
   */
  private releaseAllLocks(game: GameCoreContract | undefined, playerId: PlayerId): void {
    if (!game) return;
    for (const lock of game.snapshot().locks) {
      if (lock.ownerId === playerId) {
        game.applyInput({ type: 'release', playerId, letterId: lock.letterId });
      }
    }
  }

  /**
   * Build a fresh {@link Player} from {@link PlayerInit}: a process-unique
   * Player_Id (2.1), the provided display name when non-blank else a generated
   * default (2.2), a reconnect token (2.6), a zeroed cursor, `connected: true`,
   * and zero contribution. Always ISSUES a new reconnect token (a token carried
   * in `init` is ignored here; see {@link PlayerInit}).
   */
  private makePlayer(init: PlayerInit): Player {
    const id = this.allocatePlayerId();
    const hasName = typeof init.displayName === 'string' && init.displayName.trim().length > 0;
    const displayName = hasName ? init.displayName! : this.nameGen(++this.nameSeq);
    const reconnectToken = this.allocateToken();
    return {
      id,
      displayName,
      cursor: { x: 0, y: 0 },
      connected: true,
      reconnectToken,
      contribution: 0,
    };
  }

  /** Draw a unique Room_Code, regenerating on collision with a live Room (1.1). */
  private generateRoomCode(): RoomCode {
    for (let attempt = 0; attempt < MAX_GEN_ATTEMPTS; attempt++) {
      const code = this.codeGen();
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('RoomManager: exhausted attempts generating a unique Room_Code');
  }

  /** Draw a process-unique Player_Id, regenerating on collision (2.1 / Property 4). */
  private allocatePlayerId(): PlayerId {
    for (let attempt = 0; attempt < MAX_GEN_ATTEMPTS; attempt++) {
      const id = this.idGen();
      if (!this.assignedIds.has(id)) {
        this.assignedIds.add(id);
        return id;
      }
    }
    throw new Error('RoomManager: exhausted attempts generating a unique Player_Id');
  }

  /** Draw a reconnect token not colliding with a currently-retained token. */
  private allocateToken(): ReconnectToken {
    for (let attempt = 0; attempt < MAX_GEN_ATTEMPTS; attempt++) {
      const token = this.tokenGen();
      if (!this.retained.has(token)) return token;
    }
    throw new Error('RoomManager: exhausted attempts generating a reconnect token');
  }
}

// ---------------------------------------------------------------------------
// Default (production) generators — random, collision-checked by the manager.
// ---------------------------------------------------------------------------

/** Random alphanumeric suffix used to make default ids/tokens collision-resistant. */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Default Room_Code: a short URL-safe code from an unambiguous alphabet. */
function defaultCodeGen(): RoomCode {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

/** Monotonic counter backing the default Player_Id generator. */
let playerIdCounter = 0;
/** Default Player_Id: a counter plus a random suffix; collision-checked by the manager. */
function defaultIdGen(): PlayerId {
  playerIdCounter += 1;
  return `p_${playerIdCounter}_${randomSuffix()}`;
}

/** Monotonic counter backing the default reconnect-token generator. */
let tokenCounter = 0;
/** Default reconnect token: a counter plus two random suffixes for entropy. */
function defaultTokenGen(): ReconnectToken {
  tokenCounter += 1;
  return `rt_${tokenCounter}_${randomSuffix()}${randomSuffix()}`;
}

/** Default generated display name (Requirement 2.2): always non-empty. */
function defaultNameGen(seq: number): string {
  return `Player-${seq}`;
}
