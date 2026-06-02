import { describe, it, expect } from 'vitest';
import type { GameConfig, LyricLine, RopeLetter } from '../types/index.js';
import { GameCore } from './index.js';

/**
 * Smoke unit tests for task 4.12: the deterministic tick sequence +
 * snapshot/applySnapshot round trip.
 *
 * These prove the core guarantees of the task:
 *  - the full step order actually runs physics — a free letter falls under
 *    gravity across ticks (steps 3–5) (Requirement 7.6 / design tick ordering);
 *  - a held grabbed node is re-anchored to its owner's cursor AFTER bounds, so
 *    it equals the cursor even when the cursor is OUTSIDE the play-area bounds
 *    (Requirement 8.3 — the documented post-bounds re-steer);
 *  - distance constraints keep a 2-node chain near its rest length after ticks
 *    (Requirement 7.3);
 *  - `currentTick` advances exactly once per `tick()` and is exposed by
 *    `snapshot().tick`;
 *  - `snapshot()` now populates `cursors` (Requirement 2.4) and the tick number;
 *  - `applySnapshot()` reconciles a SECOND GameCore (same spawned letters) so it
 *    reproduces letter positions, Ownership_Locks, cursors, and the provisional
 *    score (Requirements 16.2, 16.3), and skips snapshot letters it has never
 *    seen without throwing.
 *
 * The dedicated property test (Property 37, task 4.13) is optional and is NOT
 * written here.
 */

