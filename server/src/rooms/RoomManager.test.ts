import { describe, it, expect } from 'vitest';
import type { GameConfig, LyricLine } from '@glitch/core';
import { GameCore } from '@glitch/core';
import { RoomManager, type RoomManagerOptions } from './RoomManager.js';

/**
 * Smoke unit tests for task 16.1: the in-memory Room Manager.
 *
 * These prove the core guarantees of the task with deterministic, injected
 * sources (codeGen / idGen / tokenGen / nameGen / now):
 * - createRoom yields a unique code + creator is Host (1.1)
 * - joinRoom admits with a fresh id + generated default name when none given (2.1, 2.2)
 * - capacity enforcement returns room_full at max (1.5)
 * - joinRoom on an unknown code returns not_found
 * - leave removes the player (2.5) and releases that player's locks via room.game (2.5/8.8)
 * - reconnect within the window restores the same Room + same displayName + same id (2.6)
 * - reconnect with an expired/unknown token fails
 *
 * The dedicated PROPERTY tests are optional tasks 16.2–16.6 and are NOT here.
 */

/** A representative GameCore config (mirrors core/src/gameCore tests). */
function makeGameConfig(): GameConfig {
  return {
    gravity: { x: 0, y: 980 },
    damping: 0.98,
    constraintIterations: 8,
    subSteps: 1,
    defaultStiffness: 0.8,
    constraintTolerance: 0.5,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    restitution: 0.3,
    colliderRadius: 10,
    spawnBand: { x: 0, y: 0, width: 800, height: 120 },
    placementTolerance: 24,
    maxPlayers: 8,
    stepMs: 1000 / 30,
  };
}

function makeLine(id: string, text: string): LyricLine {
  return { id, startMs: 0, text, solutionSlots: [] };
}

/**
 * Build a manager with deterministic sequenced sources. Codes/ids/tokens are
 * drawn in order; `now` is a mutable clock the test advances by hand.
 */
function makeManager(overrides: Partial<RoomManagerOptions> = {}): {
  mgr: RoomManager;
  clock: { t: number };
} {
  const clock = { t: 0 };
  let codeN = 0;
  let idN = 0;
  let tokN = 0;
  const mgr = new RoomManager({
    codeGen: () => `CODE${++codeN}`,
    idGen: () => `id${++idN}`,
    tokenGen: () => `tok${++tokN}`,
    nameGen: (seq) => `Player-${seq}`,
    now: () => clock.t,
    reconnectWindowMs: 1000,
    maxPlayers: 8,
    ...overrides,
  });
  return { mgr, clock };
}

describe('RoomManager.createRoom (Requirement 1.1)', () => {
  it('creates a room with a unique code and designates the creator as host', () => {
    const { mgr } = makeManager();
    const room = mgr.createRoom({ displayName: 'Ada' });

    expect(room.code).toBe('CODE1');
    expect(room.state).toBe('lobby');
    expect(room.players.size).toBe(1);
    // The single player is the host (1.1).
    const [hostId, host] = [...room.players.entries()][0]!;
    expect(room.hostId).toBe(hostId);
    expect(host.displayName).toBe('Ada');
    expect(host.connected).toBe(true);
  });

  it('regenerates the code on collision so live rooms never share a code (1.1)', () => {
    // codeGen yields a duplicate first, then a fresh code; the manager must skip
    // the collision and hand the second room a distinct code.
    const codes = ['DUP', 'DUP', 'FRESH'];
    let i = 0;
    const { mgr } = makeManager({ codeGen: () => codes[i++]! });
    const a = mgr.createRoom({});
    const b = mgr.createRoom({});
    expect(a.code).toBe('DUP');
    expect(b.code).toBe('FRESH');
    expect(a.code).not.toBe(b.code);
  });
});

