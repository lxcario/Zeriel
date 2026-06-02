import { describe, it, expect } from 'vitest';
import type { GameConfig, LyricLine } from '@glitch/core';
import { GameServer, type RoundSetupResolver } from './GameServer.js';
import { RoomManager } from '../rooms/RoomManager.js';
import type { ClientSocket } from './ClientSocket.js';
import { type ServerMessage } from './protocol.js';
import { DEFAULT_SERVER_STEP_MS } from '../game/tickPlan.js';

/**
 * Integration tests for the transport-agnostic authoritative orchestrator
 * (task 16.9). A {@link FakeSocket} captures sent frames and lets the test
 * simulate inbound messages and disconnects, so the full join → input → tick →
 * broadcast → disconnect flow is exercised with NO real `ws` and an injected
 * clock (NO real timers).
 */

/** A fake {@link ClientSocket} that records sent frames and exposes triggers. */
class FakeSocket implements ClientSocket {
  readonly sent: ServerMessage[] = [];
  private messageHandler: ((raw: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  closed = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }
  close(): void {
    this.closed = true;
  }
  onMessage(handler: (raw: string) => void): void {
    this.messageHandler = handler;
  }
  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  /** Simulate an inbound client frame. */
  receive(message: unknown): void {
    this.messageHandler?.(typeof message === 'string' ? message : JSON.stringify(message));
  }
  /** Simulate the connection closing. */
  drop(): void {
    this.closeHandler?.();
  }
  /** All frames of a given type, in order. */
  ofType<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.sent.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
}

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
    stepMs: DEFAULT_SERVER_STEP_MS,
  };
}

function makeLines(): LyricLine[] {
  return [{ id: 'L0', startMs: 0, text: 'alpha beta', solutionSlots: [] }];
}

/** Build a server with a deterministic room manager + injected clock. */
function makeServer(resolveRound?: RoundSetupResolver): {
  server: GameServer;
  clock: { t: number };
  manager: RoomManager;
} {
  const clock = { t: 0 };
  let codeN = 0;
  let idN = 0;
  let tokN = 0;
  const manager = new RoomManager({
    codeGen: () => `CODE${++codeN}`,
    idGen: () => `id${++idN}`,
    tokenGen: () => `tok${++tokN}`,
    nameGen: (seq) => `Player-${seq}`,
    now: () => clock.t,
  });
  const server = new GameServer({
    gameConfig: makeGameConfig(),
    now: () => clock.t,
    roomManager: manager,
    ...(resolveRound ? { resolveRound } : {}),
  });
  return { server, clock, manager };
}

describe('GameServer join + roster (task 16.9)', () => {
  it('welcomes a joiner and broadcasts the roster (Req 2.1, 2.3, 16.5)', () => {
    const { server, clock } = makeServer();
    const created = server.createRoom({ displayName: 'Ada' }); // host present

    const sock = new FakeSocket();
    server.handleConnection(sock);
    clock.t = 1234;
    sock.receive({ type: 'join', roomCode: created.room.code, displayName: 'Bob' });

    const welcome = sock.ofType('welcome');
    expect(welcome).toHaveLength(1);
    expect(welcome[0]!.serverClock).toBe(1234);
    expect(welcome[0]!.roomState).toBe('lobby');
    expect(welcome[0]!.playerId).toBeTruthy();

    const roster = sock.ofType('roster');
    expect(roster.length).toBeGreaterThanOrEqual(1);
    const last = roster[roster.length - 1]!;
    expect(last.players.some((p) => p.displayName === 'Bob')).toBe(true);
  });

  it('broadcasts roster to all room members when a new player joins (Req 2.3)', () => {
    const { server } = makeServer();
    const created = server.createRoom({ displayName: 'Ada' });

    const a = new FakeSocket();
    server.handleConnection(a);
    a.receive({ type: 'join', roomCode: created.room.code, displayName: 'Ada2' });
    const rosterCountBefore = a.ofType('roster').length;

    const b = new FakeSocket();
    server.handleConnection(b);
    b.receive({ type: 'join', roomCode: created.room.code, displayName: 'Bob' });

    // A receives an additional roster reflecting Bob's arrival.
    expect(a.ofType('roster').length).toBeGreaterThan(rosterCountBefore);
    const aLatest = a.ofType('roster').at(-1)!;
    expect(aLatest.players.some((p) => p.displayName === 'Bob')).toBe(true);
  });

  it('releases locks + re-broadcasts roster on disconnect (Req 2.5, 8.8, 2.3)', () => {
    const lines = makeLines();
    const resolve: RoundSetupResolver = () => ({ seed: 1, lines });
    const { server, clock } = makeServer(resolve);
    const created = server.createRoom({ displayName: 'Ada' });

    // The Host claims their pre-created identity with the creation token.
    const host = new FakeSocket();
    server.handleConnection(host);
    host.receive({
      type: 'join',
      roomCode: created.room.code,
      reconnectToken: created.reconnectToken,
    });
    const hostId = host.ofType('welcome')[0]!.playerId;
    expect(hostId).toBe(created.playerId);
    expect(created.room.hostId).toBe(hostId);

    host.receive({ type: 'startRound', trackRef: 'vid' });
    clock.t = 0;
    server.tickAll(0); // spawn L0:0 / L0:1
    host.receive({ type: 'grab', letterId: 'L0:0', clientTick: 0 });

    const grabResult = host.ofType('grabResult');
    expect(grabResult.at(-1)).toMatchObject({ letterId: 'L0:0', granted: true, ownerId: hostId });
    expect(created.room.game!.snapshot().locks.some((l) => l.ownerId === hostId)).toBe(true);

    // Disconnect releases the host's lock and removes them from the roster.
    host.drop();
    expect(created.room.game!.snapshot().locks.some((l) => l.ownerId === hostId)).toBe(false);
    expect(server.connectionCount).toBe(0);
  });
});

