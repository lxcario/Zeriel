/**
 * Barrel for the server `net` module (task 16.9).
 *
 * Exports the transport-agnostic authoritative orchestrator ({@link GameServer}),
 * the {@link ClientSocket} abstraction it routes over, the pure message protocol
 * (types + (de)serialization), and the `ws` adapter/listener
 * ({@link startWsGameServer}). The protocol/routing logic depends only on
 * {@link ClientSocket} + an injected clock/timer, so it is unit-testable with
 * fakes; `ws` is isolated entirely in `wsServer.ts`.
 */

export {
  GameServer,
  type GameServerOptions,
  type RoundSetupResolver,
  type CreatedRoom,
} from './GameServer.js';

export type { ClientSocket, ConnectionId } from './ClientSocket.js';

export {
  parseClientMessage,
  serializeServerMessage,
  type ClientMessage,
  type ServerMessage,
  type JoinMessage,
  type CursorMessage,
  type GrabMessage,
  type ReleaseMessage,
  type StartRoundMessage,
  type WelcomeMessage,
  type RosterMessage,
  type RosterEntry,
  type SnapshotMessage,
  type GrabResultMessage,
  type RoundStateMessage,
} from './protocol.js';

export {
  startWsGameServer,
  wsClientSocket,
  DEFAULT_BIND_HOST,
  type WsServerOptions,
  type WsGameServerHandle,
} from './wsServer.js';
