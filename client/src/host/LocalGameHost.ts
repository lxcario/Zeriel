/**
 * `LocalGameHost` — the in-browser, single-player {@link GameHost} (task 13.1).
 *
 * Design references (design.md "Single-Player vs Multiplayer Topology" and
 * "Fixed-Timestep Loop (decoupled physics)"):
 *
 * > **Single_Player_Mode**: A `LocalGameHost` runs `GameCore` inside the browser
 * > on a `requestAnimationFrame`-driven fixed-timestep accumulator. There is no
 * > network, no clock offset, and no Ownership_Lock contention (the single
 * > Player implicitly owns any letter they grab). The Renderer reads directly
 * > from the local `GameCore`.
 *
 * This host wires together, fully in-browser with NO network (Requirements 15.1,
 * 15.2):
 * - `GameCore` (from `@glitch/core`) — the pure deterministic engine it ticks;
 * - {@link LyricScheduler} (from `@glitch/core`) — drops Lyric_Lines into
 *   `GameCore.spawnLine` off the audio playback clock (Requirement 6.3, 10.2);
 * - {@link RoundLifecycle} (from `@glitch/core`) — drives `playing -> scoring`,
 *   finalizing the Round result before it becomes observable (Requirement 10.4);
 * - the `AudioPlayer` — playback clock + reactive {@link AudioFrame} (Req 5.x);
 * - the `Renderer` — draws each interpolated frame (Requirements 12.x, 14.1).
 *
 * ## Fixed-timestep loop (Requirements 7.2, 14.2, 14.6)
 * Each `requestAnimationFrame` tick, {@link planFixedSteps} converts the
 * wall-clock frame delta into a whole number of fixed `~33.3ms` (30Hz) physics
 * steps plus an interpolation `alpha`. Physics advances ONLY in those fixed
 * increments — decoupled from the display refresh rate — while the Renderer
 * draws at the display rate (target 60fps, Requirement 14.1) and interpolates
 * between the two most recent physics states by `alpha`. The pure stepping math
 * lives in {@link planFixedSteps} so it is unit-testable without
 * `requestAnimationFrame` (this host just runs `plan.steps` ticks).
 *
 * ## Interpolation buffering (Requirement 14.1, 14.3)
 * For smooth rendering the host keeps, per rope-letter, the particle positions
 * from the PREVIOUS physics tick and the CURRENT one, and hands both to the
 * Renderer (which lerps by `alpha`). The position buffers are reused across
 * frames (grown once per letter), so the hot path allocates nothing per frame
 * beyond reusing the `LetterView` list.
 *
 * ## Single-player ownership (Requirement 15.2)
 * {@link applyInput} forwards straight to the in-browser `GameCore`. There is no
 * lock contention: the lone Player implicitly owns any letter they grab, exactly
 * as `GameCore`'s ownership logic already yields for a single player id.
 *
 * ## Testability
 * Every environment dependency is injectable (`now`, `requestFrame`,
 * `cancelFrame`) so a test can drive frames deterministically with synthetic
 * timestamps and no real rAF/clock — mirroring the `AudioPlayer`/`Renderer`
 * injection pattern. The end-to-end single-player test (task 13.2) is separate.
 */

import { LyricScheduler, RoundLifecycle } from '@glitch/core';
import type {
  GameCore,
  LyricLine,
  RoundState,
  RoundResult,
  RopeLetter,
  Rect,
  Vec2,
  PlayerId,
  PlayerInput,
  InputOutcome,
  RenderOptions,
} from '@glitch/core';
import type { Renderer, RenderState, LetterView, SlotView } from '../render/index.ts';
import type { AudioPlayer, AudioFrame } from '../audio/AudioPlayer.ts';
import type { GameHost, GameHostMode } from './GameHost.ts';
import {
  planFixedSteps,
  DEFAULT_STEP_MS,
  DEFAULT_MAX_STEPS_PER_FRAME,
} from './fixedTimestep.ts';

/** Callback invoked by the frame scheduler with the frame timestamp (ms). */
export type FrameCallback = (timestampMs: number) => void;
/** Opaque handle returned by the injected frame scheduler. */
export type FrameHandle = number;

/**
 * Default post-roll window (ms) after the LAST Lyric_Line drops before the Round
 * transitions to scoring. Gives the final letters time to settle into their
 * Solution_Slots before the per-line windows are finalized (Requirement 10.3).
 */
export const DEFAULT_DROP_WINDOW_MS = 2500;

