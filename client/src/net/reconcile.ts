/**
 * Client reconciliation decision (task 17.3) — the pure target of the optional
 * Property 24.
 *
 * design.md "Client-side prediction and reconciliation":
 *
 * > **Server reconciliation**: Each authoritative snapshot carries Rope_Letter
 * > positions and Ownership_Lock states. The Client overwrites authoritative
 * > fields and re-applies any still-pending local inputs on top (Requirements
 * > 16.2, 16.4). If the server outcome contradicts the prediction — e.g., a
 * > locally predicted grab the server denies, or a locally denied grab the
 * > server confirms — the Client snaps the affected letter to authoritative
 * > state (Requirement 8.7). Letters the Client does not own are driven purely
 * > by interpolated authoritative updates (Requirement 14.5).
 *
 * design.md "Reconciliation safety": *On any client/server disagreement about a
 * grabbed letter, the server position wins; the Client snaps to authoritative
 * state (Requirements 8.7, 16.4, Property 24).*
 *
 * Property 24: *For any* client prediction state and any authoritative snapshot,
 * after the Client reconciles, every grabbed Rope_Letter's owner and position
 * equal the authoritative snapshot's values, and non-owned letters follow the
 * authoritative state.
 *
 * ## The three-part reconcile, and what is pure here
 * The Net Client reconciles each snapshot in three steps (see
 * `NetClient.onSnapshot`):
 *
 *   1. `core.applySnapshot(snapshot)` — overwrite authoritative fields
 *      (positions, locks, cursors, placedSlot, tick, provisional score). After
 *      this, the prediction `GameCore` already MATCHES the snapshot exactly.
 *   2. Re-apply still-pending local inputs on top (Requirements 16.2, 16.4).
 *   3. Snap contradicted predicted grabs to authoritative state (Requirement
 *      8.7) — i.e. do NOT re-apply a grab the authoritative state contradicts.
 *
 * Steps 2 and 3 are a SINGLE pure decision over the pending-input queue and the
 * snapshot — {@link decideReconciliation}. It computes which pending inputs to
 * re-apply and which predicted grabs were contradicted (and thus snapped),
 * WITHOUT touching the `GameCore`. Keeping it pure is what makes Property 24
 * directly checkable (task 17.5): the test can assert the decision drops exactly
 * the contradicted grabs, and that re-applying the survivors over an
 * already-applied snapshot leaves every authoritative lock intact.
 *
 * ## Why positions are safe by construction
 * `GameCore.applyInput` records cursors and toggles Ownership_Locks but NEVER
 * moves particles (steering happens in `tick`). So re-applying any surviving
 * pending input after `applySnapshot` cannot move a letter off its authoritative
 * position — every letter's position still equals the snapshot's. The only thing
 * re-application can change is an as-yet-unacknowledged local lock, which is the
 * legitimate prediction-ahead-of-server case, not a disagreement.
 */

import type { Snapshot, PlayerInput, PlayerId, GrabInput, LockSnapshot } from '@glitch/core';

/**
 * One locally-applied input awaiting server acknowledgement. The Net Client
 * applies the input to its prediction `GameCore` immediately (optimistic /
 * predicted) and keeps it here until a snapshot supersedes it.
 *
 * `clientTick` is a monotonically increasing sequence the Net Client assigns to
 * EVERY pending input (not just grabs) so reconciliation can decide, uniformly,
 * whether the authoritative snapshot has already accounted for it: an input with
 * `clientTick <= snapshot.tick` is considered acknowledged (its effect is in the
 * snapshot) and is dropped; one with `clientTick > snapshot.tick` is still
 * in-flight and is re-applied. For a {@link GrabInput} this is exactly the
 * `clientTick` carried on the C→S `grab` message.
 */
export interface PendingInput {
  /** Monotonic client sequence for this input (the grab message's `clientTick`). */
  clientTick: number;
  /** The input that was applied locally and sent to the server. */
  input: PlayerInput;
}

/**
 * The outcome of {@link decideReconciliation}: which pending inputs survive to
 * be re-applied on top of the freshly-applied snapshot, and which predicted
 * grabs were contradicted by the authoritative state (and therefore snapped —
 * left at authoritative and dropped from the queue).
 */
