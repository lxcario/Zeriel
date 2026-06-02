/**
 * In-round canvas host (task 14.1, host-switching added in task 18.1).
 *
 * Hosts the gameplay `<canvas>` during a Round and wires the resolved
 * {@link RoundPlan} into the full gameplay pipeline:
 *
 *   GameCore + AudioPlayer + Renderer + (Local|Remote)GameHost → canvas → Scorecard
 *
 * Design references:
 * - design.md "React UI Shell": "Hosts the `<canvas>` element during a Round but
 *   does not touch per-frame state." React owns only top-level state; the
 *   per-frame loop lives entirely in the active {@link GameHost} (Requirement 14.2).
 * - design.md "Single-Player vs Multiplayer Topology": a `LocalGameHost` runs
 *   `GameCore` in-browser with NO network; a `RemoteGameHost` connects over a
 *   WebSocket and reconciles authoritative snapshots. BOTH implement the same
 *   {@link GameHost} interface, so this surface swaps between them transparently
 *   — the Renderer and pointer-input wiring never inspect which host is active.
 * - Requirement 15.1/15.2/15.4: single-player is the baseline and the fallback;
 *   multiplayer LAYERS Room presence, Cursor sharing, and Ownership_Locks on top
 *   WITHOUT changing the core ordering/scoring rules. The host choice is the
 *   pure {@link selectGameHost} factory — the `GameCore` (ordering/scoring) is
 *   identical in both modes.
 * - Requirement 16.1: in multiplayer the roster/presence flows through the Net
 *   Client callbacks; this surface displays it minimally above the canvas.
 * - Requirement 18.3/18.4: the in-round play area uses the handmade aesthetic,
 *   NEVER the premium theme — this surface deliberately has no premium chrome.
 * - Requirement 8.1–8.4: pointer events translate to grab/release/cursor inputs
 *   via `host.applyInput` (identically in both modes).
 *
 * The audio player, renderer, transport, and host selection are all injectable
 * so the surface can be unit-tested without a real Web Audio graph, GPU canvas,
 * or WebSocket (mirroring the injection pattern across the codebase).
 */

import { useEffect, useRef, useState } from 'react';
import { GameCore } from '@glitch/core';
import type { RoundResult } from '@glitch/core';
import { CanvasRenderer, type Renderer } from '../render/index.ts';
import { WebAudioPlayer, type AudioPlayer } from '../audio/AudioPlayer.ts';
import type { GameHost } from '../host/index.ts';
import type { NetSocket, RosterEntry } from '../net/index.ts';
import {
  LOCAL_PLAYER_ID,
  PLAY_AREA,
  defaultGameConfig,
  defaultRenderOptions,
} from './config.ts';
import type { RoundPlan } from './resolveRound.ts';
import { singlePlayerSession, type SessionMode } from './sessionMode.ts';
import {
  selectGameHost,
  type HostSelection,
  type HostSelectionDeps,
} from './selectGameHost.ts';

/** Factory hooks so the host pipeline can be faked in tests. */
export interface RoundCanvasDeps {
  /** Build the gameplay Renderer; defaults to the real {@link CanvasRenderer}. */
  createRenderer?: () => Renderer;
  /** Build the Audio_Player; defaults to the real {@link WebAudioPlayer}. */
  createAudioPlayer?: () => AudioPlayer;
  /**
   * Multiplayer transport factory; defaults to the real WebSocket adapter.
   * Injected so a multiplayer Round can be driven with a fake socket in tests.
   */
  createSocket?: (url: string) => NetSocket;
  /**
   * Override the pure host-selection step; defaults to {@link selectGameHost}.
   * The mode-equivalence test (Property 30, task 18.2) uses this seam to route
   * an identical arrangement through both hosts.
   */
  selectHost?: (session: SessionMode, deps: HostSelectionDeps) => HostSelection;
  /** Deterministic seed for `GameCore` spawn jitter; defaults to a time seed. */
  seed?: number;
}

