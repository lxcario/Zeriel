/**
 * `GameHost` — the host abstraction the Renderer reads from (task 13.1).
 *
 * ## Why this interface exists
 * The design has TWO interchangeable hosts that drive the same `GameCore` and
 * feed the same Renderer (design.md "Single-Player vs Multiplayer Topology"):
 *
 * - {@link LocalGameHost} (task 13.1) — runs `GameCore` entirely in-browser on a
 *   `requestAnimationFrame` fixed-timestep loop, with NO network. The single
 *   Player implicitly owns any letter they grab (Requirements 15.1, 15.2).
 * - `RemoteGameHost` (task 17.6) — connects over WebSocket, keeps a prediction
 *   `GameCore`, and reconciles from authoritative snapshots.
 *
 * Both implement THIS interface so the UI shell can swap between them
 * (task 18.1's host-switching) and the Renderer can read frame data from
 * whichever host is active without knowing which one it is. The Renderer never
 * talks to `GameCore`, the network, or the audio graph directly — it only reads
 * {@link GameHost.getRenderState}, {@link GameHost.getInterpolationAlpha}, and
 * {@link GameHost.getAudioFrame}, which both hosts provide identically.
 *
 * Keeping this surface minimal and host-agnostic is what makes single-player and
 * multiplayer interchangeable by construction — mirroring the design's "single
 * shared `GameCore`" decision at the host layer.
 */

import type { PlayerInput, InputOutcome, RoundState, RoundResult } from '@glitch/core';
import type { RenderState } from '../render/index.ts';
import type { AudioFrame } from '../audio/AudioPlayer.ts';

/**
 * Which topology a {@link GameHost} implements. The Renderer and UI are
 * mode-agnostic, but the flag lets the shell label the surface and lets
 * mode-equivalence tests (Property 30, task 18.2) identify the host.
 */
export type GameHostMode = 'single-player' | 'multiplayer';

/**
 * The host contract shared by {@link LocalGameHost} (task 13.1) and the future
 * `RemoteGameHost` (task 17.6). It splits cleanly into three concerns:
 *
 * 1. **Lifecycle** — {@link start} / {@link dispose} bracket a Round; the host
 *    owns the per-frame loop (and, for the local host, drives the audio +
 *    Renderer) between them.
 * 2. **Input** — {@link applyInput} forwards a player's cursor/grab/release into
 *    the gameplay layer (locally for `LocalGameHost`, over the wire for the
 *    remote host). Single-player ownership is implicit (Requirement 15.2).
 * 3. **Read surface** — the `get*` methods expose exactly what the Renderer and
 *    UI need each frame, with no dependence on how the state was produced.
 */
export interface GameHost {
  /** Whether this host runs single-player (local) or multiplayer (remote). */
  readonly mode: GameHostMode;

  /**
   * Begin the Round: start the per-frame loop and (for the local host) begin
   * audio playback and rendering. Idempotent — calling it while already running
   * is a no-op.
   */
  start(): void;

  /**
   * Stop the loop and release all resources (audio graph, renderer buffers,
   * any connection). Idempotent and safe to call without a prior {@link start}.
   */
  dispose(): void;

  /**
   * Apply one player input (cursor move, grab, or release) and return its
   * outcome. For {@link LocalGameHost} this goes straight to the in-browser
   * `GameCore` (the single Player implicitly owns any letter they grab,
   * Requirement 15.2); for the remote host it is sent to the server and
   * predicted locally.
   */
  applyInput(input: PlayerInput): InputOutcome;

  /** Current Round lifecycle state (`lobby`/`resolving`/.../`scoring`). */
  getRoundState(): RoundState;

  /**
   * The finalized {@link RoundResult} once the Round has entered `scoring`
   * (Requirement 10.4 — finalized BEFORE it is observable here), or `null`
   * while the Round is still in progress.
   */
  getRoundResult(): RoundResult | null;

  /**
   * The view of the world for the CURRENT frame, ready to hand to
   * `Renderer.draw` (letters carry both current and previous physics positions
   * so the Renderer can interpolate by {@link getInterpolationAlpha}). Built
   * from the two most recent physics states (Requirement 14.1).
   */
  getRenderState(): RenderState;

  /**
   * Interpolation factor in `[0, 1)` for the current frame — `accumulator /
   * stepMs` from the fixed-timestep loop. Passed as `alpha` to `Renderer.draw`
   * so rendering stays smooth at the display rate even though physics ticks at
   * ~30Hz (Requirements 14.1, 14.2).
   */
  getInterpolationAlpha(): number;

  /**
   * The latest reactive {@link AudioFrame}, or `null` when audio analysis is
   * unavailable (CORS-unreliable stream, Requirement 5.3). Passed straight to
   * `Renderer.draw`.
   */
  getAudioFrame(): AudioFrame | null;
}
