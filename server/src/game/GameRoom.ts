/**
 * `GameRoom` — the per-Room authoritative simulation (task 16.9).
 *
 * This is the SERVER-SIDE counterpart of the client's `LocalGameHost`: it runs
 * the authoritative {@link GameCore} on a fixed ~30Hz tick (Requirement 14.6)
 * driving the {@link LyricScheduler} (Requirement 6.3) and the
 * {@link RoundLifecycle} (Requirements 10.x), and decides when to broadcast the
 * authoritative state (Rope_Letter positions, Ownership_Lock states, cursor
 * presence, provisional scores) at ≥15Hz (Requirements 16.1, 2.4, 9.3).
 *
 * ## Transport-free + injectable (testability)
 * Exactly like the pure {@link RoomManager} and the client `LocalGameHost`, this
 * class has NO `ws`/socket dependency. The clock (`now`), the fixed-timestep and
 * broadcast-rate parameters, and the OUTPUT sinks (`onBroadcast`,
 * `onRoundState`) are all injected via {@link GameRoomConfig}. The `ws` transport
 * (`GameServer`) wires `onBroadcast`/`onRoundState` to real socket sends; tests
 * drive {@link GameRoom.advance} with synthetic timestamps and capture the sinks
 * — no real timers or sockets required. The rate/scheduling DECISIONS live in
 * the pure {@link planServerTicks} / {@link shouldBroadcast} helpers so they are
 * independently property-testable.
 *
 * ## What one {@link advance} does (the tick-loop body)
 * Given the current monotonic time, {@link advance}:
 * 1. Computes playback time as `now - roundStartMs` and updates the
 *    {@link LyricScheduler}, which spawns each due Lyric_Line into `GameCore`
 *    (Requirement 6.3, exactly-once / in-order from the scheduler's guarantees).
 * 2. Converts the wall-clock time since the last advance into a whole number of
 *    fixed `stepMs` ticks via {@link planServerTicks} and runs `GameCore.tick`
 *    that many times — a stable ~30Hz regardless of how often the driver wakes
 *    (Requirements 7.2, 14.2, 14.6).
 * 3. If the Round is over (all lines dropped AND the post-roll window elapsed,
 *    or an injected end test), finalizes EVERY dropped line and produces the
 *    Round result BEFORE the `scoring` state becomes observable (Requirement
 *    10.4 via {@link RoundLifecycle.enterScoring}), then notifies via
 *    `onRoundState('scoring', result)`.
 * 4. While still playing, if a broadcast is due ({@link shouldBroadcast}), emits
 *    one authoritative {@link Snapshot} through `onBroadcast` (≥15Hz).
 *
 * The broadcaster only emits WHILE the Round is `playing` — that is the window
 * Requirements 16.1/2.4 scope ("while a multiplayer Round is in the playing
 * state"). A late joiner is hydrated out-of-band via {@link snapshot} (the
 * server calls it on join-in-progress, Requirement 16.3).
 */

import { GameCore, LyricScheduler, RoundLifecycle } from '@glitch/core';
import type {
  GameConfig,
  LyricLine,
  PlayerInput,
  InputOutcome,
  Snapshot,
  RoundState,
  RoundResult,
  Room,
} from '@glitch/core';
import {
  planServerTicks,
  DEFAULT_SERVER_STEP_MS,
  DEFAULT_MAX_TICKS_PER_WAKE,
} from './tickPlan.js';
import {
  shouldBroadcast,
  broadcastIntervalForHz,
  meetsMinBroadcastRate,
  MIN_BROADCAST_HZ,
} from './broadcastSchedule.js';

/**
 * Default post-roll window (ms, in playback time) after the LAST Lyric_Line
 * drops before the Round transitions to scoring, giving the final letters time
 * to settle into their Solution_Slots (Requirement 10.3). Mirrors the client
 * `LocalGameHost.DEFAULT_DROP_WINDOW_MS`.
 */
export const DEFAULT_DROP_WINDOW_MS = 2500;

/** The data needed to begin an authoritative Round for a Room. */
export interface RoundSetup {
  /** Deterministic seed for the authoritative `GameCore` (reproducibility). */
  seed: number;
  /** Ordered Lyric_Lines (already resolved/parsed) the scheduler will drop. */
  lines: readonly LyricLine[];
  /** Optional track title carried into the finalized {@link RoundResult}. */
  trackTitle?: string;
}