/** Construction config for {@link LocalGameHost}; every web dependency is injectable. */
export interface LocalGameHostConfig {
  /** The pure in-browser engine this host ticks (constructed by the shell). */
  gameCore: GameCore;
  /** Ordered Lyric_Lines for the Round; the host builds its own scheduler. */
  lines: readonly LyricLine[];
  /** The Audio_Player providing the playback clock and reactive frames. */
  audioPlayer: AudioPlayer;
  /** The Renderer drawn each frame. */
  renderer: Renderer;
  /** Canvas the Renderer initializes against. */
  canvas: HTMLCanvasElement;
  /** Render options (reduce-motion, off-grid offset) passed to `renderer.init`. */
  renderOptions: RenderOptions;
  /** Play-area bounds for the {@link RenderState} (same as the GameCore bounds). */
  bounds: Rect;
  /** Optional shared Round state machine; defaults to a fresh `RoundLifecycle`. */
  roundLifecycle?: RoundLifecycle;
  /** Fixed physics step in ms; defaults to {@link DEFAULT_STEP_MS} (~33.3ms / 30Hz). */
  stepMs?: number;
  /** Max fixed steps run per frame (spiral guard); defaults to {@link DEFAULT_MAX_STEPS_PER_FRAME}. */
  maxStepsPerFrame?: number;
  /** Post-roll window before scoring; defaults to {@link DEFAULT_DROP_WINDOW_MS}. */
  dropWindowMs?: number;
  /**
   * Optional override for the round-over test (Requirement 10.3). Defaults to
   * "all lines dropped AND the post-roll {@link dropWindowMs} has elapsed since
   * the last drop". A host wired to a real track can supply an audio-ended test.
   */
  isRoundOver?: (playbackMs: number, scheduler: LyricScheduler) => boolean;
  /** Monotonic clock in ms; defaults to `performance.now()` (falls back to Date). */
  now?: () => number;
  /** Frame scheduler; defaults to `requestAnimationFrame` (timer fallback off-DOM). */
  requestFrame?: (cb: FrameCallback) => FrameHandle;
  /** Frame canceller; defaults to `cancelAnimationFrame` (timer fallback off-DOM). */
  cancelFrame?: (handle: FrameHandle) => void;
}

/** A mutable {@link LetterView} reused across frames (no per-frame allocation). */
interface MutableLetterView {
  id: string;
  glyph: string;
  current: readonly Vec2[];
  previous: readonly Vec2[] | undefined;
  spawnJitterSeed: number;
  ownerId: PlayerId | null;
  placedSlot: number | null;
}

/** Per-letter reusable interpolation buffers + the view handed to the Renderer. */
interface LetterFrameBuffer {
  /** Positions from the current physics tick (reused, grown once). */
  current: Vec2[];
  /** Positions from the previous physics tick (reused, grown once). */
  previous: Vec2[];
  /** Whether {@link previous} has been populated yet (else no interpolation). */
  hasPrevious: boolean;
  /** The reused view object referencing {@link current}/{@link previous}. */
  view: MutableLetterView;
}

function defaultNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function defaultRequestFrame(cb: FrameCallback): FrameHandle {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(cb) as unknown as FrameHandle;
  }
  // Non-DOM fallback (~60fps) so the host is import-safe outside the browser.
  return setTimeout(() => cb(defaultNow()), 16) as unknown as FrameHandle;
}

function defaultCancelFrame(handle: FrameHandle): void {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(handle as number);
    return;
  }
  clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}

export class LocalGameHost implements GameHost {
  readonly mode: GameHostMode = 'single-player';

  private readonly gameCore: GameCore;
  private readonly scheduler: LyricScheduler;
  private readonly lifecycle: RoundLifecycle;
  private readonly audioPlayer: AudioPlayer;
  private readonly renderer: Renderer;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderOptions: RenderOptions;
  private readonly bounds: Rect;

  private readonly stepMs: number;
  private readonly maxStepsPerFrame: number;
  private readonly dropWindowMs: number;
  private readonly isRoundOverFn: (playbackMs: number, scheduler: LyricScheduler) => boolean;

  private readonly requestFrame: (cb: FrameCallback) => FrameHandle;
  private readonly cancelFrame: (handle: FrameHandle) => void;

  /** Ids of every Lyric_Line dropped so far — finalized at scoring (Req 9.4). */
  private readonly droppedLineIds: string[] = [];
  /** Playback time (ms) at which the most recent line dropped. */
  private lastDropMs = 0;
  /**
   * The line id whose words are currently in play. When a new line drops, the
   * previous line is finalized + cleared so the play area shows only the current
   * line (matching the "before the next line drops" rule), and its gray ghost
   * targets are the placement guides for that line.
   */
  private activeLineId: string | null = null;