describe('RoomManager.joinRoom (Requirements 1.5, 2.1, 2.2)', () => {
  it('admits a joiner with a fresh unique id and a generated default name when none is given (2.1, 2.2)', () => {
    const { mgr } = makeManager();
    const room = mgr.createRoom({ displayName: 'Host' });
    const res = mgr.joinRoom(room.code, {});

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const joiner = res.room.players.get(res.playerId)!;
    // Unique id distinct from the host.
    expect(res.playerId).not.toBe(room.hostId);
    // Generated, non-empty default display name (2.2).
    expect(joiner.displayName.length).toBeGreaterThan(0);
    expect(joiner.displayName).toMatch(/^Player-\d+$/);
    expect(res.room.players.size).toBe(2);
  });

  it('uses a blank display name as "not provided" and assigns a default (2.2)', () => {
    const { mgr } = makeManager();
    const room = mgr.createRoom({ displayName: '   ' });
    const host = room.players.get(room.hostId)!;
    expect(host.displayName).toMatch(/^Player-\d+$/);
  });

  it('enforces capacity, returning room_full at max (1.5)', () => {
    const { mgr } = makeManager({ maxPlayers: 2 });
    const room = mgr.createRoom({ displayName: 'Host' }); // 1 of 2
    const second = mgr.joinRoom(room.code, {}); // 2 of 2
    expect(second.ok).toBe(true);

    const third = mgr.joinRoom(room.code, {});
    expect(third).toEqual({ ok: false, reason: 'room_full' });
    expect(room.players.size).toBe(2);
  });

  it('returns not_found for an unknown room code', () => {
    const { mgr } = makeManager();
    expect(mgr.joinRoom('NOPE', {})).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('RoomManager.leave (Requirements 2.5, 8.8)', () => {
  it('removes the player from the roster (2.5)', () => {
    const { mgr } = makeManager();
    const room = mgr.createRoom({ displayName: 'Host' });
    const join = mgr.joinRoom(room.code, { displayName: 'Bob' });
    expect(join.ok).toBe(true);
    if (!join.ok) return;

    mgr.leave(room.code, join.playerId);
    expect(room.players.has(join.playerId)).toBe(false);
    expect(room.players.size).toBe(1);
  });

  it("releases all of the leaving player's ownership locks when a game is present (2.5/8.8)", () => {
    const { mgr } = makeManager();
    const room = mgr.createRoom({ displayName: 'Host' });
    const join = mgr.joinRoom(room.code, { displayName: 'Bob' });
    expect(join.ok).toBe(true);
    if (!join.ok) return;
    const bob = join.playerId;

    // Attach a live game with a spawned line and have Bob grab two letters.
    const game = new GameCore(1, makeGameConfig());
    game.spawnLine(makeLine('L', 'alpha beta gamma'));
    room.game = game;
    game.applyInput({ type: 'grab', playerId: bob, letterId: 'L:0', clientTick: 0 });
    game.applyInput({ type: 'grab', playerId: bob, letterId: 'L:1', clientTick: 0 });
    // Host grabs a third so we can confirm only Bob's locks are released.
    game.applyInput({ type: 'grab', playerId: room.hostId, letterId: 'L:2', clientTick: 0 });

    expect(game.snapshot().locks).toEqual(
      expect.arrayContaining([
        { letterId: 'L:0', ownerId: bob },
        { letterId: 'L:1', ownerId: bob },
        { letterId: 'L:2', ownerId: room.hostId },
      ]),
    );

    mgr.leave(room.code, bob);

    // All of Bob's locks are cleared; the host's lock remains (8.8).
    const locks = game.snapshot().locks;
    expect(locks.some((l) => l.ownerId === bob)).toBe(false);
    expect(locks).toEqual([{ letterId: 'L:2', ownerId: room.hostId }]);
  });

  it('reassigns the host to a remaining player when the host leaves', () => {
    const { mgr } = makeManager();
    const room = mgr.createRoom({ displayName: 'Host' });
    const join = mgr.joinRoom(room.code, { displayName: 'Bob' });
    expect(join.ok).toBe(true);
    if (!join.ok) return;

    const originalHost = room.hostId;
    mgr.leave(room.code, originalHost);
    expect(room.hostId).toBe(join.playerId);
    expect(room.hostId).not.toBe(originalHost);
  });

  it('is a no-op for an unknown room or unknown player', () => {
    const { mgr } = makeManager();
    const room = mgr.createRoom({ displayName: 'Host' });
    expect(() => mgr.leave('NOPE', 'whoever')).not.toThrow();
    expect(() => mgr.leave(room.code, 'not-a-member')).not.toThrow();
    expect(room.players.size).toBe(1);
  });
});

describe('RoomManager.reconnect (Requirements 1.6, 2.6)', () => {
  it('restores the same room, same display name, and same player id within the window (2.6)', () => {
    const { mgr, clock } = makeManager({ reconnectWindowMs: 1000 });
    const room = mgr.createRoom({ displayName: 'Host' });
    const join = mgr.joinRoom(room.code, { displayName: 'Bob' });
    expect(join.ok).toBe(true);
    if (!join.ok) return;
    const bobId = join.playerId;
    const token = room.players.get(bobId)!.reconnectToken;

    mgr.leave(room.code, bobId);
    expect(room.players.has(bobId)).toBe(false);

    // Advance the clock but stay within the window.
    clock.t = 999;
    const res = mgr.reconnect(room.code, token);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Same room, same id, same display name (2.6).
    expect(res.room.code).toBe(room.code);
    expect(res.playerId).toBe(bobId);
    const restored = res.room.players.get(bobId)!;
    expect(restored.displayName).toBe('Bob');
    expect(restored.connected).toBe(true);
  });

  it('fails as not_found when the reconnection window has elapsed', () => {
    const { mgr, clock } = makeManager({ reconnectWindowMs: 1000 });
    const room = mgr.createRoom({ displayName: 'Host' });
    const join = mgr.joinRoom(room.code, { displayName: 'Bob' });
    expect(join.ok).toBe(true);
    if (!join.ok) return;
    const token = room.players.get(join.playerId)!.reconnectToken;

    mgr.leave(room.code, join.playerId);
    clock.t = 1001; // just past the window
    expect(mgr.reconnect(room.code, token)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('fails as not_found for an unknown token or wrong room', () => {
    const { mgr } = makeManager();
    const room = mgr.createRoom({ displayName: 'Host' });
    const join = mgr.joinRoom(room.code, { displayName: 'Bob' });
    expect(join.ok).toBe(true);
    if (!join.ok) return;
    const token = room.players.get(join.playerId)!.reconnectToken;
    mgr.leave(room.code, join.playerId);

    // Unknown token.
    expect(mgr.reconnect(room.code, 'bogus')).toEqual({ ok: false, reason: 'not_found' });
    // Right token, wrong room.
    const other = mgr.createRoom({ displayName: 'Other' });
    expect(mgr.reconnect(other.code, token)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('returns room_full when the freed slot was taken before the member returns', () => {
    const { mgr } = makeManager({ maxPlayers: 2 });
    const room = mgr.createRoom({ displayName: 'Host' }); // 1/2
    const join = mgr.joinRoom(room.code, { displayName: 'Bob' }); // 2/2
    expect(join.ok).toBe(true);
    if (!join.ok) return;
    const token = room.players.get(join.playerId)!.reconnectToken;

    mgr.leave(room.code, join.playerId); // 1/2, Bob retained
    const filler = mgr.joinRoom(room.code, { displayName: 'Carol' }); // 2/2 again
    expect(filler.ok).toBe(true);

    expect(mgr.reconnect(room.code, token)).toEqual({ ok: false, reason: 'room_full' });
  });
});