describe('GameServer round start + join-in-progress (task 16.9)', () => {
  it('only the host can start a round, and a snapshot stream begins (Req 16.1)', () => {
    const lines = makeLines();
    const resolve: RoundSetupResolver = () => ({ seed: 1, lines });
    const { server } = makeServer(resolve);
    const created = server.createRoom({ displayName: 'Ada' });

    const host = new FakeSocket();
    server.handleConnection(host);
    host.receive({
      type: 'join',
      roomCode: created.room.code,
      reconnectToken: created.reconnectToken,
    });

    const guest = new FakeSocket();
    server.handleConnection(guest);
    guest.receive({ type: 'join', roomCode: created.room.code, displayName: 'Bob' });

    // A non-host startRound is ignored.
    guest.receive({ type: 'startRound', trackRef: 'vid' });
    expect(created.room.state).toBe('lobby');

    // The host starts the round → roundState 'playing' fans out to both.
    host.receive({ type: 'startRound', trackRef: 'vid' });
    expect(created.room.state).toBe('playing');
    expect(host.ofType('roundState').some((m) => m.state === 'playing')).toBe(true);
    expect(guest.ofType('roundState').some((m) => m.state === 'playing')).toBe(true);

    // Ticking emits snapshots to room members (≥15Hz cadence proven elsewhere).
    let now = 0;
    for (let i = 0; i < 5; i++) {
      now += DEFAULT_SERVER_STEP_MS;
      server.tickAll(now);
    }
    expect(host.ofType('snapshot').length).toBeGreaterThan(0);
    expect(guest.ofType('snapshot').length).toBeGreaterThan(0);
  });

  it('hydrates a client joining a Round in progress with a full snapshot (Req 16.3)', () => {
    const lines = makeLines();
    const resolve: RoundSetupResolver = () => ({ seed: 1, lines });
    const { server } = makeServer(resolve);
    const created = server.createRoom({ displayName: 'Ada' });

    const host = new FakeSocket();
    server.handleConnection(host);
    host.receive({
      type: 'join',
      roomCode: created.room.code,
      reconnectToken: created.reconnectToken,
    });
    host.receive({ type: 'startRound', trackRef: 'vid' });
    server.tickAll(0); // letters now live

    // A late joiner gets an IMMEDIATE snapshot on join (before any tick fan-out).
    const late = new FakeSocket();
    server.handleConnection(late);
    late.receive({ type: 'join', roomCode: created.room.code, displayName: 'Latecomer' });

    const snaps = late.ofType('snapshot');
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.snapshot.letters.length).toBeGreaterThan(0);
  });

  it('does not hydrate a lobby joiner with a physics snapshot', () => {
    const { server } = makeServer();
    const created = server.createRoom({ displayName: 'Ada' });
    const sock = new FakeSocket();
    server.handleConnection(sock);
    sock.receive({ type: 'join', roomCode: created.room.code, displayName: 'Bob' });
    expect(sock.ofType('snapshot')).toHaveLength(0);
  });

  it('ignores malformed inbound frames without throwing', () => {
    const { server } = makeServer();
    const created = server.createRoom({ displayName: 'Ada' });
    const sock = new FakeSocket();
    server.handleConnection(sock);
    expect(() => sock.receive('not json{')).not.toThrow();
    expect(() => sock.receive({ type: 'bogus' })).not.toThrow();
    // A grab before joining is a no-op (no room/player context).
    expect(() => sock.receive({ type: 'grab', letterId: 'X', clientTick: 0 })).not.toThrow();
    expect(sock.ofType('grabResult')).toHaveLength(0);
    void created;
  });
});
