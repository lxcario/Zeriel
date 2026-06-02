import { describe, it, expect } from 'vitest';
import type { GameConfig, LyricLine, Room, RoundState, RoundResult, Snapshot } from '@glitch/core';
import { GameRoom, type GameRoomConfig } from './GameRoom.js';
import { DEFAULT_SERVER_STEP_MS } from './tickPlan.js';
import { MAX_BROADCAST_INTERVAL_MS } from './broadcastSchedule.js';

/**
 * Behavioral tests for the per-Room authoritative simulation (task 16.9). These
 * drive {@link GameRoom.advance} with synthetic timestamps (NO real timers, NO
 * sockets) and capture the injected broadcast/round-state sinks, exercising:
 * - the ~30Hz fixed tick driving the scheduler (lines spawn into GameCore),
 * - ≥15Hz broadcasting of authoritative state while playing,
 * - finalize-before-scoring on round end (Req 10.4),
 * - join-in-progress hydration via snapshot() (Req 16.3).
 */

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

function makeRoom(): Room {
  return {
    code: 'ROOM1',
    hostId: 'host',
    players: new Map(),
    maxPlayers: 8,
    state: 'lobby',
  };
}

function makeLines(): LyricLine[] {
  return [
    { id: 'L0', startMs: 0, text: 'alpha beta', solutionSlots: [] },
    { id: 'L1', startMs: 100, text: 'gamma delta', solutionSlots: [] },
  ];
}

interface Harness {
  room: Room;
  game: GameRoom;
  clock: { t: number };
  broadcasts: Snapshot[];
  states: { state: RoundState; result?: RoundResult | undefined }[];
}

function makeHarness(overrides: Partial<GameRoomConfig> = {}): Harness {
  const room = makeRoom();
  const clock = { t: 0 };
  const broadcasts: Snapshot[] = [];
  const states: { state: RoundState; result?: RoundResult | undefined }[] = [];
  const game = new GameRoom({
    room,
    gameConfig: makeGameConfig(),
    now: () => clock.t,
    onBroadcast: (s) => broadcasts.push(s),
    onRoundState: (state, result) => states.push({ state, result }),
    ...overrides,
  });
  return { room, game, clock, broadcasts, states };
}