/** Props for {@link RoundCanvas}. */
export interface RoundCanvasProps {
  /** The resolved assets for this Round (audio + lyrics + track). */
  plan: RoundPlan;
  /**
   * The session topology to run this Round under (Requirements 15.1/15.4).
   * Defaults to a single-player session; a multiplayer session layers presence,
   * cursor sharing, and locks on top (falling back to single-player when the
   * connection is unavailable).
   */
  sessionMode?: SessionMode;
  /** Effective Reduce_Motion_Mode for the gameplay Renderer (Requirement 13.1). */
  reduceMotion: boolean;
  /** Called once the Round finalizes its result, to show the Scorecard (10.4). */
  onRoundComplete: (result: RoundResult) => void;
  /** Test/wiring injection hooks. */
  deps?: RoundCanvasDeps;
}

/**
 * Translate a pointer event's client coordinates into canvas-space play-area
 * coordinates, accounting for the canvas's on-screen size vs its bitmap size.
 */
function toPlayAreaPoint(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width > 0 ? canvas.width / rect.width : 1;
  const scaleY = rect.height > 0 ? canvas.height / rect.height : 1;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
  };
}

/**
 * Find the nearest grabbable letter to a play-area point, within a generous
 * radius. Ownership is enforced by the host/GameCore, so "grab the closest
 * letter" is the natural pointer-down behavior in both modes.
 */
function nearestLetterId(game: GameCore, x: number, y: number): string | null {
  let bestId: string | null = null;
  let bestDistSq = Infinity;
  for (const letter of game.letters) {
    let cx = 0;
    let cy = 0;
    const ps = letter.particles;
    if (ps.length === 0) continue;
    for (const p of ps) {
      cx += p.x.x;
      cy += p.x.y;
    }
    cx /= ps.length;
    cy /= ps.length;
    const dx = cx - x;
    const dy = cy - y;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestId = letter.id;
    }
  }
  return bestId;
}

/** The single local player's id used for input attribution in single-player. */
const POINTER_PLAYER_ID = LOCAL_PLAYER_ID;

/**
 * The in-round gameplay surface. Constructs the gameplay pipeline on mount,
 * SELECTS the host for the active session (single-player local vs multiplayer
 * remote, with a single-player fallback), starts it, forwards pointer input to
 * `host.applyInput`, polls for the finalized Round result, and tears everything
 * down on unmount.
 */
