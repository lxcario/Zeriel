// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import {
  WebAudioPlayer,
  computeRms,
  copyFrequencyBins,
  createWatchdogState,
  evaluateStall,
  STALL_THRESHOLD_MS,
  type AudioContextLike,
  type AnalyserLike,
  type MediaElementLike,
  type MediaEventListener,
  type MediaSourceNodeLike,
} from './AudioPlayer.ts';

/**
 * Minimal smoke tests for the Audio_Player (task 7.1) using injected fakes —
 * no real AudioContext, HTMLMediaElement decoding, or wall-clock timers.
 * The optional property test (7.2) and integration test (7.3) are separate.
 */

// ---- Fakes ---------------------------------------------------------------

class FakeMediaElement implements MediaElementLike {
  crossOrigin: string | null = null;
  src = '';
  currentTime = 0;
  paused = true;
  ended = false;
  private listeners = new Map<string, Set<MediaEventListener>>();

  play(): void {
    this.paused = false;
  }
  pause(): void {
    this.paused = true;
  }
  load(): void {
    /* fake: trigger canplay on next microtask so load() resolves */
    queueMicrotask(() => this.emit('canplay'));
  }
  addEventListener(type: string, listener: MediaEventListener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }
  removeEventListener(type: string, listener: MediaEventListener): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string): void {
    for (const l of this.listeners.get(type) ?? []) l();
  }
}

class FakeAnalyser implements AnalyserLike {
  fftSize = 2048;
  get frequencyBinCount(): number {
    return this.fftSize / 2;
  }
  freqValue = 0;
  timeValue = 128;
  getByteFrequencyData(array: Uint8Array): void {
    array.fill(this.freqValue);
  }
  getByteTimeDomainData(array: Uint8Array): void {
    array.fill(this.timeValue);
  }
  connect(): void {}
  disconnect(): void {}
}

class FakeSourceNode implements MediaSourceNodeLike {
  connect(): unknown {
    return undefined;
  }
  disconnect(): void {}
}

class FakeAudioContext implements AudioContextLike {
  state = 'running';
  destination = {};
  analyser = new FakeAnalyser();
  createMediaElementSource(): MediaSourceNodeLike {
    return new FakeSourceNode();
  }
  createAnalyser(): AnalyserLike {
    return this.analyser;
  }
  async resume(): Promise<void> {
    this.state = 'running';
  }
  async close(): Promise<void> {
    this.state = 'closed';
  }
}

function makePlayer(opts?: {
  el?: FakeMediaElement;
  ctx?: FakeAudioContext;
  now?: () => number;
}) {
  const el = opts?.el ?? new FakeMediaElement();
  const ctx = opts?.ctx ?? new FakeAudioContext();
  const player = new WebAudioPlayer({
    createAudioElement: () => el,
    createAudioContext: () => ctx,
    now: opts?.now ?? (() => 0),
    // No-op scheduler: the smoke test drives checkStall() directly.
    scheduleInterval: () => 0,
    cancelInterval: () => {},
  });
  return { player, el, ctx };
}

// ---- Pure helpers --------------------------------------------------------

describe('computeRms', () => {
  it('returns 0 for silence (all samples centered at 128)', () => {
    expect(computeRms(new Uint8Array([128, 128, 128, 128]))).toBe(0);
  });

  it('returns 1 for a full-scale square wave (alternating 0/255-ish)', () => {
    // Samples at the extremes normalize to ~±1 -> RMS ~1.
    const rms = computeRms(new Uint8Array([0, 0, 0, 0]));
    expect(rms).toBeCloseTo(1, 5);
  });

  it('returns 0 for an empty buffer', () => {
    expect(computeRms(new Uint8Array(0))).toBe(0);
  });
});

describe('copyFrequencyBins', () => {
  it('normalizes bytes to [0,1] into a reused buffer and zeroes the tail', () => {
    const out = new Float32Array(4);
    const result = copyFrequencyBins(new Uint8Array([255, 0, 128]), out);
    expect(result).toBe(out); // reused instance, no allocation
    expect(out[0]).toBeCloseTo(1, 5);
    expect(out[1]).toBe(0);
    expect(out[2]).toBeCloseTo(128 / 255, 5);
    expect(out[3]).toBe(0); // tail zeroed
  });
});

