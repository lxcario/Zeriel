/**
 * Audio_Player (Web Audio API) — Client subsystem (Task 7.1).
 *
 * Design references (design.md "Audio_Player"):
 * - An `<audio crossorigin="anonymous">` element feeds a
 *   `MediaElementAudioSourceNode` -> `AnalyserNode` -> destination.
 * - `AnalyserNode.getByteFrequencyData` populates a pre-allocated buffer each
 *   frame; amplitude is the RMS of the time-domain data.
 * - `audio.currentTime` is the playback clock (Requirement 5.5).
 * - A stall watchdog compares `currentTime` progression against wall-clock;
 *   >5s without progress fires a playback failure (Requirement 5.4).
 * - When `corsReliable === false`, the resolved URL is a direct/non-CORS stream
 *   that would taint the media graph and force the AnalyserNode to emit zeros.
 *   In that case we still load and play audio normally but SKIP wiring the
 *   AnalyserNode, and `getAudioFrame()` returns `null` rather than handing
 *   zero-filled buffers to the Renderer (Requirement 5.3). The stall-watchdog
 *   behavior is unchanged in both modes.
 *
 * This module lives in the CLIENT package (not `@glitch/core`) because it
 * touches the Web Audio API and DOM media elements. `core` stays pure.
 *
 * Testability seams (so tasks 7.2 property test and 7.3 integration test are
 * straightforward and need no real timers or real audio decoding):
 * - All web dependencies are injectable: an AudioContext factory, an audio
 *   element factory, a `now()` clock, and an interval scheduler.
 * - The stall logic is a pure function ({@link evaluateStall}) operating on a
 *   plain {@link StallWatchdogState}, exercisable with synthetic time/progress.
 * - RMS and frequency conversion are pure helpers ({@link computeRms},
 *   {@link copyFrequencyBins}) that reuse caller-provided buffers (no per-frame
 *   allocation), per Requirement 14.3.
 */

// ---------------------------------------------------------------------------
// Public data shapes (also referenced by the Renderer — task 9.1).
// ---------------------------------------------------------------------------

/**
 * One frame of reactive audio analysis exposed to the Renderer (Requirement
 * 5.3). `frequencyBins` is normalized to `[0, 1]`. The same `AudioFrame`
 * instance (and the same `frequencyBins` Float32Array) is reused across frames
 * to avoid per-frame allocation (Requirement 14.3).
 */
export interface AudioFrame {
  amplitude: number;
  frequencyBins: Float32Array;
}

/**
 * The Audio_Player contract (design.md). Implemented by {@link WebAudioPlayer}.
 */