/** Construction config for {@link GameRoom}; every dependency is injectable. */
export interface GameRoomConfig {
  /**
   * The shared {@link Room} object owned by the {@link RoomManager}. `GameRoom`
   * keeps `room.state` in sync with the {@link RoundLifecycle} and sets
   * `room.game` so the manager can release a disconnecting player's locks
   * (Requirements 2.5, 8.8) using only the existing contract surface.
   */
  room: Room;
  /** Static physics/spawn/placement/session configuration for `GameCore`. */
  gameConfig: GameConfig;
  /** Monotonic clock in ms. Injected so tests drive time deterministically. */
  now: () => number;
  /** Emit one authoritative snapshot (≥15Hz while playing, Req 16.1/2.4/9.3). */
  onBroadcast: (snapshot: Snapshot) => void;
  /** Notify a Round lifecycle transition (with the finalized result on scoring). */
  onRoundState: (state: RoundState, result?: RoundResult) => void;
  /** Fixed physics step in ms; defaults to {@link DEFAULT_SERVER_STEP_MS} (30Hz). */
  stepMs?: number;
  /** Max ticks run per advance (spiral guard); defaults to {@link DEFAULT_MAX_TICKS_PER_WAKE}. */
  maxTicksPerWake?: number;
  /**
   * Minimum spacing between broadcasts, in ms. Defaults to one full ~33.3ms tick
   * (≈30Hz) which exceeds the 15Hz floor. MUST satisfy the ≥15Hz floor
   * ({@link meetsMinBroadcastRate}); a too-slow value throws at construction.
   */
  broadcastIntervalMs?: number;
  /** Post-roll window before scoring; defaults to {@link DEFAULT_DROP_WINDOW_MS}. */
  dropWindowMs?: number;
  /**
   * Optional override for the round-over test (Requirement 10.3). Defaults to
   * "all lines dropped AND the post-roll {@link dropWindowMs} has elapsed (in
   * playback time) since the last drop".
   */
  isRoundOver?: (playbackMs: number, scheduler: LyricScheduler) => boolean;
}

export class GameRoom {
  private readonly room: Room;
  private readonly gameConfig: GameConfig;
  private readonly now: () => number;
  private readonly onBroadcast: (snapshot: Snapshot) => void;
  private readonly onRoundState: (state: RoundState, result?: RoundResult) => void;

  private readonly stepMs: number;
  private readonly maxTicksPerWake: number;
  private readonly broadcastIntervalMs: number;
  private readonly dropWindowMs: number;
  private readonly isRoundOverFn: (playbackMs: number, scheduler: LyricScheduler) => boolean;

  private readonly lifecycle: RoundLifecycle;

  /** Active engine while a Round is running, else `null`. Mirrored into `room.game`. */
  private game: GameCore | null = null;
  /** Active scheduler while a Round is running, else `null`. */
  private scheduler: LyricScheduler | null = null;
  /** Ids of every Lyric_Line dropped this Round — finalized at scoring (Req 9.4). */
  private droppedLineIds: string[] = [];

  /** Monotonic time the current Round started (playback time origin). */
  private roundStartMs = 0;
  /** Playback time (ms) at which the most recent line dropped. */
  private lastDropMs = 0;
  /** `now()` of the previous {@link advance}, or `null` before the first one. */
  private lastAdvanceMs: number | null = null;
  /** Leftover fixed-timestep accumulator carried between advances (ms). */
  private accumulatorMs = 0;
  /** `now()` of the previous broadcast, or `null` if none emitted this Round. */
  private lastBroadcastMs: number | null = null;
  /** Finalized result once scoring is entered (Requirement 10.4). */
  private roundResult: RoundResult | null = null;