  /** Per-letter interpolation buffers, keyed by letter id. */
  private readonly buffers = new Map<string, LetterFrameBuffer>();
  /** Reused list of letter views for the current {@link RenderState}. */
  private readonly letterViews: MutableLetterView[] = [];
  /** Reused list of ghost slot views for the active line. */
  private readonly slotViews: SlotView[] = [];
  /** Reused render-state object handed to `renderer.draw` each frame. */
  private readonly renderState: { bounds: Rect; letters: MutableLetterView[]; slots: SlotView[] };

  /** Leftover fixed-timestep accumulator carried between frames (ms). */
  private accumulatorMs = 0;
  /** Interpolation factor for the latest frame (`accumulator / stepMs`). */
  private alpha = 0;
  /** Timestamp of the previous frame (ms), or `null` before the first frame. */
  private lastFrameMs: number | null = null;
  /** Latest reactive frame used in the most recent draw (cached for reads). */
  private lastAudioFrame: AudioFrame | null = null;
  /** Finalized Round result once scoring is entered (Requirement 10.4). */
  private roundResult: RoundResult | null = null;

  private running = false;
  private frameHandle: FrameHandle | null = null;
  private disposed = false;

  constructor(config: LocalGameHostConfig) {
    this.gameCore = config.gameCore;
    this.audioPlayer = config.audioPlayer;
    this.renderer = config.renderer;
    this.canvas = config.canvas;
    this.renderOptions = config.renderOptions;
    this.bounds = config.bounds;
    this.lifecycle = config.roundLifecycle ?? new RoundLifecycle();

    this.stepMs = config.stepMs && config.stepMs > 0 ? config.stepMs : DEFAULT_STEP_MS;
    this.maxStepsPerFrame =
      config.maxStepsPerFrame && config.maxStepsPerFrame > 0
        ? config.maxStepsPerFrame
        : DEFAULT_MAX_STEPS_PER_FRAME;
    this.dropWindowMs =
      config.dropWindowMs !== undefined && config.dropWindowMs >= 0
        ? config.dropWindowMs
        : DEFAULT_DROP_WINDOW_MS;
    this.isRoundOverFn = config.isRoundOver ?? ((ms, sch) => this.defaultIsRoundOver(ms, sch));

    this.requestFrame = config.requestFrame ?? defaultRequestFrame;
    this.cancelFrame = config.cancelFrame ?? defaultCancelFrame;

    // The scheduler feeds dropped lines into GameCore.spawnLine, recording each
    // line id so every open line can be finalized at scoring (Requirement 9.4).
    // When a NEW line drops, the PREVIOUS line is finalized (its score frozen)
    // and cleared from play so only the current line's words + ghost targets are
    // on screen ("...before the next line drops").
    this.scheduler = new LyricScheduler(config.lines, (line) => {
      const prev = this.activeLineId;
      if (prev !== null && prev !== line.id) {
        this.gameCore.finalizeLine(prev);
        this.gameCore.clearLine(prev);
      }
      this.gameCore.spawnLine(line);
      this.droppedLineIds.push(line.id);
      this.activeLineId = line.id;
    });

    this.renderState = { bounds: this.bounds, letters: this.letterViews, slots: this.slotViews };
  }

  // -------------------------------------------------------------------------
  // GameHost lifecycle
  // -------------------------------------------------------------------------

  /**
   * Begin the Round: drive the lifecycle to `playing`, initialize the Renderer,
   * start audio playback from the top, and start the fixed-timestep loop.
   * Idempotent — a second call while running (or after dispose) is a no-op.
   */
  start(): void {
    if (this.running || this.disposed) return;
    this.ensurePlaying();
    this.running = true;
    this.lastFrameMs = null;
    this.renderer.init(this.canvas, this.renderOptions);
    this.audioPlayer.play();
    this.scheduleNextFrame();
  }

  /** Stop the loop and release the audio graph + renderer buffers. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLoop();
    this.audioPlayer.dispose();
    this.renderer.dispose();
  }

  /**
   * Apply one player input to the in-browser `GameCore`. Single-player: the lone
   * Player implicitly owns any letter they grab (Requirement 15.2) — there is no
   * network round-trip or lock contention.
   */
  applyInput(input: PlayerInput): InputOutcome {
    return this.gameCore.applyInput(input);
  }

  getRoundState(): RoundState {
    return this.lifecycle.state;
  }

  getRoundResult(): RoundResult | null {
    return this.roundResult;
  }

  getRenderState(): RenderState {
    return this.buildRenderState();
  }

  getInterpolationAlpha(): number {
    return this.alpha;
  }

