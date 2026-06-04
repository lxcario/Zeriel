/**
 * @glitch/server — authoritative Node WebSocket Game_Server entry point.
 *
 * Wires the three Game_Server subsystems (design.md "Game_Server Subsystems"):
 * - the pure {@link RoomManager} (task 16.1) — Room/identity/lock lifecycle;
 * - the per-Room authoritative {@link GameRoom} — the 30Hz `GameCore` tick +
 *   State Broadcaster decisions (task 16.9);
 * - the {@link GameServer} orchestrator + `ws` transport (task 16.9).
 *
 * The orchestrator/routing logic is transport-agnostic (it routes over the tiny
 * `ClientSocket` abstraction with an injected clock/timer), so it is fully
 * unit-testable without opening a port. The `ws` listener
 * ({@link startWsGameServer}) is the ONLY thing that binds a socket and it runs
 * only when this module is executed directly (not on import).
 *
 * NETWORK BINDING (security): the listener binds to loopback `127.0.0.1` by
 * default (NOT exposed to the network). Access is Room_Code-gated with no
 * accounts (Requirement 1.6). See `wsServer.ts` for the full security note.
 */
import { CORE_PACKAGE, type GameConfig } from '@glitch/core';
import { pathToFileURL } from 'node:url';
import { startWsGameServer, DEFAULT_BIND_HOST } from './net/index.js';

// Re-export the server subsystems so consumers/tests import from one surface.
export { RoomManager } from './rooms/RoomManager.js';
export type { PlayerInit, JoinResult, ReconnectToken, RoomManagerOptions } from './rooms/RoomManager.js';
export * from './game/index.js';
export * from './net/index.js';

export function describeServer(): string {
  return `Zeriel Game_Server using ${CORE_PACKAGE}`;
}

/** Default authoritative physics/spawn/session config for a listening server. */
function defaultGameConfig(): GameConfig {
  return {
    gravity: { x: 0, y: 980 },
    damping: 0.98,
    constraintIterations: 8,
    subSteps: 1,
    defaultStiffness: 0.8,
    constraintTolerance: 0.5,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    restitution: 0.3,
    colliderRadius: 10,
    spawnBand: { x: 0, y: 0, width: 800, height: 120 },
    placementTolerance: 24,
    maxPlayers: 8,
    stepMs: 1000 / 30,
  };
}

// Only bind a listening socket when executed directly (NOT when imported by
// tests). Reads PORT/HOST from the environment; HOST defaults to loopback.
// Compared via pathToFileURL so the guard is correct on Windows too.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const port = Number.parseInt(process.env.PORT ?? '8080', 10);
  const host = process.env.HOST ?? DEFAULT_BIND_HOST;
  // eslint-disable-next-line no-console
  console.log(describeServer());
  startWsGameServer({
    gameConfig: defaultGameConfig(),
    port,
    host,
    // No round resolver is wired here — lyrics/audio are resolved client-side in
    // the design; a host integration supplies `resolveRound` to enable startRound.
  });
}
