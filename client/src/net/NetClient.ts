/**
 * `NetClient` — the Client networking / synchronization layer (task 17.3).
 *
 * design.md "Net Client (networking / sync layer)":
 *
 * > Manages the WebSocket connection, clock-offset estimation, message
 * > (de)serialization, input dispatch, snapshot ingestion, and reconciliation
 * > hand-off to the prediction `GameCore`.
 *
 * This module owns the three networking concerns of task 17.3 and wires them to
 * a prediction `GameCore`, while staying free of any real `ws`/WebSocket
 * dependency:
 *
 * 1. **Protocol** — encodes C→S messages and decodes S→C messages via the pure
 *    codec in `./protocol.ts` (`serializeClientMessage` / `parseServerMessage`).
 * 2. **Prediction decision** — on a grab, asks the pure `shouldPredictGrab`
 *    (`./predictGrab.ts`) whether to optimistically apply the grab locally
 *    (Requirements 8.5, 8.6).
 * 3. **Reconciliation** — on each authoritative snapshot, `applySnapshot`s the
 *    prediction core, then uses the pure `decideReconciliation`
 *    (`./reconcile.ts`) to re-apply still-pending inputs and snap contradicted
 *    predicted grabs to authoritative state (Requirements 8.7, 14.5, 16.2, 16.4).
 *
 * ## Injectable transport (no live socket required)
 * The real connection is provided through the tiny {@link NetSocket} interface,
 * NOT `WebSocket` directly — the exact mirror of the server's `ClientSocket`
 * dependency-injection pattern. A test supplies a fake socket (capture `send`,
 * push inbound frames, fire `close`); the production `ws`/`WebSocket` adapter is
 * a thin wrapper added with the `RemoteGameHost` (task 17.6). This keeps ALL of
 * the protocol/prediction/reconciliation logic unit-testable without a network.
 *
 * ## Clock offset (reuse, do not reimplement)
 * The `welcome` message carries `serverClock`; combined with the send/receive
 * instants the Net Client records, it feeds the EXISTING clock-offset estimator
 * (`./clockOffset.ts`, task 17.1) via its {@link HandshakeSample} type. The Net
 * Client accumulates handshake samples and exposes the median offset through
 * {@link NetClient.getClockOffset}; it never reimplements the math.
 *
 * ## Relationship to the RemoteGameHost (task 17.6)
 * The Net Client deliberately does NOT implement the `GameHost` interface or own
 * a render loop. Task 17.6's `RemoteGameHost` wraps a `NetClient` behind
 * `GameHost`, driving the prediction `GameCore`'s `tick`, interpolation, audio,
 * and Renderer. Keeping those concerns out of here is what lets 17.6 compose
 * this class without re-plumbing the protocol.
 */

import type {
  GameCoreContract,
  PlayerId,
  PlayerInput,
  GrabInput,
  InputOutcome,
  Snapshot,
  RoundState,
  RoundResult,
} from '@glitch/core';
import {
  serializeClientMessage,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
  type RosterEntry,
} from './protocol.ts';
import { shouldPredictGrab, visibleLocksFromSnapshot, type VisibleLocks } from './predictGrab.ts';
import { decideReconciliation, type PendingInput } from './reconcile.ts';
import {
  estimateClockOffset,
  type HandshakeSample,
} from './clockOffset.ts';

/**
 * The minimal transport surface the {@link NetClient} needs from one connection.
 * A real `WebSocket`/`ws` socket is adapted to this (task 17.6); tests provide a
 * fake. Mirrors the server's `ClientSocket` so both ends share the same
 * dependency-injection shape.
 */
export interface NetSocket {
  /** Send a serialized client message frame to the server. */
  send(data: string): void;
  /** Close the connection. */
  close(): void;
  /** Register the inbound-message handler; `raw` is the frame payload (JSON text). */
  onMessage(handler: (raw: string) => void): void;
  /** Register the close handler, invoked once when the connection ends. */
  onClose(handler: () => void): void;
}

