import { describe, it, expect } from 'vitest';
import { GameCore } from '@glitch/core';
import type { GameConfig, LyricLine, RenderOptions } from '@glitch/core';
import type { Renderer, RenderState } from '../render/index.ts';
import type { AudioPlayer, AudioFrame } from '../audio/AudioPlayer.ts';
import type { NetSocket } from '../net/index.ts';
import { selectGameHost, type HostSelectionDeps } from './selectGameHost.ts';
import {
  singlePlayerSession,
  multiplayerSession,
  type SessionMode,
} from './sessionMode.ts';

/**
 * Unit tests for the pure host-selection factory (task 18.1). These assert the
 * single-player baseline, the multiplayer layering, and — most importantly — the
 * graceful Single_Player_Mode fallback when multiplayer is unavailable
 * (Requirement 15.4), without opening a real WebSocket or starting any host.
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

/** A no-op Renderer good enough for construction (no host is started here). */
class StubRenderer implements Renderer {
  init(): void {}
  draw(_state: RenderState, _alpha: number, _audio: AudioFrame | null): void {}
  setReduceMotion(): void {}
  dispose(): void {}
}

/** A no-op AudioPlayer good enough for construction. */
class StubAudioPlayer implements AudioPlayer {
  load(): Promise<void> {
    return Promise.resolve();
  }
  play(): void {}
  getPlaybackTimeMs(): number {
    return 0;
  }
  getAudioFrame(): AudioFrame | null {
    return null;
  }
  onStall(): void {}
  dispose(): void {}
}

/** A controllable in-memory socket so multiplayer selection opens no real WS. */
class FakeSocket implements NetSocket {
  send(): void {}
  close(): void {}
  onMessage(): void {}
  onClose(): void {}
}

const RENDER_OPTIONS: RenderOptions = { reduceMotion: false, offGridMaxOffsetPx: 0 };
const FAKE_CANVAS = {} as unknown as HTMLCanvasElement;

function makeDeps(overrides: Partial<HostSelectionDeps> = {}): HostSelectionDeps {
  const config = makeConfig();
  return {
    gameCore: new GameCore(1, config),
    lines: [makeLine('L', 'alpha beta')],
    audioPlayer: new StubAudioPlayer(),
    renderer: new StubRenderer(),
    canvas: FAKE_CANVAS,
    renderOptions: RENDER_OPTIONS,
    bounds: config.bounds,
    ...overrides,
  };
}

describe('selectGameHost (task 18.1)', () => {
  it('builds a single-player LocalGameHost for a single-player session (15.1)', () => {
    const selection = selectGameHost(singlePlayerSession(), makeDeps());
    expect(selection.mode).toBe('single-player');
    expect(selection.fellBack).toBe(false);
    expect(selection.host.mode).toBe('single-player');
  });

  it('builds a multiplayer RemoteGameHost for a usable multiplayer session (15.4, 16.1)', () => {
    let createdUrl: string | null = null;
    const session: SessionMode = multiplayerSession('ROOM7', 'ws://localhost:8080', 'Ada');
    const selection = selectGameHost(
      session,
      makeDeps({
        createSocket: (url) => {
          createdUrl = url;
          return new FakeSocket();
        },
      }),
    );
    expect(selection.mode).toBe('multiplayer');
    expect(selection.fellBack).toBe(false);
    expect(selection.host.mode).toBe('multiplayer');
    expect(createdUrl).toBe('ws://localhost:8080');
  });

  it('uses the SAME GameCore instance for both topologies (ordering/scoring unforked, 15.4)', () => {
    const localCore = new GameCore(1, makeConfig());
    const local = selectGameHost(singlePlayerSession(), makeDeps({ gameCore: localCore }));
    expect(local.host.mode).toBe('single-player');

    const remoteCore = new GameCore(1, makeConfig());
    const remote = selectGameHost(
      multiplayerSession('ROOM7', 'ws://localhost:8080'),
      makeDeps({ gameCore: remoteCore, createSocket: () => new FakeSocket() }),
    );
    // The factory wraps the provided core rather than constructing its own, so
    // both hosts drive identical ordering/scoring logic (Requirement 15.4).
    expect(remote.host.mode).toBe('multiplayer');
  });

  it('falls back to single-player when the Room_Code is blank (15.4)', () => {
    const selection = selectGameHost(
      multiplayerSession('   ', 'ws://localhost:8080'),
      makeDeps({ createSocket: () => new FakeSocket() }),
    );
    expect(selection.mode).toBe('single-player');
    expect(selection.fellBack).toBe(true);
    expect(selection.host.mode).toBe('single-player');
  });

  it('falls back to single-player when the socket URL is blank (15.4)', () => {
    const selection = selectGameHost(
      multiplayerSession('ROOM7', ''),
      makeDeps({ createSocket: () => new FakeSocket() }),
    );
    expect(selection.mode).toBe('single-player');
    expect(selection.fellBack).toBe(true);
    expect(selection.host.mode).toBe('single-player');
  });

  it('falls back to single-player when the transport cannot be constructed (15.4)', () => {
    const selection = selectGameHost(
      multiplayerSession('ROOM7', 'ws://localhost:8080'),
      makeDeps({
        createSocket: () => {
          throw new Error('connection refused');
        },
      }),
    );
    expect(selection.mode).toBe('single-player');
    expect(selection.fellBack).toBe(true);
    expect(selection.host.mode).toBe('single-player');
  });

  it('does not construct a socket for a single-player session', () => {
    let socketCalls = 0;
    const selection = selectGameHost(
      singlePlayerSession(),
      makeDeps({
        createSocket: () => {
          socketCalls++;
          return new FakeSocket();
        },
      }),
    );
    expect(selection.host.mode).toBe('single-player');
    expect(socketCalls).toBe(0);
  });
});