export interface AudioPlayer {
  /** Load a resolved stream URL through the Web Audio API (Requirement 5.1). */
  load(streamUrl: string, corsReliable: boolean): Promise<void>;
  /** Begin playback from the start of the track (Requirement 5.2). */
  play(): void;
  /** Current playback time in milliseconds; drives lyric scheduling (5.5). */
  getPlaybackTimeMs(): number;
  /** Fresh amplitude + frequency frame, or `null` when CORS-unreliable (5.3). */
  getAudioFrame(): AudioFrame | null;
  /** Register a playback-failure callback fired on stall > 5000ms (5.4). */
  onStall(cb: (stalledMs: number) => void): void;
  /** Disconnect nodes, close context, remove listeners, stop the watchdog. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Injectable web-dependency shapes (structural subsets of the real DOM types).
// Real `HTMLAudioElement` / `AudioContext` / `AnalyserNode` satisfy these; tests
// supply lightweight fakes implementing the same members.
// ---------------------------------------------------------------------------

/** Minimal event listener accepted by {@link MediaElementLike}. */
export type MediaEventListener = (event?: unknown) => void;

/** Structural subset of `HTMLMediaElement` used by the player. */
export interface MediaElementLike {
  crossOrigin: string | null;
  src: string;
  currentTime: number;
  paused: boolean;
  ended: boolean;
  play(): Promise<void> | void;
  pause(): void;
  load(): void;
  addEventListener(type: string, listener: MediaEventListener): void;
  removeEventListener(type: string, listener: MediaEventListener): void;
}

/** Structural subset of `AnalyserNode`. */
export interface AnalyserLike {
  fftSize: number;
  readonly frequencyBinCount: number;
  getByteFrequencyData(array: Uint8Array): void;
  getByteTimeDomainData(array: Uint8Array): void;
  connect(destination: unknown): void;
  disconnect(): void;
}

/** Structural subset of `MediaElementAudioSourceNode`. */
export interface MediaSourceNodeLike {
  connect(destination: unknown): unknown;
  disconnect(): void;
}

/** Structural subset of `AudioContext`. */
export interface AudioContextLike {
  readonly state: string;
  readonly destination: unknown;
  createMediaElementSource(el: MediaElementLike): MediaSourceNodeLike;
  createAnalyser(): AnalyserLike;
  resume(): Promise<void>;
  close(): Promise<void>;
}

/** Handle returned by the injected interval scheduler. */
export type IntervalHandle = unknown;

/** Configuration for {@link WebAudioPlayer}; every web dependency is injectable. */
export interface WebAudioPlayerConfig {
  /** Factory for the media element. Defaults to a real `new Audio()`. */
  createAudioElement?: () => MediaElementLike;
  /** Factory for the audio context. Defaults to a real `new AudioContext()`. */
  createAudioContext?: () => AudioContextLike;
  /** Monotonic clock in ms. Defaults to `performance.now()` (falls back to Date). */
  now?: () => number;
  /** FFT size for the analyser. Defaults to {@link DEFAULT_FFT_SIZE}. */
  fftSize?: number;
  /** Stall threshold in ms. Defaults to {@link STALL_THRESHOLD_MS} (5000). */
  stallThresholdMs?: number;
  /** Watchdog poll interval in ms. Defaults to {@link DEFAULT_WATCHDOG_INTERVAL_MS}. */
  watchdogIntervalMs?: number;
  /** Interval scheduler. Defaults to the global `setInterval`. */
  scheduleInterval?: (cb: () => void, ms: number) => IntervalHandle;
  /** Interval canceller. Defaults to the global `clearInterval`. */
  cancelInterval?: (handle: IntervalHandle) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default analyser FFT size. Yields `fftSize / 2` frequency bins. */
export const DEFAULT_FFT_SIZE = 2048;

/** Playback is a failure if it stalls for longer than this (Requirement 5.4). */
export const STALL_THRESHOLD_MS = 5000;

/** Default cadence at which the internal watchdog polls progress. */
export const DEFAULT_WATCHDOG_INTERVAL_MS = 250;

// ---------------------------------------------------------------------------
// Pure helpers (no DOM, no allocation per frame) — direct property-test targets.
// ---------------------------------------------------------------------------

/**
 * Root-mean-square amplitude of time-domain samples from
 * `AnalyserNode.getByteTimeDomainData`. Byte samples are centered at 128 and
 * normalized to `[-1, 1]` before the RMS is computed. Returns a value in
 * `[0, 1]`; silence (all 128s) yields 0.
 */
export function computeRms(timeDomain: Uint8Array): number {
  const n = timeDomain.length;
  if (n === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < n; i++) {
    const sample = ((timeDomain[i] ?? 128) - 128) / 128;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / n);
}

/**
 * Copy byte frequency data (`[0, 255]`) into a pre-allocated Float32Array,
 * normalized to `[0, 1]`. Reuses `out` (no allocation) and returns it. Any tail
 * beyond the source length is zeroed so stale data never leaks across frames.
 */
export function copyFrequencyBins(byteFreq: Uint8Array, out: Float32Array): Float32Array {
  const n = Math.min(byteFreq.length, out.length);
  for (let i = 0; i < n; i++) {
    out[i] = (byteFreq[i] ?? 0) / 255;
  }
  for (let i = n; i < out.length; i++) {
    out[i] = 0;
  }
  return out;
}

/**
 * Mutable state for the stall watchdog, kept outside the player so the stall
 * logic is unit-/property-testable in isolation (task 7.2).
 */
export interface StallWatchdogState {
  /** Highest `currentTime` (seconds) observed so far. */
  lastCurrentTime: number;
  /** Wall-clock (ms) at which progress was last observed. */
  lastProgressWallMs: number;
  /** Whether a stall has already been reported for the current stall episode. */
  reported: boolean;
}

/** Create a fresh {@link StallWatchdogState} seeded at `nowMs`. */
export function createWatchdogState(nowMs: number): StallWatchdogState {
  return { lastCurrentTime: 0, lastProgressWallMs: nowMs, reported: false };
}

/**
 * Pure stall evaluation (Requirement 5.4). Given the current playback position
 * and wall-clock, returns the stalled duration (ms) exactly once when playback
 * has failed to advance for longer than `thresholdMs`, otherwise `null`.
 *
 * - When `currentTime` advances, progress is recorded and the episode resets
 *   (so a future stall can fire again), returning `null`.
 * - When `currentTime` is frozen and the elapsed wall-clock exceeds the
 *   threshold, the stalled duration is returned once; subsequent calls within
 *   the same frozen episode return `null` to avoid duplicate failure reports.
 *
 * The function mutates `state` in place; it performs no allocation.
 */
export function evaluateStall(
  state: StallWatchdogState,
  currentTime: number,
  nowMs: number,
  thresholdMs: number,
): number | null {
  if (currentTime > state.lastCurrentTime) {
    state.lastCurrentTime = currentTime;
    state.lastProgressWallMs = nowMs;
    state.reported = false;
    return null;
  }
  const stalledMs = nowMs - state.lastProgressWallMs;
  if (stalledMs > thresholdMs && !state.reported) {
    state.reported = true;
    return stalledMs;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Default web-dependency factories (browser only; isolated at the boundary).
// ---------------------------------------------------------------------------

function defaultNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function defaultCreateAudioElement(): MediaElementLike {
  // `as unknown as` isolates DOM-lib version differences (e.g. typed-array
  // buffer generics) at the single creation boundary.
  return new Audio() as unknown as MediaElementLike;
}

function defaultCreateAudioContext(): AudioContextLike {
  return new AudioContext() as unknown as AudioContextLike;
}

// ---------------------------------------------------------------------------
// WebAudioPlayer
// ---------------------------------------------------------------------------

/**
 * Default Web Audio implementation of {@link AudioPlayer}.
 *
 * Node graph (Requirement 5.1): `<audio crossorigin="anonymous">` ->
 * `MediaElementAudioSourceNode` -> `AnalyserNode` -> `destination`. When
 * `corsReliable === false` the analyser is skipped (the source connects
 * straight to the destination) and {@link getAudioFrame} returns `null`
 * (Requirement 5.3).
 *
 * All buffers ({@link AudioFrame.frequencyBins}, plus the internal byte
 * scratch buffers) are pre-allocated once and reused every frame so
 * {@link getAudioFrame} performs no per-frame allocation (Requirement 14.3).
 */
export class WebAudioPlayer implements AudioPlayer {
  // Injected web dependencies.
  private readonly createAudioElement: () => MediaElementLike;
  private readonly createAudioContext: () => AudioContextLike;
  private readonly now: () => number;
  private readonly fftSize: number;
  private readonly stallThresholdMs: number;
  private readonly watchdogIntervalMs: number;
  private readonly scheduleInterval: (cb: () => void, ms: number) => IntervalHandle;
  private readonly cancelInterval: (handle: IntervalHandle) => void;

  // Live graph (created on load).
  private audioEl: MediaElementLike | null = null;
  private context: AudioContextLike | null = null;
  private sourceNode: MediaSourceNodeLike | null = null;
  private analyser: AnalyserLike | null = null;

  // Reactive analysis state. `null` analysisEnabled => CORS-unreliable mode.
  private analysisEnabled = false;
  private byteFreq: Uint8Array = new Uint8Array(0);
  private byteTime: Uint8Array = new Uint8Array(0);
  private readonly frame: AudioFrame = { amplitude: 0, frequencyBins: new Float32Array(0) };

  // Stall watchdog.
  private watchdog: StallWatchdogState = createWatchdogState(0);
  private watchdogHandle: IntervalHandle | null = null;
  private stallCallbacks: Array<(stalledMs: number) => void> = [];
  /** Whether the watchdog should currently be measuring progress. */
  private playbackActive = false;

  // Bound listeners (kept so they can be removed on dispose).
  private readonly handleError: MediaEventListener;
  private readonly handleStalled: MediaEventListener;

  private disposed = false;

  constructor(config: WebAudioPlayerConfig = {}) {
    this.createAudioElement = config.createAudioElement ?? defaultCreateAudioElement;
    this.createAudioContext = config.createAudioContext ?? defaultCreateAudioContext;
    this.now = config.now ?? defaultNow;
    this.fftSize = config.fftSize ?? DEFAULT_FFT_SIZE;
    this.stallThresholdMs = config.stallThresholdMs ?? STALL_THRESHOLD_MS;
    this.watchdogIntervalMs = config.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;
    this.scheduleInterval =
      config.scheduleInterval ??
      ((cb, ms) => setInterval(cb, ms) as unknown as IntervalHandle);
    this.cancelInterval =
      config.cancelInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));

    // A media 'error' event is a load/playback failure path (Requirement 5.4).
    this.handleError = () => this.reportFailure(this.stallThresholdMs + 1);
    // 'stalled' alone is not yet a failure; the watchdog decides after >5s.
    this.handleStalled = () => {
      /* progress is evaluated by the watchdog tick */
    };
  }

  /**
   * Load a resolved stream URL through the Web Audio API (Requirement 5.1).
   *
   * Resolves once the element reports it can begin playback (`canplay`), or
   * rejects on a media `error` event (a load-failure path per Requirement 5.4).
   * When `corsReliable === false`, the AnalyserNode is intentionally NOT wired,
   * so {@link getAudioFrame} will return `null` (Requirement 5.3).
   */
  async load(streamUrl: string, corsReliable: boolean): Promise<void> {
    this.assertNotDisposed();
    // Tear down any previous graph so load() is idempotent across tracks.
    this.teardownGraph();

    const audioEl = this.createAudioElement();
    audioEl.crossOrigin = 'anonymous';
    this.audioEl = audioEl;

    const context = this.createAudioContext();
    this.context = context;

    const source = context.createMediaElementSource(audioEl);
    this.sourceNode = source;

    if (corsReliable) {
      // Full reactive graph: source -> analyser -> destination.
      const analyser = context.createAnalyser();
      analyser.fftSize = this.fftSize;
      source.connect(analyser);
      analyser.connect(context.destination);
      this.analyser = analyser;
      this.analysisEnabled = true;

      const bins = analyser.frequencyBinCount;
      this.byteFreq = new Uint8Array(bins);
      this.byteTime = new Uint8Array(bins);
      this.frame.frequencyBins = new Float32Array(bins);
      this.frame.amplitude = 0;
    } else {
      // CORS-unreliable: skip the analyser to avoid flatline (zero) data.
      // source -> destination keeps audio audible (Requirement 5.3).
      source.connect(context.destination);
      this.analyser = null;
      this.analysisEnabled = false;
    }

    audioEl.addEventListener('error', this.handleError);
    audioEl.addEventListener('stalled', this.handleStalled);

    await this.waitForLoad(audioEl, streamUrl);
  }

  /** Begin playback from the start of the track (Requirement 5.2). */
  play(): void {
    this.assertNotDisposed();
    const audioEl = this.audioEl;
    if (!audioEl) return;

    // Resume a suspended context (autoplay policies suspend until a gesture).
    if (this.context && this.context.state === 'suspended') {
      void this.context.resume();
    }

    // Start from the very beginning of the track (Requirement 5.2).
    audioEl.currentTime = 0;

    // (Re)seed the watchdog so the freshly started clock is the progress
    // baseline, then begin polling for stalls (Requirement 5.4).
    this.startWatchdog();

    void audioEl.play();
  }

  /** Current playback time in milliseconds (Requirement 5.5). */
  getPlaybackTimeMs(): number {
    return this.audioEl ? this.audioEl.currentTime * 1000 : 0;
  }

  /**
   * Fresh reactive frame, or `null` when analysis is disabled (CORS-unreliable
   * mode, Requirement 5.3). Reuses the same {@link AudioFrame} and its buffers
   * across calls (Requirement 14.3).
   */
  getAudioFrame(): AudioFrame | null {
    if (!this.analysisEnabled || !this.analyser) return null;

    this.analyser.getByteFrequencyData(this.byteFreq);
    this.analyser.getByteTimeDomainData(this.byteTime);

    this.frame.amplitude = computeRms(this.byteTime);
    copyFrequencyBins(this.byteFreq, this.frame.frequencyBins);
    return this.frame;
  }

  /** Register a playback-failure callback (Requirement 5.4). */
  onStall(cb: (stalledMs: number) => void): void {
    this.stallCallbacks.push(cb);
  }

  /** Disconnect nodes, close the context, remove listeners, stop the watchdog. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopWatchdog();
    this.teardownGraph();
    this.stallCallbacks = [];
  }

  // -------------------------------------------------------------------------
  // Stall watchdog (Requirement 5.4) — deterministically testable via the
  // injected `now()` and `scheduleInterval`/`cancelInterval`, and via the pure
  // `evaluateStall` helper / `checkStall` method.
  // -------------------------------------------------------------------------

  /** (Re)start the watchdog, reseeding progress at the current wall-clock. */
  private startWatchdog(): void {
    this.playbackActive = true;
    this.watchdog = createWatchdogState(this.now());
    this.stopWatchdog();
    this.watchdogHandle = this.scheduleInterval(() => {
      this.checkStall(this.now());
    }, this.watchdogIntervalMs);
  }

  /** Stop the watchdog poll (if any). */
  private stopWatchdog(): void {
    if (this.watchdogHandle !== null) {
      this.cancelInterval(this.watchdogHandle);
      this.watchdogHandle = null;
    }
  }

  /**
   * Evaluate the stall watchdog at wall-clock `nowMs`. Exposed (package-internal)
   * so tests can drive ticks deterministically without real timers/audio. Fires
   * the failure callbacks once when playback has not progressed for >5s
   * (Requirement 5.4).
   */
  checkStall(nowMs: number): void {
    if (!this.playbackActive || !this.audioEl) return;
    // A genuinely ended track is not a stall.
    if (this.audioEl.ended) return;
    const stalledMs = evaluateStall(
      this.watchdog,
      this.audioEl.currentTime,
      nowMs,
      this.stallThresholdMs,
    );
    if (stalledMs !== null) {
      this.reportFailure(stalledMs);
    }
  }

  /** Invoke every registered stall/failure callback with `stalledMs`. */
  private reportFailure(stalledMs: number): void {
    this.playbackActive = false;
    for (const cb of this.stallCallbacks) {
      cb(stalledMs);
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Wire up `canplay`/`error` listeners, set the source, and resolve/reject the
   * load. The element's own `error` event is treated as a load failure.
   */
  private waitForLoad(audioEl: MediaElementLike, streamUrl: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onCanPlay: MediaEventListener = () => {
        cleanup();
        resolve();
      };
      const onError: MediaEventListener = () => {
        cleanup();
        reject(new Error('Audio_Player: failed to load stream'));
      };
      const cleanup = () => {
        audioEl.removeEventListener('canplay', onCanPlay);
        audioEl.removeEventListener('error', onError);
      };
      audioEl.addEventListener('canplay', onCanPlay);
      audioEl.addEventListener('error', onError);
      audioEl.src = streamUrl;
      audioEl.load();
    });
  }

  /** Disconnect and drop the live graph; safe to call repeatedly. */
  private teardownGraph(): void {
    if (this.audioEl) {
      this.audioEl.removeEventListener('error', this.handleError);
      this.audioEl.removeEventListener('stalled', this.handleStalled);
      try {
        this.audioEl.pause();
      } catch {
        /* element may already be torn down */
      }
    }
    if (this.analyser) {
      try {
        this.analyser.disconnect();
      } catch {
        /* ignore */
      }
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        /* ignore */
      }
    }
    if (this.context) {
      void this.context.close().catch(() => {
        /* context may already be closed */
      });
    }
    this.audioEl = null;
    this.context = null;
    this.sourceNode = null;
    this.analyser = null;
    this.analysisEnabled = false;
    this.playbackActive = false;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('Audio_Player: used after dispose()');
    }
  }
}