export function RoundCanvas({
  plan,
  sessionMode,
  reduceMotion,
  onRoundComplete,
  deps,
}: RoundCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Mutable refs for the live pipeline (never trigger React re-render).
  const hostRef = useRef<GameHost | null>(null);
  const gameRef = useRef<GameCore | null>(null);
  const grabbedRef = useRef<string | null>(null);
  const completedRef = useRef(false);
  const onCompleteRef = useRef(onRoundComplete);
  onCompleteRef.current = onRoundComplete;

  // Multiplayer presence (Requirements 2.3, 16.1). Stays empty in single-player.
  const [roster, setRoster] = useState<readonly RosterEntry[]>([]);
  // Whether a requested multiplayer session fell back to single-player (15.4).
  const [fellBackToLocal, setFellBackToLocal] = useState(false);

  const session = sessionMode ?? singlePlayerSession();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const createRenderer = deps?.createRenderer ?? (() => new CanvasRenderer());
    const createAudioPlayer = deps?.createAudioPlayer ?? (() => new WebAudioPlayer());
    const selectHost = deps?.selectHost ?? selectGameHost;
    const seed = deps?.seed ?? (Date.now() >>> 0);

    const config = defaultGameConfig();
    const gameCore = new GameCore(seed, config);
    gameCore.setTrackTitle(plan.candidate.title);
    gameRef.current = gameCore;

    const renderer = createRenderer();
    const audioPlayer = createAudioPlayer();

    // Begin loading the resolved stream (Requirement 5.1). The host starts the
    // loop immediately and renders even before audio is ready; playback begins
    // from the start on host.start() (Requirement 5.2).
    void audioPlayer.load(plan.streamUrl, plan.corsReliable).catch(() => {
      /* load failures surface via the stall watchdog / onStall (5.4) */
    });

    // Reset presence for this Round before (possibly) wiring the roster stream.
    setRoster([]);

    // The pure host-selection step: single-player → LocalGameHost; multiplayer →
    // RemoteGameHost, layering presence/cursor/locks on top without altering the
    // GameCore (Requirements 15.4, 16.1). Falls back to LocalGameHost when the
    // multiplayer connection is unavailable (Requirement 15.4).
    const selection = selectHost(session, {
      gameCore,
      lines: plan.lines,
      audioPlayer,
      renderer,
      canvas,
      renderOptions: defaultRenderOptions(reduceMotion),
      bounds: config.bounds,
      ...(deps?.createSocket ? { createSocket: deps.createSocket } : {}),
      callbacks: {
        // Surface Room presence minimally (Requirement 16.1); never fires in
        // single-player since no Net Client is created there.
        onRoster: (players) => setRoster(players),
      },
    });

    setFellBackToLocal(selection.fellBack);

    const host = selection.host;
    hostRef.current = host;
    host.start();

    // Poll for round completion. The host finalizes the result BEFORE it becomes
    // observable (Requirement 10.4); we surface it exactly once.
    const poll = window.setInterval(() => {
      if (completedRef.current) return;
      const result = host.getRoundResult();
      if (result !== null) {
        completedRef.current = true;
        window.clearInterval(poll);
        onCompleteRef.current(result);
      }
    }, 100);

    return () => {
      window.clearInterval(poll);
      host.dispose();
      hostRef.current = null;
      gameRef.current = null;
      grabbedRef.current = null;
    };
    // Re-create the pipeline only when the plan or the session topology changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, session]);

  // ---- Pointer → grab/release/cursor inputs (Requirements 8.1–8.4) ----------
  // These are mode-agnostic: the active host (local or remote) decides whether
  // the input is applied locally or sent over the wire and predicted.

  const emitCursor = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    const { x, y } = toPlayAreaPoint(canvas, clientX, clientY);
    host.applyInput({ type: 'cursor', playerId: POINTER_PLAYER_ID, x, y });
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    const game = gameRef.current;
    if (!canvas || !host || !game) return;
    const { x, y } = toPlayAreaPoint(canvas, e.clientX, e.clientY);
    // Move the cursor first so the grabbed letter steers toward it immediately.
    host.applyInput({ type: 'cursor', playerId: POINTER_PLAYER_ID, x, y });
    const letterId = nearestLetterId(game, x, y);
    if (letterId !== null) {
      const outcome = host.applyInput({
        type: 'grab',
        playerId: POINTER_PLAYER_ID,
        letterId,
        clientTick: 0,
      });
      if (outcome.type === 'grab' && outcome.granted) {
        grabbedRef.current = letterId;
        canvas.setPointerCapture?.(e.pointerId);
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    emitCursor(e.clientX, e.clientY);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const host = hostRef.current;
    const grabbed = grabbedRef.current;
    if (host && grabbed !== null) {
      host.applyInput({ type: 'release', playerId: POINTER_PLAYER_ID, letterId: grabbed });
      grabbedRef.current = null;
    }
    canvasRef.current?.releasePointerCapture?.(e.pointerId);
  };

  const showRoster = session.kind === 'multiplayer' && !fellBackToLocal && roster.length > 0;

  return (
    <div className="flex w-full flex-col items-center gap-4">
      {showRoster && (
        <ul
          aria-label="Players in this room"
          className="flex flex-wrap items-center justify-center gap-2 text-xs text-neutral-300"
        >
          {roster.map((player) => (
            <li
              key={player.playerId}
              className="rounded-full border border-neutral-700 bg-neutral-800/70 px-3 py-1"
            >
              {player.displayName}
              {player.isHost ? ' (host)' : ''}
            </li>
          ))}
        </ul>
      )}
      <canvas
        ref={canvasRef}
        width={PLAY_AREA.width}
        height={PLAY_AREA.height}
        role="img"
        aria-label={`Now playing: ${plan.candidate.title} by ${plan.candidate.artist}. Grab the falling letters and drag them into order.`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className="w-full max-w-3xl touch-none rounded-lg border-4 border-neutral-100 bg-neutral-900"
        style={{ aspectRatio: `${PLAY_AREA.width} / ${PLAY_AREA.height}` }}
      />
      <p className="text-sm text-neutral-400">
        {plan.lyricsFree
          ? 'Playing without synced lyrics.'
          : 'Drag the falling letters into the right order before the next line drops.'}
      </p>
    </div>
  );
}

export default RoundCanvas;
