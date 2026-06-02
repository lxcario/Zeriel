/**
 * Barrel for the server `game` module (task 16.9).
 *
 * Exports the per-Room authoritative simulation ({@link GameRoom}) and the PURE,
 * independently-testable decision helpers it builds on: fixed-timestep tick
 * planning ({@link planServerTicks}), the ≥15Hz broadcast-rate decision
 * ({@link shouldBroadcast}), and the join-in-progress snapshot decision
 * ({@link shouldSendJoinSnapshot}). Keeping the decisions pure (no timers, no
 * sockets) is what makes the 30Hz tick + ≥15Hz broadcast guarantees testable.
 */

export {
  GameRoom,
  DEFAULT_DROP_WINDOW_MS,
  type GameRoomConfig,
  type RoundSetup,
} from './GameRoom.js';

export {
  planServerTicks,
  DEFAULT_SERVER_STEP_MS,
  DEFAULT_MAX_TICKS_PER_WAKE,
  type ServerTickPlan,
} from './tickPlan.js';

export {
  shouldBroadcast,
  broadcastIntervalForHz,
  meetsMinBroadcastRate,
  MIN_BROADCAST_HZ,
  MAX_BROADCAST_INTERVAL_MS,
} from './broadcastSchedule.js';

export { shouldSendJoinSnapshot } from './joinInProgress.js';
