/**
 * `RemoteGameHost` — the WebSocket-backed, multiplayer {@link GameHost} (task 17.6).
 *
 * Design references (design.md "Single-Player vs Multiplayer Topology" and
 * "Networking and Synchronization"):
 *
 * > **Multiplayer**: A `RemoteGameHost` connects over WebSocket. The
 * > authoritative `GameCore` runs on the server; the client keeps a prediction
 * > copy of `GameCore` for owned letters and reconciles from snapshots. Presence,
 * > Cursor sharing, and Ownership_Locks are layered on top without altering
 * > ordering/scoring.
 *
 * > Letters the Client does not own are driven purely by interpolated
 * > authoritative updates (Requirement 14.5).
 *
 * This host presents the EXACT same {@link GameHost} surface as
 * {@link LocalGameHost} — `mode`/`start`/`dispose`/`applyInput`/`getRoundState`/
 * `getRoundResult`/`getRenderState`/`getInterpolationAlpha`/`getAudioFrame` — so
 * the UI shell can switch hosts transparently (task 18.1) and the Renderer reads
 * frame data without knowing which host is active. Its {@link mode} is
 * `'multiplayer'`.
 *
 * ## It WRAPS the {@link NetClient} (task 17.3) — it does not reimplement it
 * All protocol (de)serialization, the client-side prediction DECISION, snapshot
 * reconciliation into the prediction `GameCore`, and clock-offset estimation
 * already live in {@link NetClient}. This host owns ONLY the things a
 * `GameHost` adds on top: the per-frame loop, lyric spawning into the prediction
 * core, the owned-vs-non-owned render split, audio, and the Renderer.
 * {@link applyInput} forwards straight to the Net Client (`sendCursor`/`grab`/
 * `release`), so prediction and reconciliation stay where they belong.
 *
 * ## Injectable transport (no live socket in the testable core)
 * The host takes a {@link NetSocket} (the same DI seam the Net Client uses), NOT
 * a `WebSocket`. In production the shell passes `createWebSocketNetSocket(url)`
 * (a thin browser-`WebSocket` adapter, see `./WebSocketNetSocket.ts`); a test
 * passes a fake in-memory socket and drives synthetic frames. Combined with the
 * injectable `now`/`requestFrame`/`cancelFrame` (mirroring {@link LocalGameHost}),
 * the entire host runs deterministically off-DOM with no real `WebSocket`/rAF.
 *
 * ## Owned vs non-owned letters (the heart of task 17.6)
 * The server is authoritative, but the client must feel instant for the letters
 * it is dragging. The host therefore renders each letter from one of TWO
 * sources, decided per frame by `ownerId === myPlayerId` in the prediction core:
 *
 * - **OWNED letters** follow the PREDICTION `GameCore`. The host advances the
 *   prediction core on the SAME fixed-timestep accumulator as
 *   {@link LocalGameHost} ({@link planFixedSteps}); the Net Client steers the
 *   held letter toward the owner's cursor each tick and reconciles it on every
 *   snapshot (Requirements 8.5, 14.4, 16.2). These letters are interpolated
 *   between the two most recent PREDICTION ticks by {@link getInterpolationAlpha}
 *   — identical to the local host (a `previous` buffer is supplied to the view).
 * - **NON-OWNED letters** are driven PURELY by interpolated AUTHORITATIVE
 *   snapshots (Requirement 14.5). The host keeps the two most recent snapshots
 *   with their arrival timestamps and, each frame, bakes a position by
 *   interpolating between them by snapshot-arrival time (a one-interval render
 *   delay for smoothness, via the pure {@link snapshotInterpolationAlpha} /
 *   {@link interpolateLetterParticles}). The baked position is handed to the
 *   Renderer with NO `previous`, so the prediction-loop `alpha` cannot perturb
 *   it — the two interpolation clocks (prediction tick vs snapshot arrival)
 *   never cross-talk.
 *
 * Because the prediction core's non-owned positions are reconciled to authority
 * on every snapshot anyway, ignoring them for rendering (and using the snapshot
 * interpolation instead) is what realizes "non-owned letters follow the
 * authoritative state" smoothly between snapshots.
 *
 * ## Round lifecycle is the SERVER's (not a local RoundLifecycle)
 * Unlike {@link LocalGameHost}, the multiplayer Round lifecycle is owned by the
 * Game_Server and pushed via `roundState` messages. {@link getRoundState}
 * reflects the Net Client's last-observed server state and {@link getRoundResult}
 * returns the finalized result the server sends on `scoring` (Requirement 10.4).
 * The host never finalizes scores itself.
 *
 * ## Why the prediction core still spawns lines
 * A `Snapshot` carries only `id`/particles/`placedSlot` — not `glyph`,
 * `correctIndex`, or `spawnJitterSeed` — so `applySnapshot` can only UPDATE
 * letters that already exist locally (it skips unknown ids by design). The
 * prediction core therefore spawns the same Lyric_Lines off the audio playback
 * clock (exactly as {@link LocalGameHost}), giving every letter its static
 * fields and the deterministic id `${lineId}:${index}` the server shares — so
 * ids line up for reconciliation. Authoritative snapshots then keep positions
 * and locks in sync.
 */