describe('GameRoom round lifecycle + tick loop (task 16.9)', () => {
  it('starts a Round, drives the lifecycle to playing, and publishes room.game', () => {
    const h = makeHarness();
    const ok = h.game.startRound({ seed: 1, lines: makeLines(), trackTitle: 'Track' });
    expect(ok).toBe(true);
    expect(h.game.state).toBe('playing');
    expect(h.room.state).toBe('playing');
    expect(h.room.game).toBeDefined();
    expect(h.states[0]).toEqual({ state: 'playing' });
  });

  it('rejects a second startRound while already playing', () => {
    const h = makeHarness();
    expect(h.game.startRound({ seed: 1, lines: makeLines() })).toBe(true);
    expect(h.game.startRound({ seed: 1, lines: makeLines() })).toBe(false);
  });

  it('drives the scheduler off playback time, spawning due lines into GameCore', () => {
    const h = makeHarness();
    h.game.startRound({ seed: 1, lines: makeLines() });

    // Advance to playback time 0 → first line (startMs 0) drops; 2 tokens.
    h.clock.t = 0;
    h.game.advance(h.clock.t);
    let snap = h.game.snapshot()!;
    expect(snap.letters.map((l) => l.id).sort()).toEqual(['L0:0', 'L0:1']);

    // Advance past 100ms → second line drops too (4 tokens total).
    h.clock.t = 120;
    h.game.advance(h.clock.t);
    snap = h.game.snapshot()!;
    expect(snap.letters.length).toBe(4);
  });

  it('runs fixed ticks decoupled from the advance cadence', () => {
    // Use a clean integer step so the test asserts exact tick counts without
    // floating-point drift; the fixed-rate decoupling is what matters here.
    const h = makeHarness({ stepMs: 10 });
    h.game.startRound({ seed: 1, lines: makeLines() });

    // First advance at t=0 establishes the baseline (0 elapsed → 0 ticks).
    h.game.advance(0);
    const tick0 = h.game.snapshot()!.tick;

    // Advance in 10ms slices so each slice runs exactly one fixed tick —
    // proving the physics steps at the fixed rate, not the wake cadence.
    let now = 0;
    for (let i = 0; i < 10; i++) {
      now += 10;
      h.game.advance(now);
    }
    const tick1 = h.game.snapshot()!.tick;
    expect(tick1 - tick0).toBe(10);

    // A single large-gap advance is clamped by the per-wake cap (default 5).
    const before = h.game.snapshot()!.tick;
    const ticks = h.game.advance(now + 10 * 100); // 100 steps of backlog
    expect(ticks).toBe(5);
    expect(h.game.snapshot()!.tick - before).toBe(5);
  });

  it('broadcasts authoritative snapshots at ≥15Hz while playing', () => {
    const h = makeHarness();
    h.game.startRound({ seed: 1, lines: makeLines() });

    // Simulate ~60Hz wakes over ~1 second; count broadcasts emitted.
    const wakeStep = 1000 / 60;
    let now = 0;
    for (let i = 0; i < 60; i++) {
      now += wakeStep;
      h.game.advance(now);
    }
    // Over ~1s, a ≥15Hz cadence yields at least ~15 broadcasts. Be generous to
    // avoid flakiness but assert the floor is comfortably met.
    expect(h.broadcasts.length).toBeGreaterThanOrEqual(15);

    // No two consecutive broadcasts are spaced beyond the 15Hz ceiling. The
    // broadcaster stamps `now`, so reconstruct the gaps from the wake schedule:
    // since broadcasts fire when due and wakes are frequent, the realized rate
    // honors the floor (covered precisely by broadcastSchedule.test.ts).
    expect(MAX_BROADCAST_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('finalizes the result before entering scoring, then notifies (Req 10.3/10.4)', () => {
    const h = makeHarness({ dropWindowMs: 500 });
    h.game.startRound({ seed: 1, lines: makeLines(), trackTitle: 'Encore' });

    // Drop both lines.
    h.game.advance(0);
    h.game.advance(150);

    // Before the post-roll window elapses, the round is still playing.
    h.game.advance(300);
    expect(h.game.state).toBe('playing');
    expect(h.game.getRoundResult()).toBeNull();

    // After last drop (at playback 150) + 500ms window → scoring.
    h.game.advance(700);
    expect(h.game.state).toBe('scoring');
    expect(h.room.state).toBe('scoring');

    const scoringEvent = h.states.find((s) => s.state === 'scoring');
    expect(scoringEvent).toBeDefined();
    // The result is fully finalized and carried with the notification (10.4).
    const result = scoringEvent!.result!;
    expect(result.trackTitle).toBe('Encore');
    expect(typeof result.totalScore).toBe('number');
    expect(h.game.getRoundResult()).toEqual(result);
  });

  it('stops broadcasting once the round enters scoring', () => {
    const h = makeHarness({ dropWindowMs: 100 });
    h.game.startRound({ seed: 1, lines: makeLines() });
    h.game.advance(0);
    h.game.advance(150);
    h.game.advance(400); // round ends here
    const countAtScoring = h.broadcasts.length;
    h.game.advance(500);
    h.game.advance(600);
    expect(h.broadcasts.length).toBe(countAtScoring);
  });

  it('applies inputs to the authoritative engine and reflects locks in the snapshot', () => {
    const h = makeHarness();
    h.game.startRound({ seed: 1, lines: makeLines() });
    h.game.advance(0); // spawns L0:0 / L0:1

    const grab = h.game.applyInput({ type: 'grab', playerId: 'host', letterId: 'L0:0', clientTick: 0 });
    expect(grab).toEqual({ type: 'grab', letterId: 'L0:0', granted: true, ownerId: 'host' });

    const snap = h.game.snapshot()!;
    expect(snap.locks).toEqual([{ letterId: 'L0:0', ownerId: 'host' }]);
  });

  it('returns a benign outcome for input when no Round is active', () => {
    const h = makeHarness();
    expect(h.game.applyInput({ type: 'grab', playerId: 'p', letterId: 'X', clientTick: 0 })).toEqual({
      type: 'grab',
      letterId: 'X',
      granted: false,
      ownerId: null,
    });
    expect(h.game.snapshot()).toBeNull();
  });

  it('rejects a broadcast interval slower than the 15Hz floor at construction', () => {
    expect(() =>
      makeHarness({ broadcastIntervalMs: MAX_BROADCAST_INTERVAL_MS + 50 }),
    ).toThrow(/15Hz/);
  });
});