describe('evaluateStall (pure)', () => {
  it('returns null while playback progresses', () => {
    const s = createWatchdogState(0);
    expect(evaluateStall(s, 1, 1000, STALL_THRESHOLD_MS)).toBeNull();
    expect(evaluateStall(s, 2, 2000, STALL_THRESHOLD_MS)).toBeNull();
  });

  it('reports the stalled duration once after >5s without progress', () => {
    const s = createWatchdogState(0);
    evaluateStall(s, 1, 1000, STALL_THRESHOLD_MS); // progress baseline at t=1000
    expect(evaluateStall(s, 1, 1000 + 5000, STALL_THRESHOLD_MS)).toBeNull(); // exactly 5000, not >
    const fired = evaluateStall(s, 1, 1000 + 5001, STALL_THRESHOLD_MS);
    expect(fired).toBe(5001);
    // Does not fire again within the same frozen episode.
    expect(evaluateStall(s, 1, 1000 + 9000, STALL_THRESHOLD_MS)).toBeNull();
  });

  it('resets the episode once progress resumes', () => {
    const s = createWatchdogState(0);
    evaluateStall(s, 1, 1000, STALL_THRESHOLD_MS);
    expect(evaluateStall(s, 1, 7000, STALL_THRESHOLD_MS)).toBe(6000); // fired
    expect(evaluateStall(s, 2, 7100, STALL_THRESHOLD_MS)).toBeNull(); // progress resets
    expect(evaluateStall(s, 2, 7100 + 5001, STALL_THRESHOLD_MS)).toBe(5001); // can fire again
  });
});

// ---- WebAudioPlayer ------------------------------------------------------

describe('WebAudioPlayer', () => {
  it('loads with a CORS-reliable stream and exposes a reactive frame', async () => {
    const { player, el, ctx } = makePlayer();
    await player.load('https://proxy.test/audio', true);

    expect(el.crossOrigin).toBe('anonymous');
    expect(el.src).toBe('https://proxy.test/audio');

    ctx.analyser.timeValue = 0; // full-scale -> amplitude ~1
    ctx.analyser.freqValue = 255; // -> bins normalized to 1
    const frame = player.getAudioFrame();
    expect(frame).not.toBeNull();
    expect(frame?.amplitude).toBeCloseTo(1, 5);
    expect(frame?.frequencyBins[0]).toBeCloseTo(1, 5);
    player.dispose();
  });

  it('reuses the same AudioFrame instance across calls (no per-frame allocation)', async () => {
    const { player } = makePlayer();
    await player.load('https://proxy.test/audio', true);
    const a = player.getAudioFrame();
    const b = player.getAudioFrame();
    expect(a).toBe(b);
    expect(a?.frequencyBins).toBe(b?.frequencyBins);
    player.dispose();
  });

  it('returns null frame when CORS is unreliable (analyser skipped)', async () => {
    const { player } = makePlayer();
    await player.load('https://direct.googlevideo.test/audio', false);
    expect(player.getAudioFrame()).toBeNull();
    player.dispose();
  });

  it('plays from the start of the track (Requirement 5.2)', async () => {
    const { player, el } = makePlayer();
    await player.load('https://proxy.test/audio', true);
    el.currentTime = 42;
    player.play();
    expect(el.currentTime).toBe(0);
    expect(el.paused).toBe(false);
    player.dispose();
  });

  it('reports playback time in milliseconds (Requirement 5.5)', async () => {
    const { player, el } = makePlayer();
    await player.load('https://proxy.test/audio', true);
    el.currentTime = 3.5;
    expect(player.getPlaybackTimeMs()).toBe(3500);
    player.dispose();
  });

  it('fires onStall after >5s without progress via checkStall (Requirement 5.4)', async () => {
    let clock = 0;
    const { player, el } = makePlayer({ now: () => clock });
    await player.load('https://proxy.test/audio', true);

    const onStall = vi.fn();
    player.onStall(onStall);

    clock = 0;
    player.play(); // seeds watchdog baseline at t=0, currentTime=0
    el.currentTime = 0; // never advances

    player.checkStall(5000); // exactly 5000ms -> not yet
    expect(onStall).not.toHaveBeenCalled();
    player.checkStall(5001); // >5000ms -> failure
    expect(onStall).toHaveBeenCalledWith(5001);
    expect(onStall).toHaveBeenCalledTimes(1);
    player.dispose();
  });

  it('treats a media error event as a playback failure', async () => {
    const { player, el } = makePlayer();
    await player.load('https://proxy.test/audio', true);
    const onStall = vi.fn();
    player.onStall(onStall);
    el.emit('error');
    expect(onStall).toHaveBeenCalledTimes(1);
    player.dispose();
  });

  it('rejects load when the element emits an error before canplay', async () => {
    const el = new FakeMediaElement();
    // Override load() to emit an error instead of canplay.
    el.load = () => queueMicrotask(() => el.emit('error'));
    const { player } = makePlayer({ el });
    await expect(player.load('https://bad.test/audio', true)).rejects.toThrow(/failed to load/);
    player.dispose();
  });

  it('throws when used after dispose', async () => {
    const { player } = makePlayer();
    await player.load('https://proxy.test/audio', true);
    player.dispose();
    expect(() => player.play()).toThrow(/after dispose/);
  });
});