import { LyricScheduler } from '@glitch/core';
import type {
  GameCore,
  LyricLine,
  RoundState,
  RoundResult,
  Rect,
  Vec2,
  PlayerId,
  PlayerInput,
  InputOutcome,
  RenderOptions,
  Snapshot,
  LetterSnapshot,
} from '@glitch/core';
import type { Renderer, RenderState, SlotView } from '../render/index.ts';
import type { AudioPlayer, AudioFrame } from '../audio/AudioPlayer.ts';
import { NetClient, type NetSocket, type NetClientCallbacks } from '../net/index.ts';
import type { GameHost, GameHostMode } from './GameHost.ts';
import type { FrameCallback, FrameHandle } from './LocalGameHost.ts';
import {
  planFixedSteps,
  DEFAULT_STEP_MS,
  DEFAULT_MAX_STEPS_PER_FRAME,
} from './fixedTimestep.ts';
import {
  snapshotInterpolationAlpha,
  interpolateLetterParticles,
} from './snapshotInterpolation.ts';

/** Construction config for {@link RemoteGameHost}; every web/transport dependency is injectable. */
export interface RemoteGameHostConfig {
  /**
   * The prediction `GameCore` the Net Client predicts into and reconciles. The
   * concrete class instance type (not the bare contract) so the host can read
   * its live `letters` for the render split.
   */
  core: GameCore;
  /**
   * The injected transport: `new WebSocketNetSocket(url)` in production, a fake
   * in tests. The host wraps it in a {@link NetClient}.
   */
  socket: NetSocket;
  /** Ordered Lyric_Lines spawned into the prediction core off the audio clock. */
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
  /** Room_Code to join on {@link start} (Requirements 1.3, 2.1). */
  roomCode: string;
  /** Optional display name sent with the join (a default is assigned server-side). */
  displayName?: string;
  /** Fixed physics step in ms; defaults to {@link DEFAULT_STEP_MS} (~33.3ms / 30Hz). */
  stepMs?: number;
  /** Max prediction steps run per frame (spiral guard); defaults to {@link DEFAULT_MAX_STEPS_PER_FRAME}. */
  maxStepsPerFrame?: number;
  /** Optional passthrough Net Client observers (roster/welcome/grabResult, etc.). */
  callbacks?: NetClientCallbacks;
  /** Monotonic clock in ms; defaults to `performance.now()` (Date fallback). */
  now?: () => number;
  /** Frame scheduler; defaults to `requestAnimationFrame` (timer fallback off-DOM). */
  requestFrame?: (cb: FrameCallback) => FrameHandle;
  /** Frame canceller; defaults to `cancelAnimationFrame` (timer fallback off-DOM). */
  cancelFrame?: (handle: FrameHandle) => void;
}

/** A mutable letter view reused across frames (no per-frame allocation). */
interface MutableLetterView {
  id: string;
  glyph: string;
  current: readonly Vec2[];
  previous: readonly Vec2[] | undefined;
  spawnJitterSeed: number;
  ownerId: PlayerId | null;
  placedSlot: number | null;
}

/**
 * Per-letter reusable buffers + the view handed to the Renderer.
 *
 * - {@link current}/{@link previous} hold the prediction core's two most recent
 *   tick positions (the OWNED-letter interpolation path, by the loop `alpha`).
 * - {@link baked} holds the position interpolated between the two most recent
 *   AUTHORITATIVE snapshots (the NON-OWNED path, by snapshot arrival time).
 */
