/**
 * Pure join-in-progress decision (task 16.9, Requirement 16.3).
 *
 * design.md "State Broadcaster (≥15Hz)": the server "sends a full authoritative
 * snapshot to any Client that joins a Round in progress" so the late joiner
 * "renders the same play state as existing Players" (Requirement 16.3).
 *
 * Whether a freshly-admitted client should be sent an immediate full snapshot is
 * a pure function of the Room's current {@link RoundState}, extracted here so it
 * is unit-testable without a socket or a running loop. The transport
 * ({@link GameServer}) calls {@link shouldSendJoinSnapshot} right after admitting
 * a player and, when true, sends `serializeServerMessage({ type:'snapshot', ... })`
 * built from `game.snapshot()`.
 *
 * Decision: a Round is "in progress" exactly while it is `'playing'` — that is
 * the only state with live falling letters whose authoritative positions a late
 * joiner must be hydrated with to match existing Players. In `'lobby'`,
 * `'resolving'`, `'ready'`, and `'resolve_failed'` there is no in-progress play
 * to mirror (the joiner sees the same pre-round UI as everyone else), and
 * `'scoring'` is delivered via the `roundState` message carrying the finalized
 * result (Requirement 10.4), not a physics snapshot. The joiner still always
 * receives `welcome` + `roster` regardless; this decision is solely about the
 * extra authoritative physics `snapshot`.
 */

import type { RoundState } from '@glitch/core';

/**
 * Whether a client joining while the Room is in `state` must be sent a full
 * authoritative snapshot to mirror existing Players (Requirement 16.3).
 *
 * Returns `true` iff `state === 'playing'` — the only "Round in progress" state
 * with live letter positions to hydrate. All other states return `false`.
 */
export function shouldSendJoinSnapshot(state: RoundState): boolean {
  return state === 'playing';
}
