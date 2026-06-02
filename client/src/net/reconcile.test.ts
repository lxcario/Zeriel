import { describe, it, expect } from 'vitest';
import { decideReconciliation, type PendingInput } from './reconcile.ts';
import type { Snapshot, PlayerId, GrabInput, CursorInput } from '@glitch/core';

/**
 * Unit tests for the pure reconciliation decision (task 17.3, Requirements 8.7,
 * 14.5, 16.2, 16.4). These pin the behavior the optional Property 24 (task 17.5)
 * covers exhaustively: contradicted predicted grabs are snapped (dropped),
 * acknowledged inputs are dropped, still-in-flight inputs survive.
 */

const SELF: PlayerId = 'me';
const OTHER: PlayerId = 'other';

/** A snapshot at `tick` with the given lock owners. */
function snapshotAt(tick: number, lockOwners: Record<string, PlayerId> = {}): Snapshot {
  return {
    tick,
    letters: [],
    locks: Object.entries(lockOwners).map(([letterId, ownerId]) => ({ letterId, ownerId })),
    cursors: [],
    provisionalScore: 0,
  };
}

function grab(letterId: string, clientTick: number, playerId: PlayerId = SELF): PendingInput {
  const input: GrabInput = { type: 'grab', playerId, letterId, clientTick };
  return { clientTick, input };
}

function cursor(clientTick: number): PendingInput {
  const input: CursorInput = { type: 'cursor', playerId: SELF, x: clientTick, y: clientTick };
  return { clientTick, input };
}

describe('decideReconciliation (task 17.3)', () => {
  it('snaps (drops) a predicted grab the authoritative snapshot contradicts (8.7)', () => {
    // We predicted grabbing L:0 at tick 5, but the snapshot (tick 6) shows OTHER owns it.
    const pending = [grab('L:0', 5)];
    const snap = snapshotAt(6, { 'L:0': OTHER });

    const decision = decideReconciliation(snap, pending, SELF);
    expect(decision.snapped).toEqual(['L:0']);
    expect(decision.reapply).toEqual([]);
  });

  it('keeps a still-in-flight grab the snapshot has not yet accounted for (16.4)', () => {
    // Grab issued at tick 10; snapshot only reflects up to tick 8 and shows no contradicting owner.
    const pending = [grab('L:0', 10)];
    const snap = snapshotAt(8);

    const decision = decideReconciliation(snap, pending, SELF);
    expect(decision.snapped).toEqual([]);
    expect(decision.reapply).toEqual(pending);
  });

  it('drops an acknowledged input whose tick the snapshot already covers (16.2)', () => {
    const pending = [cursor(3)];
    const snap = snapshotAt(5);

    const decision = decideReconciliation(snap, pending, SELF);
    expect(decision.reapply).toEqual([]);
    expect(decision.snapped).toEqual([]);
  });

  it('treats a self-owned grab in the snapshot as confirmed (kept if still in flight)', () => {
    // Snapshot shows WE own L:0 — that confirms our prediction, not a contradiction.
    const pending = [grab('L:0', 9)];
    const snap = snapshotAt(7, { 'L:0': SELF });

    const decision = decideReconciliation(snap, pending, SELF);
    expect(decision.snapped).toEqual([]);
    expect(decision.reapply).toEqual(pending);
  });

  it('handles a mixed queue deterministically in order', () => {
    const acked = cursor(2); // <= tick → dropped
    const contradicted = grab('L:0', 9); // owned by OTHER → snapped
    const inFlight = grab('L:1', 10); // still in flight, no contradiction → kept
    const pending = [acked, contradicted, inFlight];
    const snap = snapshotAt(8, { 'L:0': OTHER });

    const decision = decideReconciliation(snap, pending, SELF);
    expect(decision.snapped).toEqual(['L:0']);
    expect(decision.reapply).toEqual([inFlight]);
  });

  it('does not mutate the input queue', () => {
    const pending = [grab('L:0', 9), cursor(10)];
    const copy = [...pending];
    decideReconciliation(snapshotAt(8, { 'L:0': OTHER }), pending, SELF);
    expect(pending).toEqual(copy);
  });

  it('ignores another player`s grab in the pending queue (only self-grabs predict)', () => {
    // An input attributed to OTHER should never be "snapped" as our prediction.
    const pending = [grab('L:0', 10, OTHER)];
    const snap = snapshotAt(8, { 'L:0': OTHER });
    const decision = decideReconciliation(snap, pending, SELF);
    expect(decision.snapped).toEqual([]);
    // Still in flight (tick 10 > 8) so it is kept rather than dropped.
    expect(decision.reapply).toEqual(pending);
  });
});