  getAudioFrame(): AudioFrame | null {
    return this.lastAudioFrame;
  }

  // -------------------------------------------------------------------------
  // Frame loop
  // -------------------------------------------------------------------------

  /** Schedule the next animation frame, retaining its handle for cancellation. */
  private scheduleNextFrame(): void {
    this.frameHandle = this.requestFrame((ts) => this.frame(ts));
  }

  /**
   * One scheduled frame: compute the wall-clock delta from the previous frame
   * and advance the simulation/render, then queue the next frame while running.
   */
  private frame(timestampMs: number): void {
    if (!this.running) return;
    const last = this.lastFrameMs ?? timestampMs;
    const deltaMs = timestampMs - last;
    this.lastFrameMs = timestampMs;
    this.advance(deltaMs);
    if (this.running) this.scheduleNextFrame();
  }

  /**
   * Advance the simulation by one rendered frame of wall-clock time `frameDeltaMs`
   * and draw it. This is the body of the fixed-timestep loop:
   *
   * 1. Drive lyric scheduling off the audio playback clock (Requirement 6.3).
   * 2. Run a whole number of fixed `stepMs` physics ticks via {@link planFixedSteps}
   *    (decoupled from the frame rate, Requirements 7.2/14.2/14.6), capturing the
   *    previous tick's positions for interpolation.
   * 3. Draw the interpolated frame at the residual `alpha` (Requirement 14.1).
   * 4. Detect round end and finalize-before-notify into scoring (Req 10.3/10.4).
   *
   * Exposed (package-internal) so a test can drive frames with synthetic deltas
   * without a real `requestAnimationFrame`.
   */
  advance(frameDeltaMs: number): void {
    // 1) Lyric scheduling off the playback clock; record the last drop time.
    const playbackMs = this.audioPlayer.getPlaybackTimeMs();
    const droppedBefore = this.scheduler.dropped;
    this.scheduler.update(playbackMs);
    if (this.scheduler.dropped > droppedBefore) this.lastDropMs = playbackMs;

    // 2) Fixed-timestep physics, decoupled from this render frame.
    const plan = planFixedSteps(this.accumulatorMs, frameDeltaMs, this.stepMs, this.maxStepsPerFrame);
    for (let i = 0; i < plan.steps; i++) {
      // Capture positions just before the LAST tick so the Renderer can
      // interpolate between the two most recent physics states (Req 14.1).
      if (i === plan.steps - 1) this.capturePrevious();
      this.gameCore.tick(this.stepMs);
    }
    if (plan.steps > 0) this.captureCurrent();
    this.accumulatorMs = plan.accumulator;
    this.alpha = plan.alpha;

    // 3) Render the interpolated frame; cache the reactive frame for reads.
    this.lastAudioFrame = this.audioPlayer.getAudioFrame();
    this.renderer.draw(this.buildRenderState(), this.alpha, this.lastAudioFrame);

    // 4) Round-end → finalize result BEFORE scoring becomes observable (10.4).
    this.maybeEnterScoring(playbackMs);
  }

  // -------------------------------------------------------------------------
  // Round lifecycle
  // -------------------------------------------------------------------------

  /**
   * Walk the {@link RoundLifecycle} to `playing`. In Single_Player_Mode the shell
   * only starts the host once audio and lyrics are resolved, so the resolved
   * path (`lobby -> resolving -> ready -> playing`) is walked here. If the
   * lifecycle is already `playing` (or past it), this is a no-op.
   */
  private ensurePlaying(): void {
    const lc = this.lifecycle;
    if (lc.state === 'lobby') lc.selectTrack();
    if (lc.state === 'resolving') {
      lc.reportResolution({ audioResolved: true, lyricsResolved: true });
    }
    if (lc.state === 'ready') lc.start();
  }

  /**
   * If the Round is over, finalize every dropped line and produce the Round
   * result BEFORE the `scoring` state becomes observable (Requirement 10.4 — the
   * `RoundLifecycle.enterScoring` contract runs the finalizer first), then stop
   * the loop. The final interpolated frame for this tick has already been drawn.
   */
  private maybeEnterScoring(playbackMs: number): void {
    if (this.lifecycle.state !== 'playing') return;
    if (!this.isRoundOverFn(playbackMs, this.scheduler)) return;

    const scoring = this.lifecycle.enterScoring(() => {
      for (const id of this.droppedLineIds) this.gameCore.finalizeLine(id);
      return this.gameCore.getRoundResult();
    });
    if (scoring.ok) {
      this.roundResult = scoring.result;
      this.stopLoop();
    }
  }

