import { describe, it, expect } from 'vitest';
import { GameCore } from '@glitch/core';
import type { GameConfig, LyricLine, RoundResult, Snapshot, RenderOptions } from '@glitch/core';
import type { Renderer, RenderState } from '../render/index.ts';
import type { AudioPlayer, AudioFrame } from '../audio/AudioPlayer.ts';
import type { NetSocket } from '../net/index.ts';
import { RemoteGameHost } from './RemoteGameHost.ts';

/**
 * Integration tests for the {@link RemoteGameHost} (task 17.6): a REAL prediction
 * `GameCore` composed behind a `NetClient` over a FAKE socket, with fake
 * Renderer/AudioPlayer and a manually-driven frame loop (no real rAF, audio, or
 * network). These verify the host presents the same {@link GameHost} interface
 * as the local host while driving owned letters from local prediction and
 * non-owned letters from interpolated authoritative snapshots (Reqs 16.1, 16.2).
 */

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
  receive(message: unknown): void {
    const raw = typeof message === 'string' ? message : JSON.stringify(message);
    this.messageHandler?.(raw);
  }
  sentParsed(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

/** A recording Renderer that captures init/draw/dispose calls. */
class FakeRenderer implements Renderer {
  initialized = false;
  disposed = false;
  reduceMotion = false;
  lastState: RenderState | null = null;
  lastAlpha = 0;
  drawCount = 0;

  init(_canvas: HTMLCanvasElement, opts: RenderOptions): void {
    this.initialized = true;
    this.reduceMotion = opts.reduceMotion;
  }
  draw(state: RenderState, alpha: number): void {
    this.lastState = state;
    this.lastAlpha = alpha;
    this.drawCount++;
  }
  setReduceMotion(enabled: boolean): void {
    this.reduceMotion = enabled;
  }
  dispose(): void {
    this.disposed = true;
  }
}

/** A fake AudioPlayer with a controllable playback clock. */
class FakeAudioPlayer implements AudioPlayer {
  played = false;
  disposed = false;
  playbackMs = 0;
  frame: AudioFrame | null = null;

  load(): Promise<void> {
    return Promise.resolve();
  }
  play(): void {
    this.played = true;
  }
  getPlaybackTimeMs(): number {
    return this.playbackMs;
  }
  getAudioFrame(): AudioFrame | null {
    return this.frame;
  }
  onStall(): void {
    /* no-op */
  }
  dispose(): void {
    this.disposed = true;
  }
}

/** A manual frame scheduler so a test can step frames deterministically. */
class FrameDriver {
  private cb: ((ts: number) => void) | null = null;
  private handle = 0;
  readonly requestFrame = (cb: (ts: number) => void): number => {
    this.cb = cb;
    return ++this.handle;
  };
  readonly cancelFrame = (): void => {
    this.cb = null;
  };
  /** Fire the pending frame callback with `ts` (the host reschedules itself). */
  tick(ts: number): void {
    const cb = this.cb;
    this.cb = null;
    cb?.(ts);
  }
}

const RENDER_OPTIONS: RenderOptions = { reduceMotion: false, offGridMaxOffsetPx: 0 };
const FAKE_CANVAS = {} as unknown as HTMLCanvasElement;

interface Harness {
  host: RemoteGameHost;
  socket: FakeSocket;
  renderer: FakeRenderer;
  audio: FakeAudioPlayer;
  driver: FrameDriver;
  core: GameCore;
  setNow: (ms: number) => void;
}

function makeHost(lines: readonly LyricLine[]): Harness {
  const socket = new FakeSocket();
  const renderer = new FakeRenderer();
  const audio = new FakeAudioPlayer();
  const driver = new FrameDriver();
  const core = new GameCore(1, makeConfig());
  let now = 0;
  const host = new RemoteGameHost({
    core,
    lines,
    audioPlayer: audio,
    renderer,
    canvas: FAKE_CANVAS,
    renderOptions: RENDER_OPTIONS,
    bounds: makeConfig().bounds,
    socket,
    roomCode: 'ROOM7',
    displayName: 'Ada',
    now: () => now,
    requestFrame: driver.requestFrame,
    cancelFrame: driver.cancelFrame,
  });
  return { host, socket, renderer, audio, driver, core, setNow: (ms) => { now = ms; } };
}

/** Build a well-formed snapshot the protocol codec will accept. */
function makeSnapshot(
  tick: number,
  letters: Array<{ id: string; positions: Array<[number, number]> }>,
  locks: Array<{ letterId: string; ownerId: string }>,
): Snapshot {
  return {
    tick,
    letters: letters.map((l) => ({
      id: l.id,
      particles: l.positions.map(([x, y]) => ({ x: { x, y }, prev: { x, y } })),
      placedSlot: null,
    })),
    locks,
    cursors: [],
    provisionalScore: 0,
  };
}

describe('RemoteGameHost (task 17.6)', () => {
  it('declares the multiplayer mode and implements the GameHost read surface', () => {
    const { host } = makeHost([makeLine('L', 'alpha beta')]);
    expect(host.mode).toBe('multiplayer');
    expect(host.getRoundState()).toBe('lobby');
    expect(host.getRoundResult()).toBeNull();
    expect(host.getInterpolationAlpha()).toBe(0);
    expect(host.getAudioFrame()).toBeNull();
    expect(host.getRenderState().bounds).toEqual(makeConfig().bounds);
  });

  it('start() initializes the renderer, joins the room, plays audio, and loops', () => {
    const { host, socket, renderer, audio, driver } = makeHost([makeLine('L', 'alpha beta')]);
    host.start();

    expect(renderer.initialized).toBe(true);
    expect(audio.played).toBe(true);
    expect(socket.sentParsed()[0]).toEqual({ type: 'join', roomCode: 'ROOM7', displayName: 'Ada' });

    // The loop is running: driving a frame draws.
    driver.tick(0);
    expect(renderer.drawCount).toBeGreaterThanOrEqual(1);
  });

  it('spawns the round lyric lines into the prediction core off the playback clock', () => {
    const { host, core, driver } = makeHost([makeLine('L', 'alpha beta')]);
    host.start();
    expect(core.letters.length).toBe(0);
    driver.tick(0); // advance once → scheduler.update(playback 0) spawns the line.
    expect(core.letters.map((l) => l.id)).toEqual(['L:0', 'L:1']);
  });

  it('drives NON-OWNED letters from interpolated authoritative snapshots (14.5, 16.2)', () => {
    const { host, socket, driver, setNow } = makeHost([makeLine('L', 'alpha beta')]);
    host.start();
    driver.tick(0); // spawn L:0, L:1 into the prediction core.

    socket.receive({ type: 'welcome', playerId: 'me', serverClock: 0, roomState: 'playing', reconnectToken: 'rt' });

    // Two authoritative snapshots for L:0 (owned by ANOTHER player), 100ms apart.
    setNow(100);
    socket.receive({
      type: 'snapshot',
      snapshot: makeSnapshot(0, [{ id: 'L:0', positions: [[0, 0], [20, 0]] }], [{ letterId: 'L:0', ownerId: 'other' }]),
    });
    setNow(200);
    socket.receive({
      type: 'snapshot',
      snapshot: makeSnapshot(0, [{ id: 'L:0', positions: [[10, 0], [30, 0]] }], [{ letterId: 'L:0', ownerId: 'other' }]),
    });

    // Halfway between the two snapshot arrivals (200 + 50 of a 100ms interval).
    setNow(250);
    const state = host.getRenderState();
    const view = state.letters.find((l) => l.id === 'L:0')!;

    // Non-owned letter: drawn purely from the interpolated snapshots, midway
    // between [0,0]/[20,0] and [10,0]/[30,0] → [5,0]/[25,0]. No physics previous.
    expect(view.ownerId).toBe('other');
    expect(view.previous).toBeUndefined();
    expect(view.current[0]!.x).toBeCloseTo(5, 6);
    expect(view.current[0]!.y).toBeCloseTo(0, 6);
    expect(view.current[1]!.x).toBeCloseTo(25, 6);
    expect(view.current[1]!.y).toBeCloseTo(0, 6);
  });

  it('drives OWNED letters from local prediction with physics interpolation (16.1)', () => {
    const { host, socket, driver, setNow } = makeHost([makeLine('L', 'alpha beta')]);
    host.start();
    driver.tick(0); // spawn L:0, L:1.

    socket.receive({ type: 'welcome', playerId: 'me', serverClock: 0, roomState: 'playing', reconnectToken: 'rt' });

    // Predict-grab L:1 (unlocked) so this Client owns it.
    const outcome = host.applyInput({ type: 'grab', playerId: 'me', letterId: 'L:1', clientTick: 0 });
    expect(outcome).toEqual({ type: 'grab', letterId: 'L:1', granted: true, ownerId: 'me' });

    // A snapshot that does NOT contradict the grab (tick 0 < the grab's tick).
    setNow(100);
    socket.receive({
      type: 'snapshot',
      snapshot: makeSnapshot(0, [{ id: 'L:0', positions: [[0, 0], [20, 0]] }], [{ letterId: 'L:0', ownerId: 'other' }]),
    });

    // Run a frame with enough delta for several physics ticks (so previous is captured).
    driver.tick(100);

    setNow(120);
    const state = host.getRenderState();
    const owned = state.letters.find((l) => l.id === 'L:1')!;
    const nonOwned = state.letters.find((l) => l.id === 'L:0')!;

    // Owned: predicted physics with interpolation buffers (previous populated).
    expect(owned.ownerId).toBe('me');
    expect(owned.previous).toBeDefined();
    // Non-owned: snapshot-driven, no physics previous.
    expect(nonOwned.ownerId).toBe('other');
    expect(nonOwned.previous).toBeUndefined();
  });

  it('forwards cursor / grab / release inputs through the net client', () => {
    const { host, socket, driver } = makeHost([makeLine('L', 'alpha beta')]);
    host.start();
    driver.tick(0);
    socket.receive({ type: 'welcome', playerId: 'me', serverClock: 0, roomState: 'playing', reconnectToken: 'rt' });

    host.applyInput({ type: 'cursor', playerId: 'me', x: 12, y: 34 });
    host.applyInput({ type: 'grab', playerId: 'me', letterId: 'L:0', clientTick: 0 });
    host.applyInput({ type: 'release', playerId: 'me', letterId: 'L:0' });

    const sent = socket.sentParsed();
    expect(sent).toContainEqual({ type: 'cursor', x: 12, y: 34 });
    expect(sent).toContainEqual({ type: 'grab', letterId: 'L:0', clientTick: 2 });
    expect(sent).toContainEqual({ type: 'release', letterId: 'L:0' });
  });

  it('exposes the finalized round result and state once the server reports scoring (10.4)', () => {
    const { host, socket } = makeHost([makeLine('L', 'alpha beta')]);
    host.start();
    socket.receive({ type: 'welcome', playerId: 'me', serverClock: 0, roomState: 'playing', reconnectToken: 'rt' });

    const result: RoundResult = { trackTitle: 'Song', totalScore: 3, contributions: { me: 2, other: 1 } };
    socket.receive({ type: 'roundState', state: 'scoring', result });

    expect(host.getRoundState()).toBe('scoring');
    expect(host.getRoundResult()).toEqual(result);
  });

  it('dispose() closes the connection, audio, and renderer and stops the loop', () => {
    const { host, socket, renderer, audio, driver } = makeHost([makeLine('L', 'alpha beta')]);
    host.start();
    host.dispose();

    expect(socket.closed).toBe(true);
    expect(audio.disposed).toBe(true);
    expect(renderer.disposed).toBe(true);

    // The loop is stopped: a stray frame callback would not be present, and a
    // second dispose is a safe no-op.
    expect(() => driver.tick(50)).not.toThrow();
    expect(() => host.dispose()).not.toThrow();
  });

  it('forwards observer callbacks (roster, snapshot) to the caller', () => {
    const socket = new FakeSocket();
    const renderer = new FakeRenderer();
    const audio = new FakeAudioPlayer();
    const driver = new FrameDriver();
    const core = new GameCore(1, makeConfig());
    let rosterCount = 0;
    let snapshotCount = 0;
    const host = new RemoteGameHost({
      core,
      lines: [makeLine('L', 'alpha beta')],
      audioPlayer: audio,
      renderer,
      canvas: FAKE_CANVAS,
      renderOptions: RENDER_OPTIONS,
      bounds: makeConfig().bounds,
      socket,
      roomCode: 'ROOM7',
      now: () => 0,
      requestFrame: driver.requestFrame,
      cancelFrame: driver.cancelFrame,
      callbacks: {
        onRoster: () => { rosterCount++; },
        onSnapshot: () => { snapshotCount++; },
      },
    });
    host.start();
    driver.tick(0);
    socket.receive({ type: 'welcome', playerId: 'me', serverClock: 0, roomState: 'playing', reconnectToken: 'rt' });
    socket.receive({ type: 'roster', players: [{ playerId: 'me', displayName: 'Ada', isHost: true, connected: true }] });
    socket.receive({ type: 'snapshot', snapshot: makeSnapshot(0, [{ id: 'L:0', positions: [[1, 1], [2, 2]] }], []) });

    expect(rosterCount).toBe(1);
    expect(snapshotCount).toBe(1);
    void host;
  });
});
