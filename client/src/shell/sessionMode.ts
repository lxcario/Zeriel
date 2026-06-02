/**
 * `SessionMode` — the shell-level abstraction that decides which {@link GameHost}
 * topology a Round runs under (task 18.1).
 *
 * Design references:
 * - design.md "Single-Player vs Multiplayer Topology": the SAME `GameCore` is
 *   driven by one of two hosts — a {@link LocalGameHost} (in-browser, no network)
 *   or a {@link RemoteGameHost} (WebSocket, server-authoritative + reconcile).
 * - Requirement 15.1/15.2: Single_Player_Mode completes a full Round with no
 *   multiplayer connection, and is the fallback when multiplayer is unavailable.
 * - Requirement 15.4: multiplayer LAYERS Room presence, Cursor sharing, and
 *   Ownership_Locks ON TOP of single-player gameplay WITHOUT changing the core
 *   ordering/scoring rules — the difference is purely the host, never the
 *   `GameCore`.
 *
 * This is intentionally plain data: the shell carries a `SessionMode` value and
 * hands it to the pure {@link selectGameHost} factory, which returns the host to
 * use. Keeping the decision in data + a pure function (rather than branching
 * inside the React component) is what lets the mode-equivalence test (Property
 * 30, task 18.2) run an identical arrangement through both hosts.
 */

/**
 * A single-player session: one Player completes the Round locally with no
 * multiplayer connection (Requirement 15.1). This is also the value the shell
 * uses when multiplayer is disabled or unavailable (Requirement 15.4).
 */
export interface SinglePlayerSession {
  readonly kind: 'single-player';
}

/**
 * A multiplayer session: the Round connects to the Game_Server over a WebSocket,
 * layering Room presence, Cursor sharing, and Ownership_Locks on top of the same
 * gameplay (Requirements 15.4, 16.1). Carries everything the
 * {@link RemoteGameHost} needs to join its Room.
 */
export interface MultiplayerSession {
  readonly kind: 'multiplayer';
  /** The Room_Code to join (Requirements 1.3, 2.1). Empty → single-player fallback. */
  readonly roomCode: string;
  /** The WebSocket URL of the Game_Server. Empty → single-player fallback (15.4). */
  readonly socketUrl: string;
  /** Optional display name sent with the join; the server assigns a default if absent (2.2). */
  readonly displayName?: string;
}

/**
 * Which topology a Round runs under. The shell threads this through
 * `RoundScreen → RoundCanvas` and hands it to {@link selectGameHost}; the
 * Renderer and pointer-input wiring are mode-agnostic and never inspect it.
 */
export type SessionMode = SinglePlayerSession | MultiplayerSession;

/** The canonical single-player session value (Requirement 15.1). */
export const SINGLE_PLAYER_SESSION: SinglePlayerSession = { kind: 'single-player' };

/** Build a {@link SinglePlayerSession} (the default / fallback topology). */
export function singlePlayerSession(): SinglePlayerSession {
  return SINGLE_PLAYER_SESSION;
}

/**
 * Build a {@link MultiplayerSession} for `roomCode` on `socketUrl`. A blank
 * `roomCode`/`socketUrl` is allowed here but causes {@link selectGameHost} to
 * fall back to single-player (Requirement 15.4) — callers do not have to
 * pre-validate.
 */
export function multiplayerSession(
  roomCode: string,
  socketUrl: string,
  displayName?: string,
): MultiplayerSession {
  return {
    kind: 'multiplayer',
    roomCode,
    socketUrl,
    ...(displayName !== undefined ? { displayName } : {}),
  };
}
