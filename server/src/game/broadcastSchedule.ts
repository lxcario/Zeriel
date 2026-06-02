/**
 * Pure broadcast-rate decision for the State Broadcaster (task 16.9).
 *
 * design.md "State Broadcaster (≥15Hz)": the server broadcasts authoritative
 * Rope_Letter positions, Ownership_Lock states, cursor presence, and provisional
 * scores to all Room Clients at **at least 15 updates per second** (Requirements
 * 16.1, 2.4, 9.3). The authoritative tick runs at ~30Hz (Requirement 14.6), so
 * the broadcaster is driven from the SAME tick loop but emits at a (configurable)
 * fraction of it — by default every tick, which at 30Hz comfortably exceeds the
 * 15Hz floor.
 *
 * The decision "is it time to broadcast yet?" is extracted here as a pure
 * function so the ≥15Hz guarantee is unit/property-testable WITHOUT real timers
 * or real sockets. The transport ({@link StateBroadcaster}) injects a clock and
 * calls {@link shouldBroadcast} each tick; the actual `ws` send is separate.
 */

/** The ≥15 updates/sec floor mandated by Requirements 16.1 / 2.4 / 9.3. */
export const MIN_BROADCAST_HZ = 15;

/**
 * Maximum interval (ms) between broadcasts that still satisfies the ≥15Hz floor.
 * `1000 / 15 ≈ 66.67ms`. A broadcast cadence whose interval is `<=` this value
 * meets the requirement.
 */
export const MAX_BROADCAST_INTERVAL_MS = 1000 / MIN_BROADCAST_HZ;

/**
 * Decide whether a broadcast is due at `nowMs`, given the time of the last
 * broadcast and the target minimum interval.
 *
 * A broadcast is due when at least `intervalMs` has elapsed since the last one
 * (`nowMs - lastBroadcastMs >= intervalMs`). Passing `lastBroadcastMs = null`
 * (no prior broadcast) always returns `true` so the first eligible tick emits an
 * initial snapshot.
 *
 * To actually MEET the ≥15Hz floor the caller must choose
 * `intervalMs <= {@link MAX_BROADCAST_INTERVAL_MS}` AND wake at least that often;
 * {@link broadcastIntervalForHz} converts a target Hz into such an interval.
 *
 * Defensive: a non-finite/negative `intervalMs` is treated as `0` (always due);
 * a non-finite `nowMs` is treated as not-due (cannot reason about time).
 *
 * @param lastBroadcastMs Time of the previous broadcast, or `null` if none yet.
 * @param nowMs           Current monotonic time, in ms.
 * @param intervalMs      Minimum spacing between broadcasts, in ms.
 */
export function shouldBroadcast(
  lastBroadcastMs: number | null,
  nowMs: number,
  intervalMs: number,
): boolean {
  if (!Number.isFinite(nowMs)) return false;
  if (lastBroadcastMs === null) return true;
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 0;
  return nowMs - lastBroadcastMs >= interval;
}

/**
 * Convert a target broadcast rate in Hz into the minimum inter-broadcast
 * interval in ms (`1000 / hz`). A non-positive/non-finite `hz` falls back to the
 * {@link MIN_BROADCAST_HZ} floor so the result never exceeds
 * {@link MAX_BROADCAST_INTERVAL_MS}.
 */
export function broadcastIntervalForHz(hz: number): number {
  const safeHz = Number.isFinite(hz) && hz > 0 ? hz : MIN_BROADCAST_HZ;
  return 1000 / safeHz;
}

/**
 * Whether a steady broadcast cadence of one emit per `intervalMs` satisfies the
 * ≥15Hz floor (Requirements 16.1, 2.4, 9.3). True iff `intervalMs > 0` and
 * `intervalMs <= {@link MAX_BROADCAST_INTERVAL_MS}` (with a small epsilon for
 * floating-point slack on the exact `1000/15` boundary).
 *
 * Used by tests and by the broadcaster's construction guard to reject a cadence
 * that would silently under-broadcast.
 */
export function meetsMinBroadcastRate(intervalMs: number): boolean {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return false;
  const EPSILON = 1e-9;
  return intervalMs <= MAX_BROADCAST_INTERVAL_MS + EPSILON;
}