  constructor(config: GameRoomConfig) {
    this.room = config.room;
    this.gameConfig = config.gameConfig;
    this.now = config.now;
    this.onBroadcast = config.onBroadcast;
    this.onRoundState = config.onRoundState;

    this.stepMs = config.stepMs && config.stepMs > 0 ? config.stepMs : DEFAULT_SERVER_STEP_MS;
    this.maxTicksPerWake =
      config.maxTicksPerWake && config.maxTicksPerWake > 0
        ? config.maxTicksPerWake
        : DEFAULT_MAX_TICKS_PER_WAKE;
    this.broadcastIntervalMs =
      config.broadcastIntervalMs ?? broadcastIntervalForHz(MIN_BROADCAST_HZ * 2);
    if (!meetsMinBroadcastRate(this.broadcastIntervalMs)) {
      throw new Error(
        `GameRoom: broadcastIntervalMs ${this.broadcastIntervalMs}ms is slower than the ${MIN_BROADCAST_HZ}Hz floor`,
      );
    }
    this.dropWindowMs =
      config.dropWindowMs !== undefined && config.dropWindowMs >= 0
        ? config.dropWindowMs
        : DEFAULT_DROP_WINDOW_MS;
    this.isRoundOverFn = config.isRoundOver ?? ((ms, sch) => this.defaultIsRoundOver(ms, sch));

    // The Round lifecycle starts wherever the shared Room is (normally 'lobby').
    this.lifecycle = new RoundLifecycle(this.room.state);
  }

  // -------------------------------------------------------------------------
  // Read accessors
  // -------------------------------------------------------------------------

  /** Current Round lifecycle state (kept in sync with `room.state`). */
  get state(): RoundState {
    return this.lifecycle.state;
  }

  /** Whether a Round is currently in progress (the broadcasting/ticking window). */
  isPlaying(): boolean {
    return this.lifecycle.state === 'playing';
  }

  /** The finalized {@link RoundResult} once scoring is entered, else `null`. */
  getRoundResult(): RoundResult | null {
    return this.roundResult;
  }

  /**
   * The current authoritative {@link Snapshot}, or `null` if no Round is active.
   * The `ws` transport calls this to hydrate a client joining a Round in
   * progress (Requirement 16.3); the join-in-progress *decision* is the pure
   * `shouldSendJoinSnapshot(state)`.
   */
  snapshot(): Snapshot | null {
    return this.game ? this.game.snapshot() : null;
  }

  // -------------------------------------------------------------------------
  // Round control
  // -------------------------------------------------------------------------

  /**
   * Begin an authoritative Round: construct a fresh seeded `GameCore` and a
   * {@link LyricScheduler} over `setup.lines`, walk the {@link RoundLifecycle}
   * resolved path to `playing` (the host having resolved audio+lyrics
   * client-side), publish the engine on `room.game` (so the manager can release
   * locks on disconnect), and notify `onRoundState('playing')`.
   *
   * Returns `false` (a no-op) if a Round is already in progress or the lifecycle
   * cannot reach `playing` from its current state — the server rejects a stray
   * `startRound` rather than throwing.
   */
  startRound(setup: RoundSetup): boolean {
    if (this.lifecycle.state === 'playing') return false;
    if (!this.driveToPlaying()) return false;

    const game = new GameCore(setup.seed, this.gameConfig);
    if (setup.trackTitle !== undefined) game.setTrackTitle(setup.trackTitle);

    this.droppedLineIds = [];
    this.scheduler = new LyricScheduler(setup.lines, (line) => {
      game.spawnLine(line);
      this.droppedLineIds.push(line.id);
    });

    this.game = game;
    this.room.game = game;

    const startedAt = this.now();
    this.roundStartMs = startedAt;
    this.lastDropMs = 0;
    this.lastAdvanceMs = startedAt;
    this.accumulatorMs = 0;
    this.lastBroadcastMs = null;
    this.roundResult = null;

    this.syncRoomState();
    this.onRoundState('playing');
    return true;
  }

  /**
   * Apply one player input (cursor/grab/release) to the authoritative engine and
   * return its outcome (Requirements 8.1–8.4). A no-op returning a benign
   * "denied/not-accepted" outcome when no Round is active, so a stray input on a
   * non-playing Room cannot throw.
   */
  applyInput(input: PlayerInput): InputOutcome {
    if (!this.game) return GameRoom.inactiveOutcome(input);
    return this.game.applyInput(input);
  }

  // -------------------------------------------------------------------------
  // Tick loop body
  // -------------------------------------------------------------------------