export interface ReconcileDecision {
  /**
   * Pending inputs to re-apply (in their original order) after
   * `GameCore.applySnapshot`. These are the still-in-flight inputs the snapshot
   * has not yet accounted for and that the authoritative state does not
   * contradict. This list also becomes the Net Client's NEW pending queue.
   */
  reapply: PendingInput[];
  /**
   * Letter ids of predicted grabs that the authoritative snapshot contradicts
   * (the snapshot shows the letter owned by another Player) and that were
   * therefore snapped to authoritative state and removed from the queue
   * (Requirement 8.7). Informational — the snap itself is already realized by
   * `applySnapshot`; the Net Client reports these so the UI can clear any
   * "grabbing" affordance (Requirement 8.2). Deterministic order: the order the
   * contradicted grabs appeared in the pending queue.
   */
  snapped: string[];
}

/**
 * Build a `letterId → ownerId` lookup from a snapshot's `locks[]`. Pure; one
 * fresh map. Only locked letters appear, so a missing key means "unlocked in the
 * authoritative state".
 */
function ownerByLetter(locks: readonly LockSnapshot[]): Map<string, PlayerId> {
  const map = new Map<string, PlayerId>();
  for (const lock of locks) map.set(lock.letterId, lock.ownerId);
  return map;
}

/**
 * Decide how to reconcile the pending-input queue against an authoritative
 * snapshot (Requirements 8.7, 14.5, 16.2, 16.4 / Property 24). PURE: reads its
 * arguments and allocates the result; never mutates the inputs and never touches
 * a `GameCore`.
 *
 * For each {@link PendingInput}, in queue order:
 *
 * - **Contradicted predicted grab** — the input is a `grab` by `selfId` and the
 *   snapshot shows that letter owned by a DIFFERENT Player. The prediction was
 *   wrong; the letter is snapped to authoritative (recorded in
 *   {@link ReconcileDecision.snapped}) and the grab is DROPPED (not re-applied),
 *   so the server's owner wins (Requirement 8.7, design "Reconciliation
 *   safety").
 *
 * - **Acknowledged input** — `clientTick <= snapshot.tick`. The snapshot was
 *   produced at or after this input's tick, so its authoritative effect (if any)
 *   is already reflected by `applySnapshot`. The input is DROPPED and the
 *   authoritative state is trusted (Requirement 16.2).
 *
 * - **Still-in-flight input** — `clientTick > snapshot.tick` and not
 *   contradicted. The server has not yet accounted for it, so it is KEPT
 *   (re-applied on top of the snapshot, preserving local responsiveness —
 *   Requirements 16.4, 14.4).
 *
 * The resulting {@link ReconcileDecision.reapply} list, re-applied in order over
 * a core that has just `applySnapshot`-ed `snapshot`, guarantees every
 * authoritative lock in `snapshot` remains intact (a contradicted self-grab is
 * never re-applied, and `GameCore.applyGrab` denies any grab on a letter locked
 * by another Player anyway), which is the safety half of Property 24.
 *
 * @param snapshot The authoritative snapshot just received.
 * @param pending  The Net Client's current pending-input queue (in order).
 * @param selfId   This Client's Player_Id (whose grabs can be "predicted").
 */
export function decideReconciliation(
  snapshot: Snapshot,
  pending: readonly PendingInput[],
  selfId: PlayerId,
): ReconcileDecision {
  const owners = ownerByLetter(snapshot.locks);
  const reapply: PendingInput[] = [];
  const snapped: string[] = [];

  for (const entry of pending) {
    const { input, clientTick } = entry;

    if (isOwnGrab(input, selfId)) {
      const authoritativeOwner = owners.get(input.letterId);
      // Contradicted: authoritative state shows another owner → snap + drop.
      if (authoritativeOwner !== undefined && authoritativeOwner !== selfId) {
        snapped.push(input.letterId);
        continue;
      }
    }

    // Acknowledged (already reflected by the snapshot) → drop and trust authority.
    if (clientTick <= snapshot.tick) continue;

    // Still in flight and not contradicted → keep predicting it.
    reapply.push(entry);
  }

  return { reapply, snapped };
}

/** Narrow a {@link PlayerInput} to a {@link GrabInput} issued by `selfId`. */
function isOwnGrab(input: PlayerInput, selfId: PlayerId): input is GrabInput {
  return input.type === 'grab' && input.playerId === selfId;
}
