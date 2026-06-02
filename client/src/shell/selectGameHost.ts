/**
 * `selectGameHost` — the pure host-selection factory that LAYERS multiplayer on
 * top of single-player (task 18.1).
 *
 * ## Why this is a standalone, pure unit
 * The design's load-bearing decision is "a single shared `GameCore` drives one
 * of two interchangeable hosts" (design.md "Single-Player vs Multiplayer
 * Topology"). Both {@link LocalGameHost} and {@link RemoteGameHost} implement the
 * SAME {@link GameHost} interface, so the only place a Round actually differs by
 * topology is the host that is constructed. Concentrating that one decision in a
 * pure function (given a {@link SessionMode} + the assembled parts, return a
 * {@link GameHost}) keeps the React surface mode-agnostic and lets the
 * mode-equivalence test (Property 30, task 18.2) run an identical arrangement
 * through BOTH hosts without going through the UI.
 *
 * ## The layering guarantee (Requirements 15.2, 15.4, 16.1)
 * Multiplayer adds Room presence, Cursor sharing, and Ownership_Locks ON TOP of
 * single-player gameplay WITHOUT changing ordering/scoring: the `GameCore` (the
 * sole owner of ordering/scoring) is identical in both branches — this factory
 * never forks or alters it. The {@link RemoteGameHost} only adds the
 * server-authoritative + reconciliation layer and the presence/roster/cursor
 * stream; the {@link LocalGameHost} runs the very same core in-browser.
 *
 * ## Graceful single-player fallback (Requirement 15.4)
 * A multiplayer session is honored only when it is actually usable: it needs a
 * non-blank Room_Code AND a non-blank WebSocket URL, and the transport must be
 * constructable. When any of those is missing (multiplayer disabled, no
 * Room_Code, or the socket factory throws) the factory falls back to a
 * {@link LocalGameHost} so the Player can still start and complete the Round
 * locally — exactly the "still demos if multiplayer slips" guarantee. The
 * returned {@link HostSelection.fellBack} flag lets the UI label the fallback.
 */

import type { LyricLine, Rect, RenderOptions } from '@glitch/core';
import type { GameCore } from '@glitch/core';
import type { Renderer } from '../render/index.ts';
import type { AudioPlayer } from '../audio/AudioPlayer.ts';
import type { NetSocket, NetClientCallbacks } from '../net/index.ts';
import {
  LocalGameHost,
  RemoteGameHost,
  createWebSocketNetSocket,
  type GameHost,
  type GameHostMode,
} from '../host/index.ts';
import type { SessionMode } from './sessionMode.ts';

/**
 * The assembled, mode-agnostic parts a host needs, plus the injection seams that
 * keep the selection testable (mirroring the rest of the shell's injection
 * pattern). The `GameCore`, lines, audio, renderer, canvas, render options, and
 * bounds are IDENTICAL regardless of topology — only the host wrapping them
 * changes.
 */
export interface HostSelectionDeps {
  /** The shared pure engine — the SOLE owner of ordering/scoring in both modes. */
  gameCore: GameCore;
  /** Ordered Lyric_Lines for the Round (scheduled identically by either host). */
  lines: readonly LyricLine[];
  /** The Audio_Player providing the playback clock and reactive frames. */
  audioPlayer: AudioPlayer;
  /** The Renderer drawn each frame (mode-agnostic read surface). */
  renderer: Renderer;
  /** Canvas the Renderer initializes against. */
  canvas: HTMLCanvasElement;
  /** Render options (reduce-motion, off-grid offset) passed to `renderer.init`. */
  renderOptions: RenderOptions;
  /** Play-area bounds for the render state (same as the GameCore bounds). */
  bounds: Rect;
  /**
   * Transport factory used for a multiplayer session. Defaults to the real
   * {@link createWebSocketNetSocket}; a test injects a fake so no real
   * `WebSocket` is opened. A throw here triggers the single-player fallback.
   */
  createSocket?: (url: string) => NetSocket;
  /**
   * Optional Net Client observer callbacks (roster/welcome/grabResult/etc.) so
   * the shell can surface Room presence in multiplayer. Ignored in single-player.
   */
  callbacks?: NetClientCallbacks;
}

/**
 * The outcome of {@link selectGameHost}: the constructed {@link GameHost}, the
 * topology actually used, and whether a requested multiplayer session fell back
 * to single-player (Requirement 15.4) so the UI can label the degraded state.
 */
export interface HostSelection {
  /** The constructed host, ready for `start()`. */
  host: GameHost;
  /** The topology actually used (`'multiplayer'` only when a remote host was built). */
  mode: GameHostMode;
  /** True when a multiplayer session was requested but fell back to single-player. */
  fellBack: boolean;
}

/** Build the in-browser {@link LocalGameHost} for `deps` (the default / fallback host). */
function buildLocalHost(deps: HostSelectionDeps): GameHost {
  return new LocalGameHost({
    gameCore: deps.gameCore,
    lines: deps.lines,
    audioPlayer: deps.audioPlayer,
    renderer: deps.renderer,
    canvas: deps.canvas,
    renderOptions: deps.renderOptions,
    bounds: deps.bounds,
  });
}

/** A non-blank string check used to validate the multiplayer connection inputs. */
function isNonBlank(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Choose and construct the {@link GameHost} for `session`.
 *
 * - **single-player** → always a {@link LocalGameHost} (Requirement 15.1).
 * - **multiplayer** → a {@link RemoteGameHost} when the session has a usable
 *   Room_Code + WebSocket URL and the transport constructs successfully
 *   (Requirements 15.4, 16.1); otherwise a {@link LocalGameHost} with
 *   {@link HostSelection.fellBack} set (the graceful Single_Player_Mode fallback).
 *
 * The function is pure with respect to its inputs (it constructs hosts but does
 * NOT start them or open a connection — `start()` does that), so it is safe to
 * call from a React effect and trivial to exercise in a test.
 */
export function selectGameHost(session: SessionMode, deps: HostSelectionDeps): HostSelection {
  if (session.kind === 'single-player') {
    return { host: buildLocalHost(deps), mode: 'single-player', fellBack: false };
  }

  // Multiplayer requested. It is usable only with a non-blank Room_Code AND URL
  // (Requirement 15.4 — no Room_Code / multiplayer disabled → fall back).
  if (!isNonBlank(session.roomCode) || !isNonBlank(session.socketUrl)) {
    return { host: buildLocalHost(deps), mode: 'single-player', fellBack: true };
  }

  const createSocket = deps.createSocket ?? ((url: string) => createWebSocketNetSocket(url));

  let socket: NetSocket;
  try {
    socket = createSocket(session.socketUrl);
  } catch {
    // Transport could not be constructed (multiplayer unavailable) → fall back
    // so the Player can still start and complete the Round locally (15.4).
    return { host: buildLocalHost(deps), mode: 'single-player', fellBack: true };
  }

  const host = new RemoteGameHost({
    core: deps.gameCore,
    socket,
    lines: deps.lines,
    audioPlayer: deps.audioPlayer,
    renderer: deps.renderer,
    canvas: deps.canvas,
    renderOptions: deps.renderOptions,
    bounds: deps.bounds,
    roomCode: session.roomCode,
    ...(session.displayName !== undefined ? { displayName: session.displayName } : {}),
    ...(deps.callbacks !== undefined ? { callbacks: deps.callbacks } : {}),
  });
  return { host, mode: 'multiplayer', fellBack: false };
}