  /**
   * Advance the authoritative simulation to monotonic time `nowMs` and, while
   * playing, broadcast when due. This is the body of the ~30Hz tick loop; the
   * driver (`GameServer`'s timer) calls it each wake, and tests call it with
   * synthetic timestamps. A no-op unless the Round is `playing`.
   *
   * @returns The number of fixed `GameCore.tick` calls run (0 when not playing
   *   or when not enough wall-clock time has accumulated for a whole step).
   */
  advance(nowMs: number): number {
    if (this.lifecycle.state !== 'playing' || !this.game || !this.scheduler) return 0;

    // 1) Drive lyric scheduling off the playback clock (now - roundStart).
    const playbackMs = nowMs - this.roundStartMs;
    const droppedBefore = this.scheduler.dropped;
    this.scheduler.update(playbackMs);
    if (this.scheduler.dropped > droppedBefore) this.lastDropMs = playbackMs;

    // 2) Fixed-timestep physics, decoupled from the driver's wake cadence.
    const elapsed = this.lastAdvanceMs === null ? 0 : nowMs - this.lastAdvanceMs;
    this.lastAdvanceMs = nowMs;
    const plan = planServerTicks(this.accumulatorMs, elapsed, this.stepMs, this.maxTicksPerWake);
    for (let i = 0; i < plan.ticks; i++) {
      this.game.tick(this.stepMs);
    }
    this.accumulatorMs = plan.accumulator;

    // 3) Round-end → finalize BEFORE scoring is observable (Req 10.3/10.4).
    if (this.maybeEnterScoring(playbackMs)) {
      return plan.ticks; // round ended this advance; no further broadcast.
    }

    // 4) Broadcast authoritative state at ≥15Hz while playing (Req 16.1/2.4/9.3).
    if (shouldBroadcast(this.lastBroadcastMs, nowMs, this.broadcastIntervalMs)) {
      this.lastBroadcastMs = nowMs;
      this.onBroadcast(this.game.snapshot());
    }

    return plan.ticks;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * If the Round is over, finalize every dropped line and produce the Round
   * result BEFORE the `scoring` state becomes observable (Requirement 10.4 — the
   * `enterScoring` contract runs the finalizer first), then notify
   * `onRoundState('scoring', result)`.
   *
   * @returns `true` iff the Round entered scoring on this call.
   */
  private maybeEnterScoring(playbackMs: number): boolean {
    if (this.lifecycle.state !== 'playing' || !this.game || !this.scheduler) return false;
    if (!this.isRoundOverFn(playbackMs, this.scheduler)) return false;

    const game = this.game;
    const lineIds = this.droppedLineIds;
    const scoring = this.lifecycle.enterScoring(() => {
      for (const id of lineIds) game.finalizeLine(id);
      return game.getRoundResult();
    });
    if (!scoring.ok) return false;

    this.roundResult = scoring.result;
    this.syncRoomState();
    this.onRoundState('scoring', scoring.result);
    return true;
  }

  /**
   * Default round-over test (Requirement 10.3): the last Lyric_Line has dropped
   * AND the post-roll {@link dropWindowMs} has elapsed (in playback time) since
   * that last drop. A Round with NO lines is over once the window elapses from
   * the round start (playbackMs >= dropWindowMs), so an empty track still scores
   * and ends rather than hanging.
   */
  private defaultIsRoundOver(playbackMs: number, scheduler: LyricScheduler): boolean {
    if (!scheduler.isComplete()) return false;
    return playbackMs - this.lastDropMs >= this.dropWindowMs;
  }

  /**
   * Walk the {@link RoundLifecycle} resolved path to `playing`
   * (`lobby -> resolving -> ready -> playing`), reporting audio+lyrics resolved
   * (the host resolved them client-side before sending `startRound`). Returns
   * whether `playing` was reached.
   */
  private driveToPlaying(): boolean {
    const lc = this.lifecycle;
    if (lc.state === 'lobby') lc.selectTrack();
    if (lc.state === 'resolving') {
      lc.reportResolution({ audioResolved: true, lyricsResolved: true });
    }
    if (lc.state === 'ready') lc.start();
    this.syncRoomState();
    return lc.state === 'playing';
  }

  /** Mirror the lifecycle state onto the shared {@link Room} object. */
  private syncRoomState(): void {
    this.room.state = this.lifecycle.state;
  }

  /**
   * A benign outcome for an input applied when no Round is active, matching the
   * originating input's discriminant so callers can branch exhaustively.
   */
  private static inactiveOutcome(input: PlayerInput): InputOutcome {
    switch (input.type) {
      case 'grab':
        return { type: 'grab', letterId: input.letterId, granted: false, ownerId: null };
      case 'release':
        return { type: 'release', letterId: input.letterId, released: false };
      case 'cursor':
        return { type: 'cursor', accepted: false };
    }
  }
}
