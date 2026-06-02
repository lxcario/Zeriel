/**
 * Client-side grab prediction decision (task 17.3) — the pure target of the
 * optional Property 23.
 *
 * design.md "Client-side prediction and reconciliation":
 *
 * > **Prediction**: When a Player initiates a grab and the Client cannot already
 * > determine it will fail, the Client immediately assigns a local provisional
 * > lock and begins moving the letter in its prediction `GameCore`
 * > (Requirements 8.5, 14.4). When the Client *can* tell the grab will fail (the
 * > letter is visibly locked by another Player), it skips prediction
 * > (Requirement 8.6).
 *
 * Property 23: *For any* grab attempt, the Client applies client-side prediction
 * if and only if the target Rope_Letter is not already visibly locked by another
 * Player.
 *
 * ## Why this is its own pure module
 * The decision is a single boolean over the Client's LAST-KNOWN AUTHORITATIVE
 * lock state — not over the prediction copy, and not over anything mutated by
 * the act of predicting. Extracting it as a pure, side-effect-free function
 * makes the iff in Property 23 directly checkable with fast-check (task 17.4)
 * and keeps the Net Client's grab path trivial: decide, then act.
 *
 * "Visibly locked by another Player" is judged against the most recent
 * authoritative snapshot the Client has applied (the `locks[]` it last saw),
 * because that is the only lock state the Client can SEE. A lock the Client has
 * not yet been told about is, by definition, not yet visible — predicting
 * against it is exactly the case Requirement 8.7 reconciliation later corrects.
 */

import type { PlayerId, LockSnapshot } from '@glitch/core';

/**
 * The Client's view of which letters are locked, as of the last authoritative
 * snapshot. A map from `letterId` → owning {@link PlayerId}. A letter absent
 * from the map is unlocked as far as the Client can see.
 *
 * This is the "visible lock state" — what {@link shouldPredictGrab} reasons over.
 * It is intentionally a read-only lookup so the decision cannot mutate it.
 */
export type VisibleLocks = ReadonlyMap<string, PlayerId>;

/**
 * Build a {@link VisibleLocks} lookup from a snapshot's `locks[]` array
 * (the {@link LockSnapshot} list the Client last applied). Pure; allocates one
 * fresh map. Only locked letters appear in `locks`, so the resulting map's keys
 * are exactly the visibly-locked letters.
 */
export function visibleLocksFromSnapshot(locks: readonly LockSnapshot[]): Map<string, PlayerId> {
  const map = new Map<string, PlayerId>();
  for (const lock of locks) map.set(lock.letterId, lock.ownerId);
  return map;
}

/**
 * Decide whether the Client should apply client-side prediction to a grab
 * (Requirements 8.5, 8.6 / Property 23).
 *
 * Returns `true` (predict) IFF the target letter is NOT visibly locked by
 * ANOTHER Player, per the Client's last-known authoritative lock state:
 *
 * - target unlocked (absent from {@link locks})            → predict (`true`).
 * - target locked by THIS player (`requesterId`)           → predict (`true`):
 *   a re-grab of a letter the Client already owns is not a visible failure; the
 *   server treats a same-owner re-grab as idempotent (see `GameCore.applyGrab`).
 * - target visibly locked by a DIFFERENT player            → skip (`false`):
 *   the Client can determine in advance the grab will be denied (8.6), so it
 *   does not begin moving the letter locally.
 *
 * Pure and total: depends only on its arguments and never mutates them.
 *
 * @param locks       The Client's visible lock state (last applied snapshot).
 * @param letterId    The target Rope_Letter id.
 * @param requesterId The Player attempting the grab (this Client's player id).
 */
export function shouldPredictGrab(
  locks: VisibleLocks,
  letterId: string,
  requesterId: PlayerId,
): boolean {
  const owner = locks.get(letterId);
  // Unlocked, or locked by us → no visible obstacle, so predict.
  if (owner === undefined || owner === requesterId) return true;
  // Visibly locked by another player → the grab will fail; skip prediction.
  return false;
}