/** Optional observer callbacks for the host/UI layer (task 17.6 / 14.1). */
export interface NetClientCallbacks {
  /** Called after a `welcome` assigns this Client's identity (Requirement 2.1). */
  onWelcome?: (playerId: PlayerId, roomState: RoundState) => void;
  /** Called with each `roster` update (Requirement 2.3). */
  onRoster?: (players: readonly RosterEntry[]) => void;
  /** Called after each `snapshot` has been reconciled into the prediction core. */
  onSnapshot?: (snapshot: Snapshot) => void;
  /** Called with each `grabResult` (Requirements 8.1, 8.2, 8.7). */
  onGrabResult?: (letterId: string, granted: boolean, ownerId: PlayerId | null) => void;
  /** Called on each `roundState` transition (Requirements 10.1–10.4). */
  onRoundState?: (state: RoundState, result: RoundResult | null) => void;
}

/** Construction config for {@link NetClient}. Every dependency is injectable. */
export interface NetClientConfig {
  /** The injected transport (fake in tests; `ws`/`WebSocket` adapter in 17.6). */
  socket: NetSocket;
  /** The prediction `GameCore` this Client predicts into and reconciles. */
  core: GameCoreContract;
  /** Monotonic clock in ms; defaults to `performance.now()` (Date fallback). */
  now?: () => number;
  /** Optional host/UI observer callbacks. */
  callbacks?: NetClientCallbacks;
}

function defaultNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export class NetClient {
  private readonly socket: NetSocket;
  private readonly core: GameCoreContract;
  private readonly now: () => number;
  private readonly callbacks: NetClientCallbacks;

  /** This Client's Player_Id once `welcome` has assigned it; `null` before. */
  private playerId: PlayerId | null = null;
  /** Reconnect token from `welcome`, replayed on a future `join` (Requirement 2.6). */
  private reconnectToken: string | null = null;
  /** Latest round state observed from the server. */
  private roundState: RoundState = 'lobby';

  /**
   * Monotonic client sequence assigned to each predicted input (the grab
   * message's `clientTick`). Advanced once per predicted/sent input so
   * reconciliation can tell acknowledged inputs (`<= snapshot.tick`) from
   * still-in-flight ones (`> snapshot.tick`). See {@link PendingInput}.
   */
  private clientTick = 0;

  /** Inputs applied locally but not yet superseded by a snapshot (in order). */
  private pending: PendingInput[] = [];

  /**
   * The Client's last-known authoritative lock state — the `locks[]` of the most
   * recent snapshot, as a `letterId → ownerId` map. This is the "visible lock
   * state" the prediction decision reasons over (Requirements 8.5, 8.6). Empty
   * until the first snapshot arrives.
   */
  private visibleLocks: VisibleLocks = new Map<string, PlayerId>();

  /**
   * The `tSend` of an outstanding handshake (the `join` send instant), or `null`
   * when no handshake is in flight. Paired with the `welcome`'s `serverClock`
   * and the receive instant to form a {@link HandshakeSample}.
   */
  private handshakeSentAt: number | null = null;
  /** Accumulated handshake samples; the median offset is exposed (task 17.1). */
  private readonly handshakeSamples: HandshakeSample[] = [];
  /** Median clock offset (`serverClock - clientClock`) once estimated; else `null`. */
  private clockOffset: number | null = null;

  constructor(config: NetClientConfig) {
    this.socket = config.socket;
    this.core = config.core;
    this.now = config.now ?? defaultNow;
    this.callbacks = config.callbacks ?? {};

    this.socket.onMessage((raw) => this.handleRaw(raw));
    this.socket.onClose(() => this.handleClose());
  }

  // -------------------------------------------------------------------------
  // Read accessors
  // -------------------------------------------------------------------------

  /** This Client's assigned Player_Id, or `null` before `welcome`. */
  getPlayerId(): PlayerId | null {
    return this.playerId;
  }

  /** The latest round state observed from the server. */
  getRoundState(): RoundState {
    return this.roundState;
  }

  /**
   * The estimated median clock offset (`serverClock - clientClock`, ms) from the
   * handshake samples gathered so far, or `null` before the first `welcome`.
   * Add it to a client timestamp (via `toServerTime`) to align local ticks with
   * the server timeline (Requirement 16.5).
   */
  getClockOffset(): number | null {
    return this.clockOffset;
  }

  /** The current pending-input queue length (still-in-flight predicted inputs). */
  get pendingCount(): number {
    return this.pending.length;
  }

  // -------------------------------------------------------------------------
  // Outbound (C→S) — protocol encode + prediction
  // -------------------------------------------------------------------------

  /**
   * Send a `join` and start the clock-offset handshake (Requirements 1.3, 2.1,
   * 2.6, 16.5). Records the send instant so the matching `welcome` forms a
   * handshake sample. Replays a stored {@link reconnectToken} when present so a
   * dropped Client returns to the same Room/identity (Requirement 2.6).
   */
  join(roomCode: string, displayName?: string): void {
    this.handshakeSentAt = this.now();
    this.send({
      type: 'join',
      roomCode,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(this.reconnectToken !== null ? { reconnectToken: this.reconnectToken } : {}),
    });
  }

  /**
   * Send the latest cursor position (Requirement 2.4). The cursor is also
   * applied to the prediction core so held-letter steering is responsive, and is
   * queued as a pending input so reconciliation can replay an unacknowledged
   * cursor after a snapshot. Requires {@link playerId} (after `welcome`).
   */
  sendCursor(x: number, y: number): void {
    if (this.playerId === null) return;
    const input: PlayerInput = { type: 'cursor', playerId: this.playerId, x, y };
    this.predictLocally(input);
    this.send({ type: 'cursor', x, y });
  }

  /**
   * Attempt to grab a Rope_Letter (Requirements 8.1, 8.5, 8.6). Always SENDS the
   * `grab` to the server (the server is authoritative). The Client applies
   * CLIENT-SIDE PREDICTION — beginning to move the letter locally — IFF the pure
   * {@link shouldPredictGrab} decision says the target is not visibly locked by
   * another Player. A grab on a visibly-locked letter is sent but NOT predicted
   * (Requirement 8.6); the authoritative `grabResult`/`snapshot` then confirms
   * the denial.
   *
   * Returns the local prediction outcome (the prediction core's
   * {@link InputOutcome}) when predicted, or `null` when prediction was skipped.
   */
  grab(letterId: string): InputOutcome | null {
    if (this.playerId === null) return null;

    const tick = this.nextClientTick();
    // Always inform the server (it owns the lock); carry the client tick (8.1).
    this.send({ type: 'grab', letterId, clientTick: tick });

    // Decision (8.5/8.6): predict only if not visibly locked by another player.
    const predict = shouldPredictGrab(this.visibleLocks, letterId, this.playerId);
    if (!predict) return null;

    const input: GrabInput = {
      type: 'grab',
      playerId: this.playerId,
      letterId,
      clientTick: tick,
    };
    const outcome = this.core.applyInput(input);
    this.pending.push({ clientTick: tick, input });
    return outcome;
  }

  /**
   * Release a previously grabbed Rope_Letter (Requirement 8.4). Applied to the
   * prediction core immediately and sent to the server; queued as pending so it
   * survives reconciliation until acknowledged.
   */
  release(letterId: string): void {
    if (this.playerId === null) return;
    const input: PlayerInput = { type: 'release', playerId: this.playerId, letterId };
    this.predictLocally(input);
    this.send({ type: 'release', letterId });
  }

  /** Send a `startRound` (Host only, enforced server-side) (Requirements 10.1, 10.5). */
  startRound(trackRef: string): void {
    this.send({ type: 'startRound', trackRef });
  }

  /** Close the underlying transport. */
  dispose(): void {
    this.socket.close();
  }

  // -------------------------------------------------------------------------
  // Inbound (S→C) — protocol decode + reconciliation
  // -------------------------------------------------------------------------

  /** Decode a raw inbound frame and dispatch it; malformed frames are ignored. */
  private handleRaw(raw: string): void {
    const message = parseServerMessage(raw);
    if (message === null) return; // malformed/partial frame: ignore (never throw).
    this.handleMessage(message);
  }

  /** Dispatch a validated {@link ServerMessage} to its handler. */
  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome':
        this.onWelcome(message.playerId, message.serverClock, message.roomState, message.reconnectToken);
        break;
      case 'roster':
        this.callbacks.onRoster?.(message.players);
        break;
      case 'snapshot':
        this.onSnapshot(message.snapshot);
        break;
      case 'grabResult':
        this.callbacks.onGrabResult?.(message.letterId, message.granted, message.ownerId);
        break;
      case 'roundState':
        this.roundState = message.state;
        this.callbacks.onRoundState?.(message.state, message.result ?? null);
        break;
    }
  }

  /**
   * Handle `welcome` (Requirements 2.1, 16.5): adopt the assigned identity and
   * reconnect token, record the round state, and complete the clock-offset
   * handshake sample from the recorded send instant, the server clock, and the
   * receive instant — feeding the EXISTING `estimateClockOffset` estimator.
   */
  private onWelcome(
    playerId: PlayerId,
    serverClock: number,
    roomState: RoundState,
    reconnectToken: string,
  ): void {
    this.playerId = playerId;
    this.reconnectToken = reconnectToken;
    this.roundState = roomState;

    // Complete a handshake sample if a `join` is outstanding (task 17.1 reuse).
    if (this.handshakeSentAt !== null) {
      const sample: HandshakeSample = {
        tSend: this.handshakeSentAt,
        tServer: serverClock,
        tReceive: this.now(),
      };
      this.handshakeSamples.push(sample);
      this.handshakeSentAt = null;
      this.clockOffset = estimateClockOffset(this.handshakeSamples).offset;
    }

    this.callbacks.onWelcome?.(playerId, roomState);
  }

  /**
   * Reconcile an authoritative snapshot into the prediction core (Requirements
   * 8.7, 14.5, 16.2, 16.4 / Property 24). Three steps:
   *
   *   1. **Overwrite authoritative fields** — `core.applySnapshot(snapshot)`
   *      brings every letter's position, lock, cursor, placedSlot, tick, and
   *      provisional score to the authoritative values. The prediction core now
   *      MATCHES the snapshot exactly; non-owned letters thereby follow the
   *      authoritative state (Requirement 14.5).
   *   2. **Decide** — the pure {@link decideReconciliation} splits the pending
   *      queue into the still-in-flight inputs to re-apply and the contradicted
   *      predicted grabs to snap (drop). The snapped letters are already at
   *      authoritative state from step 1 (Requirement 8.7).
   *   3. **Re-apply** — replay the surviving pending inputs over the
   *      just-applied snapshot so unacknowledged local actions stay responsive
   *      (Requirements 16.4, 14.4). `applyInput` never moves particles, so this
   *      cannot pull a letter off its authoritative position.
   *
   * Finally, refresh the visible lock state used by the prediction decision and
   * notify the observer.
   */
  private onSnapshot(snapshot: Snapshot): void {
    // 1) Authoritative overwrite.
    this.core.applySnapshot(snapshot);

    // 2) Pure reconcile decision over the pending queue.
    const selfId = this.playerId;
    if (selfId !== null) {
      const decision = decideReconciliation(snapshot, this.pending, selfId);
      // 3) Re-apply survivors; contradicted grabs are simply not re-applied
      //    (already snapped to authoritative by applySnapshot).
      for (const entry of decision.reapply) this.core.applyInput(entry.input);
      this.pending = decision.reapply;
    } else {
      // No identity yet → trust authority fully; nothing to re-apply.
      this.pending = [];
    }

    // Refresh the visible lock state the prediction decision reads (8.5/8.6).
    this.visibleLocks = visibleLocksFromSnapshot(snapshot.locks);

    this.callbacks.onSnapshot?.(snapshot);
  }

  /** Reset volatile per-connection state when the transport closes. */
  private handleClose(): void {
    this.pending = [];
    this.handshakeSentAt = null;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Apply a non-grab input to the prediction core and queue it as pending. */
  private predictLocally(input: PlayerInput): void {
    const tick = this.nextClientTick();
    this.core.applyInput(input);
    this.pending.push({ clientTick: tick, input });
  }

  /** Advance and return the next monotonic client tick for a sent/predicted input. */
  private nextClientTick(): number {
    this.clientTick += 1;
    return this.clientTick;
  }

  /** Encode and send a {@link ClientMessage} over the injected transport. */
  private send(message: ClientMessage): void {
    this.socket.send(serializeClientMessage(message));
  }
}