/** A representative config (mirrors the other GameCore tests). */
function makeConfig(): GameConfig {
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

/** Build a fresh LyricLine with the empty `solutionSlots` the LRC parser emits. */
function makeLine(id: string, text: string): LyricLine {
  return { id, startMs: 0, text, solutionSlots: [] };
}

const STEP = 1000 / 30;

/** Centroid (mean of particle `x`) of a rope-letter — its representative position. */
function centroid(letter: RopeLetter): { x: number; y: number } {
  let cx = 0;
  let cy = 0;
  for (const p of letter.particles) {
    cx += p.x.x;
    cy += p.x.y;
  }
  return { x: cx / letter.particles.length, y: cy / letter.particles.length };
}

/** Euclidean distance between the two nodes of a 2-particle chain. */
function chainLength(letter: RopeLetter): number {
  const [a, b] = letter.particles;
  if (!a || !b) throw new Error('expected a 2-particle chain');
  return Math.hypot(b.x.x - a.x.x, b.x.y - a.x.y);
}

/**
 * Teleport a letter's 2-node chain so its centroid sits at `pos` (mirrors the
 * scoring test helper) with zero implicit velocity (`prev === x`).
 */
function placeLetterAt(letter: RopeLetter, pos: { x: number; y: number }): void {
  const [a, b] = letter.particles;
  if (!a || !b) throw new Error('expected a 2-particle chain');
  const halfLen = Math.abs(b.x.x - a.x.x) / 2;
  a.x.x = pos.x - halfLen;
  a.x.y = pos.y;
  b.x.x = pos.x + halfLen;
  b.x.y = pos.y;
  a.prev.x = a.x.x;
  a.prev.y = a.x.y;
  b.prev.x = b.x.x;
  b.prev.y = b.x.y;
}

describe('GameCore.tick — deterministic physics sequence (task 4.12, Req 7.6)', () => {
  it('makes a free letter fall under gravity across ticks (y increases)', () => {
    const core = new GameCore(1, makeConfig());
    core.spawnLine(makeLine('L', 'hello')); // single word => exactly one letter, no overlap.

    const letter = core.letters[0]!;
    const yBefore = centroid(letter).y;

    for (let i = 0; i < 5; i++) core.tick(STEP);

    const yAfter = centroid(letter).y;
    expect(yAfter).toBeGreaterThan(yBefore); // gravity (steps 3–5) actually ran.
    // Still finite + in-bounds (no explosion, bounds clamp holds).
    expect(Number.isFinite(yAfter)).toBe(true);
    expect(yAfter).toBeLessThanOrEqual(makeConfig().bounds.y + makeConfig().bounds.height);
  });

  it('keeps a held grabbed node at its owner cursor even when the cursor is OUT of bounds (Req 8.3)', () => {
    const core = new GameCore(1, makeConfig());
    core.spawnLine(makeLine('L', 'one two'));

    core.applyInput({ type: 'grab', playerId: 'p1', letterId: 'L:0', clientTick: 0 });
    // Cursor far outside the 0..800 x 0..600 play area on both axes.
    const cursor = { x: -500, y: 1200 };
    core.applyInput({ type: 'cursor', playerId: 'p1', x: cursor.x, y: cursor.y });

    core.tick(STEP);

    const node = core.letters[0]!.particles[0]!;
    // The post-bounds re-anchor makes the cursor authoritative despite the clamp.
    expect(node.x).toEqual({ x: -500, y: 1200 });
    expect(node.prev).toEqual({ x: -500, y: 1200 });
    expect(node.pinned).toBe(true);
    expect(node.invMass).toBe(0);
  });

  it('preserves the chain rest length within a small tolerance after many ticks (Req 7.3)', () => {
    const core = new GameCore(1, makeConfig());
    core.spawnLine(makeLine('L', 'ab'));

    const letter = core.letters[0]!;
    const restLength = letter.constraints[0]!.restLength;

    // Anchor node 0 at a fixed in-bounds cursor so node 1 dangles under gravity,
    // genuinely loading the distance constraint, then let it settle.
    core.applyInput({ type: 'grab', playerId: 'p1', letterId: 'L:0', clientTick: 0 });
    core.applyInput({ type: 'cursor', playerId: 'p1', x: 400, y: 300 });
    for (let i = 0; i < 120; i++) core.tick(STEP);

    const len = chainLength(letter);
    // "Near" rest length: the relaxation keeps the loaded chain close to L.
    expect(Math.abs(len - restLength)).toBeLessThanOrEqual(restLength * 0.2);
  });

  it('advances currentTick exactly once per tick() (exposed via snapshot().tick)', () => {
    const core = new GameCore(1, makeConfig());
    core.spawnLine(makeLine('L', 'a b c'));

    expect(core.snapshot().tick).toBe(0);
    core.tick(STEP);
    expect(core.snapshot().tick).toBe(1);
    core.tick(STEP);
    core.tick(STEP);
    expect(core.snapshot().tick).toBe(3);
  });

  it('runs the configured sub-steps without breaking determinism or the held-node anchor', () => {
    const config = makeConfig();
    config.subSteps = 4; // exercise the sub-stepping branch.
    const core = new GameCore(1, config);
    core.spawnLine(makeLine('L', 'one two'));

    core.applyInput({ type: 'grab', playerId: 'p1', letterId: 'L:0', clientTick: 0 });
    core.applyInput({ type: 'cursor', playerId: 'p1', x: 250, y: 175 });
    core.tick(STEP);

    // Held node still glued to the cursor across the smaller sub-steps.
    expect(core.letters[0]!.particles[0]!.x).toEqual({ x: 250, y: 175 });

    // Determinism: same seed + config + inputs reproduces identical state.
    const core2 = new GameCore(1, config);
    core2.spawnLine(makeLine('L', 'one two'));
    core2.applyInput({ type: 'grab', playerId: 'p1', letterId: 'L:0', clientTick: 0 });
    core2.applyInput({ type: 'cursor', playerId: 'p1', x: 250, y: 175 });
    core2.tick(STEP);
    expect(core2.snapshot()).toEqual(core.snapshot());
  });
});

describe('GameCore.snapshot — cursors + tick (task 4.12, Req 2.4, 16.1)', () => {
  it('includes recorded cursors (copied, not aliased) and the tick number', () => {
    const core = new GameCore(1, makeConfig());
    core.spawnLine(makeLine('L', 'one two'));
    core.applyInput({ type: 'cursor', playerId: 'p1', x: 10, y: 20 });
    core.applyInput({ type: 'cursor', playerId: 'p2', x: 30, y: 40 });

    const snap = core.snapshot();
    expect(snap.tick).toBe(0);
    expect(snap.cursors).toContainEqual({ playerId: 'p1', cursor: { x: 10, y: 20 } });
    expect(snap.cursors).toContainEqual({ playerId: 'p2', cursor: { x: 30, y: 40 } });

    // Mutating the snapshot must not corrupt the engine (values are copied).
    snap.cursors[0]!.cursor.x = 9999;
    core.applyInput({ type: 'grab', playerId: 'p1', letterId: 'L:0', clientTick: 0 });
    core.tick(STEP);
    expect(core.letters[0]!.particles[0]!.x).toEqual({ x: 10, y: 20 });
  });
});

describe('GameCore.applySnapshot — reconciliation round trip (task 4.12, Req 16.2, 16.3)', () => {
  it('reproduces letter positions, locks, cursors, tick, and provisional score on a second core', () => {
    // Source core: place two FREE letters correctly (provisional = 2), and grab
    // a THIRD letter to create a lock + a recorded cursor, then tick + snapshot.
    const source = new GameCore(7, makeConfig());
    source.spawnLine(makeLine('L', 'one two three'));

    // Correctly place letters for slots 0 and 1 (these are NOT grabbed, so the
    // tick leaves them resting within tolerance) so provisional score = 2.
    const slots = source.getSolutionSlots('L')!;
    placeLetterAt(source.letters.find((l) => l.correctIndex === 0)!, slots[0]!.position);
    placeLetterAt(source.letters.find((l) => l.correctIndex === 1)!, slots[1]!.position);

    // Grab the third letter (correctIndex 2) and give its owner an in-bounds
    // cursor — exercises lock + cursor reconciliation without disturbing slots.
    source.applyInput({ type: 'grab', playerId: 'p2', letterId: 'L:2', clientTick: 0 });
    source.applyInput({ type: 'cursor', playerId: 'p2', x: 123, y: 456 });

    source.tick(STEP);
    source.tick(STEP);

    const snap = source.snapshot();
    expect(snap.provisionalScore).toBe(2);
    expect(snap.tick).toBe(2);

    // Target core: DIFFERENT seed (so spawn positions differ) but same line/ids.
    const target = new GameCore(999, makeConfig());
    target.spawnLine(makeLine('L', 'one two three'));

    target.applySnapshot(snap);

    const targetSnap = target.snapshot();
    // Positions reproduced exactly (deep equal on the letters payload).
    expect(targetSnap.letters).toEqual(snap.letters);
    // Ownership_Locks reproduced.
    expect(targetSnap.locks).toEqual(snap.locks);
    // Cursors reproduced.
    expect(targetSnap.cursors).toEqual(snap.cursors);
    // Tick + provisional score reproduced.
    expect(targetSnap.tick).toBe(snap.tick);
    expect(target.provisionalScore).toBe(source.provisionalScore);
    expect(targetSnap.provisionalScore).toBe(snap.provisionalScore);

    // The reconstructed lock is real: the held node is pinned with infinite mass.
    const heldNode = target.letters.find((l) => l.id === 'L:2')!.particles[0]!;
    expect(heldNode.pinned).toBe(true);
    expect(heldNode.invMass).toBe(0);
  });

  it('clears a stale local lock not present in the incoming snapshot', () => {
    const source = new GameCore(1, makeConfig());
    source.spawnLine(makeLine('L', 'one two'));
    const snap = source.snapshot(); // no locks at all.

    const target = new GameCore(1, makeConfig());
    target.spawnLine(makeLine('L', 'one two'));
    target.applyInput({ type: 'grab', playerId: 'p1', letterId: 'L:0', clientTick: 0 });
    expect(target.letters[0]!.ownerId).toBe('p1');

    target.applySnapshot(snap);

    // The snapshot had no lock for L:0, so reconciliation cleared it + unpinned.
    expect(target.letters[0]!.ownerId).toBeNull();
    expect(target.letters[0]!.particles[0]!.pinned).toBe(false);
    expect(target.letters[0]!.particles[0]!.invMass).toBe(1);
    expect(target.snapshot().locks).toEqual([]);
  });

  it('skips snapshot letters it has never seen without throwing', () => {
    // Source spawns line A; target spawns a DIFFERENT line B (disjoint ids).
    const source = new GameCore(1, makeConfig());
    source.spawnLine(makeLine('A', 'alpha beta'));
    source.applyInput({ type: 'grab', playerId: 'p1', letterId: 'A:0', clientTick: 0 });
    const snap = source.snapshot();

    const target = new GameCore(1, makeConfig());
    target.spawnLine(makeLine('B', 'gamma delta'));
    const before = target.snapshot().letters;

    // None of the snapshot's letter ids exist locally: apply must not throw and
    // must leave the target's own letters untouched.
    expect(() => target.applySnapshot(snap)).not.toThrow();
    expect(target.snapshot().letters).toEqual(before);
    // No phantom locks created from the unknown letter id.
    expect(target.snapshot().locks).toEqual([]);
    // The tick number still reconciles from the snapshot.
    expect(target.snapshot().tick).toBe(snap.tick);
  });
});
