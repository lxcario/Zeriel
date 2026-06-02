/**
 * Barrel for the client `net` module (the Net Client / synchronization layer).
 *
 * Exports the pure clock-offset estimator (task 17.1), the pure message codec,
 * the pure prediction-decision and reconciliation functions, and the
 * {@link NetClient} that wires them to a prediction `GameCore` over an injectable
 * transport (task 17.3). The future `RemoteGameHost` (task 17.6) and the optional
 * property tests (17.2/17.4/17.5) import from this single entry point.
 */

// Clock-offset estimation (task 17.1) — reused by the Net Client handshake.
export {
  estimateOffsetSample,
  estimateClockOffset,
  median,
  toServerTime,
  toClientTime,
  type HandshakeSample,
  type OffsetEstimate,
  type AggregateOffsetEstimate,
} from './clockOffset.ts';

// Pure message protocol codec (task 17.3) — the client half of the wire format.
export {
  serializeClientMessage,
  parseServerMessage,
  parseSnapshot,
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
} from './protocol.ts';

// Pure prediction decision (task 17.3 / Property 23).
export {
  shouldPredictGrab,
  visibleLocksFromSnapshot,
  type VisibleLocks,
} from './predictGrab.ts';

// Pure reconciliation decision (task 17.3 / Property 24).
export {
  decideReconciliation,
  type PendingInput,
  type ReconcileDecision,
} from './reconcile.ts';

// The Net Client itself — protocol + prediction + reconciliation over a socket.
export {
  NetClient,
  type NetSocket,
  type NetClientConfig,
  type NetClientCallbacks,
} from './NetClient.ts';