interface LetterFrameBuffer {
  /** Prediction positions from the current tick (reused, grown once). */
  current: Vec2[];
  /** Prediction positions from the previous tick (reused, grown once). */
  previous: Vec2[];
  /** Whether {@link previous} has been populated yet (else no interpolation). */
  hasPrevious: boolean;
  /** Baked interpolated-snapshot positions for the non-owned path (reused). */
  baked: Vec2[];
  /** The reused view object referencing the active position buffer. */
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

export class RemoteGameHost implements GameHost {
  readonly mode: GameHostMode = 'multiplayer';

  private readonly gameCore: GameCore;
  private readonly net: NetClient;
  private readonly scheduler: LyricScheduler;
  private readonly audioPlayer: AudioPlayer;
  private readonly renderer: Renderer;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderOptions: RenderOptions;
  private readonly bounds: Rect;
  private readonly roomCode: string;
  private readonly displayName: string | undefined;

  private readonly stepMs: number;
  private readonly maxStepsPerFrame: number;
  private readonly passthrough: NetClientCallbacks;

  private readonly now: () => number;
  private readonly requestFrame: (cb: FrameCallback) => FrameHandle;
  private readonly cancelFrame: (handle: FrameHandle) => void;

  /** Per-letter interpolation/bake buffers, keyed by letter id. */
  private readonly buffers = new Map<string, LetterFrameBuffer>();
  /** Reused list of letter views for the current {@link RenderState}. */
  private readonly letterViews: MutableLetterView[] = [];
  /** Reused render-state object handed to `renderer.draw` each frame. */
  private readonly renderState: { bounds: Rect; letters: MutableLetterView[]; slots: SlotView[] };
  /** Reused list of ghost slot views for the active line. */
  private readonly slotViews: SlotView[] = [];
  /** The line id whose words are currently in play (drives ghost targets). */
  private activeLineId: string | null = null;

  // --- Authoritative snapshot interpolation state (non-owned letters) ---
  // Only the two most recent snapshots' arrival times and per-id letter lookups
  // are retained — that is all the non-owned interpolation needs. The snapshot
  // objects themselves are already reconciled into the prediction core by the
  // Net Client, so they are not held here.
  /** Wall-clock (ms) at which the PREVIOUS (older) snapshot arrived. */
  private prevSnapMs = 0;
  /** Wall-clock (ms) at which the CURRENT (newer) snapshot arrived. */
  private currSnapMs = 0;
  /** `id → LetterSnapshot` lookup for the previous snapshot (rebuilt on arrival). */
  private prevById = new Map<string, LetterSnapshot>();
  /** `id → LetterSnapshot` lookup for the current snapshot (rebuilt on arrival). */
  private currById = new Map<string, LetterSnapshot>();

  /** Leftover fixed-timestep accumulator carried between frames (ms). */
  private accumulatorMs = 0;
  /** Interpolation factor for the latest frame (`accumulator / stepMs`). */
  private alpha = 0;
  /** Timestamp of the previous frame (ms), or `null` before the first frame. */
  private lastFrameMs: number | null = null;
  /** Latest reactive frame used in the most recent draw (cached for reads). */
  private lastAudioFrame: AudioFrame | null = null;
  /** Finalized Round result once the server reports scoring (Requirement 10.4). */
  private roundResult: RoundResult | null = null;

  private running = false;
  private frameHandle: FrameHandle | null = null;
  private disposed = false;

  constructor(config: RemoteGameHostConfig) {
    this.gameCore = config.core;
    this.audioPlayer = config.audioPlayer;
    this.renderer = config.renderer;
    this.canvas = config.canvas;
    this.renderOptions = config.renderOptions;
    this.bounds = config.bounds;
    this.roomCode = config.roomCode;
    this.displayName = config.displayName;

    this.stepMs = config.stepMs && config.stepMs > 0 ? config.stepMs : DEFAULT_STEP_MS;
    this.maxStepsPerFrame =
      config.maxStepsPerFrame && config.maxStepsPerFrame > 0
        ? config.maxStepsPerFrame
        : DEFAULT_MAX_STEPS_PER_FRAME;
    this.passthrough = config.callbacks ?? {};

    this.now = config.now ?? defaultNow;
    this.requestFrame = config.requestFrame ?? defaultRequestFrame;
    this.cancelFrame = config.cancelFrame ?? defaultCancelFrame;

    // Wrap the Net Client around the prediction core + injected transport. The
    // host's own callbacks capture snapshots (for non-owned interpolation) and
    // the finalized Round result, then delegate to any passthrough observer.
    this.net = new NetClient({
      socket: config.socket,
      core: config.core,
      now: this.now,
      callbacks: this.buildNetCallbacks(),
    });

    // Spawn lines into the prediction core off the playback clock, exactly as
    // the local host — so every letter exists locally for snapshots to reconcile.
    // Clear the previous line when a new one drops so the play area shows only
    // the current line + its ghost targets (matches the authoritative server).
    this.scheduler = new LyricScheduler(config.lines, (line) => {
      const prev = this.activeLineId;
      if (prev !== null && prev !== line.id) {
        this.gameCore.clearLine(prev);
      }
      this.gameCore.spawnLine(line);
      this.activeLineId = line.id;
    });

    this.renderState = { bounds: this.bounds, letters: this.letterViews, slots: this.slotViews };
  }

