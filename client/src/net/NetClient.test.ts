import { describe, it, expect } from 'vitest';
import { GameCore } from '@glitch/core';
import type { GameConfig, LyricLine, Snapshot } from '@glitch/core';
import { NetClient, type NetSocket } from './NetClient.ts';
import type { RosterEntry } from './protocol.ts';

/**
 * Integration tests for the {@link NetClient} (task 17.3): protocol + prediction
 * + reconciliation wired to a REAL prediction `GameCore` over a FAKE socket (no
 * live ws). These exercise the three concerns together — encode C→S, decode S→C,
 * predict a grab, and reconcile a contradicting snapshot — without a network.
 */

/** Representative GameCore config (mirrors core/src/gameCore/*.test.ts). */
function makeConfig(): GameConfig {
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

/** A controllable in-memory socket: captures sends, pushes inbound frames. */
class FakeSocket implements NetSocket {
  readonly sent: string[] = [];
  closed = false;
  private messageHandler: ((raw: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.closeHandler?.();
  }
  onMessage(handler: (raw: string) => void): void {
    this.messageHandler = handler;
  }
  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  /** Simulate an inbound server frame (object → JSON, as the wire would carry). */
  receive(message: unknown): void {
    const raw = typeof message === 'string' ? message : JSON.stringify(message);
    this.messageHandler?.(raw);
  }

  /** The parsed JSON of every frame sent, in order. */
  sentParsed(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

/** Build a snapshot from the core, then override locks/tick for the test. */
function snapshotWith(core: GameCore, overrides: Partial<Snapshot>): Snapshot {
  return { ...core.snapshot(), ...overrides };
}

describe('NetClient (task 17.3)', () => {
  it('sends join and estimates a clock offset from welcome (16.5)', () => {
    const socket = new FakeSocket();
    const core = new GameCore(1, makeConfig());
    let t = 1000;
    const net = new NetClient({ socket, core, now: () => t });

    net.join('ROOM42', 'Ada');
    expect(socket.sentParsed()[0]).toEqual({ type: 'join', roomCode: 'ROOM42', displayName: 'Ada' });

    // Reply arrives 100ms later; server clock leads client by ~5000ms.
    t = 1100;
    socket.receive({
      type: 'welcome',
      playerId: 'me',
      serverClock: 6050, // tServer - midpoint(1000,1100) = 6050 - 1050 = 5000
      roomState: 'lobby',
      reconnectToken: 'rt1',
    });

    expect(net.getPlayerId()).toBe('me');
    expect(net.getClockOffset()).toBe(5000);
  });

  it('replays the reconnect token on a subsequent join (2.6)', () => {
    const socket = new FakeSocket();
    const core = new GameCore(1, makeConfig());
    const net = new NetClient({ socket, core, now: () => 0 });

    net.join('ROOM42');
    socket.receive({
      type: 'welcome',
      playerId: 'me',
      serverClock: 0,
      roomState: 'lobby',
      reconnectToken: 'rt-xyz',
    });
    net.join('ROOM42');

    expect(socket.sentParsed()[1]).toEqual({
      type: 'join',
      roomCode: 'ROOM42',
      reconnectToken: 'rt-xyz',
    });
  });

  it('predicts a grab on an unlocked letter and sends the grab (8.1, 8.5)', () => {
    const socket = new FakeSocket();
    const core = new GameCore(1, makeConfig());
    core.spawnLine(makeLine('L', 'alpha beta'));
    const net = new NetClient({ socket, core, now: () => 0 });

    socket.receive({ type: 'welcome', playerId: 'me', serverClock: 0, roomState: 'playing', reconnectToken: 'rt' });

    const outcome = net.grab('L:0');
    // Sent to the server with a clientTick.
    expect(socket.sentParsed().at(-1)).toEqual({ type: 'grab', letterId: 'L:0', clientTick: 1 });
    // Predicted locally: outcome granted, lock applied in the prediction core.
    expect(outcome).toEqual({ type: 'grab', letterId: 'L:0', granted: true, ownerId: 'me' });
    expect(core.letters[0]!.ownerId).toBe('me');
    expect(net.pendingCount).toBe(1);
  });

  it('skips prediction on a letter visibly locked by another player but still sends (8.6)', () => {
    const socket = new FakeSocket();
    const core = new GameCore(1, makeConfig());
    core.spawnLine(makeLine('L', 'alpha beta'));
    const net = new NetClient({ socket, core, now: () => 0 });

    socket.receive({ type: 'welcome', playerId: 'me', serverClock: 0, roomState: 'playing', reconnectToken: 'rt' });
    // A snapshot makes L:0 visibly locked by another player.
    socket.receive({ type: 'snapshot', snapshot: snapshotWith(core, { tick: 1, locks: [{ letterId: 'L:0', ownerId: 'other' }] }) });

    const outcome = net.grab('L:0');
    // Sent, but not predicted (no local owner change, no pending entry).
    expect(socket.sentParsed().at(-1)).toMatchObject({ type: 'grab', letterId: 'L:0' });
    expect(outcome).toBeNull();
    expect(net.pendingCount).toBe(0);
  });

  it('snaps a contradicted predicted grab to authoritative state on snapshot (8.7, 16.4)', () => {
    const socket = new FakeSocket();
    const core = new GameCore(1, makeConfig());
    core.spawnLine(makeLine('L', 'alpha beta'));
    const snapped: string[] = [];
    const net = new NetClient({
      socket,
      core,
      now: () => 0,
      callbacks: { onGrabResult: (id, granted) => { if (!granted) snapped.push(id); } },
    });

    socket.receive({ type: 'welcome', playerId: 'me', serverClock: 0, roomState: 'playing', reconnectToken: 'rt' });

    // Predict grabbing L:0 (clientTick 1) — locally we now own it.
    net.grab('L:0');
    expect(core.letters[0]!.ownerId).toBe('me');
    expect(net.pendingCount).toBe(1);

    // Authoritative snapshot at tick 2 contradicts: another player owns L:0.
    socket.receive({
      type: 'snapshot',
      snapshot: snapshotWith(core, { tick: 2, locks: [{ letterId: 'L:0', ownerId: 'other' }] }),
    });

    // The prediction core snapped to authoritative: owner is now `other`.
    expect(core.letters[0]!.ownerId).toBe('other');
    // The contradicted grab was dropped from the pending queue.
    expect(net.pendingCount).toBe(0);
  });

  it('keeps an unacknowledged grab through a snapshot that does not contradict it (16.2, 16.4)', () => {
    const socket = new FakeSocket();
    const core = new GameCore(1, makeConfig());
    core.spawnLine(makeLine('L', 'alpha beta'));
    const net = new NetClient({ socket, core, now: () => 0 });

    socket.receive({ type: 'welcome', playerId: 'me', serverClock: 0, roomState: 'playing', reconnectToken: 'rt' });

    net.grab('L:0'); // clientTick 1
    // Snapshot at tick 0 — older than our grab, no contradicting lock.
    socket.receive({ type: 'snapshot', snapshot: snapshotWith(core, { tick: 0, locks: [] }) });

    // Grab re-applied on top of the snapshot: we still own L:0, still pending.
    expect(core.letters[0]!.ownerId).toBe('me');
    expect(net.pendingCount).toBe(1);
  });

  it('forwards roster and roundState to callbacks', () => {
    const socket = new FakeSocket();
    const core = new GameCore(1, makeConfig());
    let roster: readonly RosterEntry[] = [];
    let state = '';
    const net = new NetClient({
      socket,
      core,
      now: () => 0,
      callbacks: {
        onRoster: (players) => { roster = players; },
        onRoundState: (s) => { state = s; },
      },
    });
    void net;

    socket.receive({
      type: 'roster',
      players: [{ playerId: 'p1', displayName: 'Ada', isHost: true, connected: true }],
    });
    socket.receive({ type: 'roundState', state: 'playing' });

    expect(roster).toEqual([{ playerId: 'p1', displayName: 'Ada', isHost: true, connected: true }]);
    expect(state).toBe('playing');
  });

  it('ignores malformed inbound frames without throwing', () => {
    const socket = new FakeSocket();
    const core = new GameCore(1, makeConfig());
    const net = new NetClient({ socket, core, now: () => 0 });

    expect(() => socket.receive('not json{')).not.toThrow();
    expect(() => socket.receive({ type: 'garbage' })).not.toThrow();
    expect(net.getPlayerId()).toBeNull();
  });

  it('clears pending state on close', () => {
    const socket = new FakeSocket();
    const core = new GameCore(1, makeConfig());
    core.spawnLine(makeLine('L', 'alpha beta'));
    const net = new NetClient({ socket, core, now: () => 0 });
    socket.receive({ type: 'welcome', playerId: 'me', serverClock: 0, roomState: 'playing', reconnectToken: 'rt' });
    net.grab('L:0');
    expect(net.pendingCount).toBe(1);

    net.dispose();
    expect(socket.closed).toBe(true);
    expect(net.pendingCount).toBe(0);
  });
});