  /**
   * Default round-over test (Requirement 10.3): the last Lyric_Line has dropped
   * AND the post-roll {@link dropWindowMs} has elapsed (in playback time) since
   * that last drop, giving the final letters time to settle.
   */
  private defaultIsRoundOver(playbackMs: number, scheduler: LyricScheduler): boolean {
    if (!scheduler.isComplete()) return false;
    return playbackMs - this.lastDropMs >= this.dropWindowMs;
  }

  /** Stop scheduling frames and cancel any pending one. Safe to call repeatedly. */
  private stopLoop(): void {
    this.running = false;
    if (this.frameHandle !== null) {
      this.cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }
  }

  // -------------------------------------------------------------------------
  // Interpolation buffering + render-state assembly
  // -------------------------------------------------------------------------

  /** Copy every live letter's current particle positions into its `current` buffer. */
  private captureCurrent(): void {
    for (const letter of this.gameCore.letters) {
      this.copyPositions(letter, this.ensureBuffer(letter).current);
    }
  }

  /** Copy every live letter's current particle positions into its `previous` buffer. */
  private capturePrevious(): void {
    for (const letter of this.gameCore.letters) {
      const buf = this.ensureBuffer(letter);
      this.copyPositions(letter, buf.previous);
      buf.hasPrevious = true;
    }
  }

  /**
   * Copy a letter's particle `x` positions into `target`, growing/shrinking the
   * reused array to match the particle count (no allocation in steady state).
   */
  private copyPositions(letter: RopeLetter, target: Vec2[]): void {
    const ps = letter.particles;
    while (target.length < ps.length) target.push({ x: 0, y: 0 });
    if (target.length > ps.length) target.length = ps.length;
    for (let i = 0; i < ps.length; i++) {
      const dst = target[i]!;
      dst.x = ps[i]!.x.x;
      dst.y = ps[i]!.x.y;
    }
  }

  /** Get or lazily create the reusable interpolation buffer for a letter. */
  private ensureBuffer(letter: RopeLetter): LetterFrameBuffer {
    let buf = this.buffers.get(letter.id);
    if (!buf) {
      const current: Vec2[] = [];
      const previous: Vec2[] = [];
      buf = {
        current,
        previous,
        hasPrevious: false,
        view: {
          id: letter.id,
          glyph: letter.glyph,
          current,
          previous: undefined,
          spawnJitterSeed: letter.spawnJitterSeed,
          ownerId: letter.ownerId,
          placedSlot: letter.placedSlot,
        },
      };
      this.buffers.set(letter.id, buf);
    }
    return buf;
  }

  /**
   * Assemble the {@link RenderState} for the current frame from the per-letter
   * interpolation buffers. Reuses the view list and view objects (no per-frame
   * allocation). A letter with no captured `current` yet (no ticks run) is
   * seeded from its live spawn positions and drawn without interpolation.
   */
  private buildRenderState(): RenderState {
    this.letterViews.length = 0;
    for (const letter of this.gameCore.letters) {
      const buf = this.ensureBuffer(letter);
      if (buf.current.length === 0) this.copyPositions(letter, buf.current);
      const view = buf.view;
      view.glyph = letter.glyph;
      view.spawnJitterSeed = letter.spawnJitterSeed;
      view.ownerId = letter.ownerId;
      view.placedSlot = letter.placedSlot;
      view.current = buf.current;
      view.previous = buf.hasPrevious ? buf.previous : undefined;
      this.letterViews.push(view);
    }
    this.buildSlotViews();
    this.renderState.bounds = this.bounds;
    this.renderState.letters = this.letterViews;
    this.renderState.slots = this.slotViews;
    return this.renderState as RenderState;
  }

  /**
   * Rebuild the gray ghost target views for the ACTIVE line: one per
   * Solution_Slot, positioned at the slot and labeled with the word whose
   * `correctIndex` matches that slot. These are placement guides only (no
   * gameplay effect). Reuses {@link slotViews} (no per-frame allocation in
   * steady state). Empty when no line is active or its slots are unknown.
   */
  private buildSlotViews(): void {
    this.slotViews.length = 0;
    const lineId = this.activeLineId;
    if (lineId === null) return;
    const slots = this.gameCore.getSolutionSlots(lineId);
    if (!slots) return;
    // Map correctIndex -> glyph for the active line's letters.
    for (const slot of slots) {
      let glyph = '';
      for (const letter of this.gameCore.letters) {
        if (letter.lineId === lineId && letter.correctIndex === slot.index) {
          glyph = letter.glyph;
          break;
        }
      }
      this.slotViews.push({ position: { x: slot.position.x, y: slot.position.y }, glyph });
    }
  }
}