  // -------------------------------------------------------------------------
  // GameHost lifecycle
  // -------------------------------------------------------------------------

  /**
   * Begin the Round: initialize the Renderer, start audio playback, send the
   * `join` (which also kicks off the clock-offset handshake), and start the
   * fixed-timestep loop. Idempotent — a second call while running (or after
   * dispose) is a no-op. The authoritative Round lifecycle is driven by the
   * server; this host only renders what it reconciles.
   */
  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastFrameMs = null;
    this.renderer.init(this.canvas, this.renderOptions);
    this.audioPlayer.play();
    // Join the Room (buffered by the WebSocket adapter until the socket opens).
    this.net.join(this.roomCode, this.displayName);
    this.scheduleNextFrame();
  }

  /** Stop the loop, close the connection, and release the audio graph + renderer. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLoop();
    this.net.dispose();
    this.audioPlayer.dispose();
    this.renderer.dispose();
  }

  /**
   * Apply one player input by forwarding it to the {@link NetClient} (the server
   * is authoritative). Cursor and release are applied optimistically to the
   * prediction core and sent; a grab is sent and, when the target is not visibly
   * locked by another Player, predicted locally (Requirements 8.5, 8.6). The
   * returned {@link InputOutcome} is the LOCAL/predicted view:
   *
   * - `cursor` → always accepted (the cursor stream is fire-and-forget).
   * - `grab` → the prediction outcome when predicted; otherwise a denied outcome
   *   (prediction was skipped because the letter is visibly locked) — the
   *   authoritative `grabResult`/`snapshot` then confirms the true owner.
   * - `release` → reported released (the prediction core clears the local lock).
   *
   * `input.playerId` is ignored: the Net Client attributes inputs to the
   * server-assigned identity, not a client-supplied id.
   */
  applyInput(input: PlayerInput): InputOutcome {
    switch (input.type) {
      case 'cursor':
        this.net.sendCursor(input.x, input.y);
        return { type: 'cursor', accepted: true };
      case 'grab': {
        const outcome = this.net.grab(input.letterId);
        return outcome ?? { type: 'grab', letterId: input.letterId, granted: false, ownerId: null };
      }
      case 'release':
        this.net.release(input.letterId);
        return { type: 'release', letterId: input.letterId, released: true };
    }
  }

  /** The last Round lifecycle state observed from the server (Requirements 10.1–10.4). */
  getRoundState(): RoundState {
    return this.net.getRoundState();
  }

  /**
   * The finalized {@link RoundResult} the server sent on entering `scoring`
   * (Requirement 10.4), or `null` while the Round is still in progress.
   */
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

  /** The Net Client's assigned Player_Id once `welcome` has arrived, else `null`. */
  getPlayerId(): PlayerId | null {
    return this.net.getPlayerId();
  }

  // -------------------------------------------------------------------------
  // Net Client callbacks
  // -------------------------------------------------------------------------

  /**
   * Build the {@link NetClientCallbacks} the host registers on the Net Client.
   * The host intercepts `snapshot` (to retain the two most recent authoritative
   * snapshots for non-owned interpolation) and `roundState` (to capture the
   * finalized result), then delegates to any caller-supplied passthrough so the
   * shell can still observe roster/welcome/grab results.
   */
  private buildNetCallbacks(): NetClientCallbacks {
    return {
      onWelcome: (playerId, roomState) => this.passthrough.onWelcome?.(playerId, roomState),
      onRoster: (players) => this.passthrough.onRoster?.(players),
      onGrabResult: (letterId, granted, ownerId) =>
        this.passthrough.onGrabResult?.(letterId, granted, ownerId),
      onSnapshot: (snapshot) => {
        this.ingestSnapshot(snapshot);
        this.passthrough.onSnapshot?.(snapshot);
      },
      onRoundState: (state, result) => {
        // The server finalizes the result before the `scoring` transition; the
        // payload carries it (Requirement 10.4). Retain the latest non-null one.
        if (result !== null) this.roundResult = result;
        this.passthrough.onRoundState?.(state, result);
      },
    };
  }

  /**
   * Retain an authoritative snapshot for non-owned-letter interpolation. The Net
   * Client has ALREADY reconciled it into the prediction core by the time this
   * fires; here we only buffer the two most recent snapshots and their arrival
   * times so {@link bakeNonOwned} can interpolate positions between them by
   * arrival time (Requirements 14.5, 16.2). Per-id lookups are rebuilt now so
   * the hot render path does no map construction.
   */
  private ingestSnapshot(snapshot: Snapshot): void {
    this.prevSnapMs = this.currSnapMs;
    this.prevById = this.currById;

    this.currSnapMs = this.now();
    this.currById = new Map<string, LetterSnapshot>();
    for (const ls of snapshot.letters) this.currById.set(ls.id, ls);
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
   * and advance the prediction/render, then queue the next frame while running.
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
   * Advance the prediction simulation by one rendered frame of wall-clock time
   * `frameDeltaMs` and draw it:
   *
   * 1. Drive lyric scheduling off the audio playback clock so the prediction
   *    core has the line's letters to reconcile (Requirement 6.3).
   * 2. Run a whole number of fixed `stepMs` PREDICTION ticks via
   *    {@link planFixedSteps}, capturing the previous tick's positions so OWNED
   *    letters interpolate smoothly (Requirements 7.2, 14.2, 14.4). The Net
   *    Client steers held letters toward the owner's cursor inside `tick`.
   * 3. Draw the frame: owned letters interpolated by `alpha`, non-owned letters
   *    interpolated between authoritative snapshots (Requirements 14.1, 14.5).
   *
   * Exposed (package-internal) so a test can drive frames with synthetic deltas
   * and synthetic snapshots without a real `requestAnimationFrame` or socket.
   */
  advance(frameDeltaMs: number): void {
    // 1) Lyric scheduling off the playback clock (spawns into the prediction core).
    const playbackMs = this.audioPlayer.getPlaybackTimeMs();
    this.scheduler.update(playbackMs);

    // 2) Fixed-timestep prediction, decoupled from this render frame.
    const plan = planFixedSteps(this.accumulatorMs, frameDeltaMs, this.stepMs, this.maxStepsPerFrame);
    for (let i = 0; i < plan.steps; i++) {
      if (i === plan.steps - 1) this.capturePrevious();
      this.gameCore.tick(this.stepMs);
    }
    if (plan.steps > 0) this.captureCurrent();
    this.accumulatorMs = plan.accumulator;
    this.alpha = plan.alpha;

    // 3) Render the interpolated frame; cache the reactive frame for reads.
    this.lastAudioFrame = this.audioPlayer.getAudioFrame();
    this.renderer.draw(this.buildRenderState(), this.alpha, this.lastAudioFrame);
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
  // Prediction interpolation buffering (OWNED letters)
  // -------------------------------------------------------------------------

  /** Copy every live letter's current prediction positions into its `current` buffer. */
  private captureCurrent(): void {
    for (const letter of this.gameCore.letters) {
      this.copyParticlePositions(letter.particles, this.ensureBuffer(letter.id).current);
    }
  }

  /** Copy every live letter's current prediction positions into its `previous` buffer. */
  private capturePrevious(): void {
    for (const letter of this.gameCore.letters) {
      const buf = this.ensureBuffer(letter.id);
      this.copyParticlePositions(letter.particles, buf.previous);
      buf.hasPrevious = true;
    }
  }

  /**
   * Copy particle `x` positions into `target`, growing/shrinking the reused
   * array to match the count (no allocation in steady state).
   */
  private copyParticlePositions(particles: ReadonlyArray<{ x: Vec2 }>, target: Vec2[]): void {
    while (target.length < particles.length) target.push({ x: 0, y: 0 });
    if (target.length > particles.length) target.length = particles.length;
    for (let i = 0; i < particles.length; i++) {
      const dst = target[i]!;
      dst.x = particles[i]!.x.x;
      dst.y = particles[i]!.x.y;
    }
  }

  /** Get or lazily create the reusable buffer for a letter id. */
  private ensureBuffer(id: string): LetterFrameBuffer {
    let buf = this.buffers.get(id);
    if (!buf) {
      const current: Vec2[] = [];
      buf = {
        current,
        previous: [],
        hasPrevious: false,
        baked: [],
        view: {
          id,
          glyph: '',
          current,
          previous: undefined,
          spawnJitterSeed: 0,
          ownerId: null,
          placedSlot: null,
        },
      };
      this.buffers.set(id, buf);
    }
    return buf;
  }

  // -------------------------------------------------------------------------
  // Non-owned snapshot interpolation
  // -------------------------------------------------------------------------

  /**
   * Bake a non-owned letter's render positions into its reused `baked` buffer by
   * interpolating between the two most recent authoritative snapshots by the
   * pure {@link snapshotInterpolationAlpha} factor `s` (Requirement 14.5). The
   * pure {@link interpolateLetterParticles} handles the partial cases (curr-only
   * for a freshly-appeared letter, prev-only for a just-removed one) so a
   * benign snapshot mismatch never throws.
   *
   * @returns the baked positions buffer (always non-null; the caller decides to
   *          use it only when authoritative data exists for the letter).
   */
  private bakeNonOwned(id: string, buf: LetterFrameBuffer, s: number): Vec2[] {
    const curr = this.currById.get(id);
    const prev = this.prevById.get(id);
    return interpolateLetterParticles(prev?.particles, curr?.particles, s, buf.baked);
  }

  // -------------------------------------------------------------------------
  // Render-state assembly (the owned-vs-non-owned split)
  // -------------------------------------------------------------------------

  /**
   * Assemble the {@link RenderState} for the current frame. Iterates the
   * prediction core's letters (the source of each letter's static `glyph` /
   * `spawnJitterSeed` and live ownership) and, per letter, chooses the render
   * source:
   *
   * - **owned** (`ownerId === myPlayerId`) → the prediction buffers, interpolated
   *   by the prediction `alpha` (a `previous` is supplied);
   * - **non-owned** → the position baked from the two most recent authoritative
   *   snapshots, with NO `previous` so the prediction `alpha` does not perturb
   *   it (the snapshot interpolation is already applied). When the letter has no
   *   authoritative data yet (spawned locally a beat before the server's
   *   snapshot caught up) it falls back to the live prediction positions.
   *
   * Reuses the view list and view objects (no per-frame allocation in steady
   * state). A letter with no prediction positions captured yet is seeded from
   * its live spawn positions.
   */
  private buildRenderState(): RenderState {
    const myId = this.net.getPlayerId();
    const s = snapshotInterpolationAlpha(this.prevSnapMs, this.currSnapMs, this.now());

    this.letterViews.length = 0;
    for (const letter of this.gameCore.letters) {
      const buf = this.ensureBuffer(letter.id);
      if (buf.current.length === 0) this.copyParticlePositions(letter.particles, buf.current);

      const view = buf.view;
      view.glyph = letter.glyph;
      view.spawnJitterSeed = letter.spawnJitterSeed;
      view.ownerId = letter.ownerId;
      view.placedSlot = letter.placedSlot;

      const owned = myId !== null && letter.ownerId === myId;
      const hasAuthoritative = this.currById.has(letter.id) || this.prevById.has(letter.id);

      if (owned || !hasAuthoritative) {
        // OWNED → follow the prediction core, interpolating by the loop alpha.
        // (Also the fallback for a letter with no authoritative data yet.)
        view.current = buf.current;
        view.previous = owned && buf.hasPrevious ? buf.previous : undefined;
      } else {
        // NON-OWNED → interpolated authoritative snapshot (Requirement 14.5).
        view.current = this.bakeNonOwned(letter.id, buf, s);
        view.previous = undefined; // already interpolated; alpha must not apply.
      }
      this.letterViews.push(view);
    }

    this.renderState.bounds = this.bounds;
    this.renderState.letters = this.letterViews;
    this.buildSlotViews();
    this.renderState.slots = this.slotViews;
    return this.renderState as RenderState;
  }

  /**
   * Rebuild gray ghost target views for the ACTIVE line from the prediction
   * core's Solution_Slots + correct token glyphs (placement guides only).
   */
  private buildSlotViews(): void {
    this.slotViews.length = 0;
    const lineId = this.activeLineId;
    if (lineId === null) return;
    const slots = this.gameCore.getSolutionSlots(lineId);
    if (!slots) return;
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
