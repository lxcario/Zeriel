import { describe, it, expect } from 'vitest';
import type { GameConfig, LyricLine, GrabOutcome, ReleaseOutcome } from '../types/index.js';
import { GameCore } from './index.js';

/**
 * Smoke unit tests for task 4.4: ownership-lock handling + held-letter movement.
 *
 * These prove the core guarantees of the task — grab grants on an unlocked
 * letter (8.1), grabs are denied on a letter locked by another player with the
 * current owner reported (8.2), a held letter's grabbed node tracks its owner's
 * cursor each tick (8.3), release clears the owner's lock and unpins the grabbed
 * node (8.4), plus the documented edge decisions (same-owner re-grab idempotent,
 * release of a non-owned letter is a no-op, cursor recorded). The dedicated
 * property tests are optional tasks 4.5 / 4.6 and are NOT written here.
 */

/** A representative config (mirrors GameCore.spawn.test.ts). */
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

/** Spawn a single-line core and return it; letter ids are `L:0`, `L:1`, ... */
function coreWithLine(text: string, seed = 1): GameCore {
  const core = new GameCore(seed, makeConfig());
  core.spawnLine(makeLine('L', text));
  return core;
}

describe('GameCore.applyInput — ownership locks (task 4.4)', () => {
  it('grants a grab on an unlocked letter and assigns the lock (8.1)', () => {
    const core = coreWithLine('alpha beta');
    const out = core.applyInput({
      type: 'grab',
      playerId: 'p1',
      letterId: 'L:0',
      clientTick: 0,
    }) as GrabOutcome;

    expect(out).toEqual({ type: 'grab', letterId: 'L:0', granted: true, ownerId: 'p1' });
    expect(core.letters[0]!.ownerId).toBe('p1');
    // The lock now appears in the snapshot.
    expect(core.snapshot().locks).toContainEqual({ letterId: 'L:0', ownerId: 'p1' });
  });

  it('denies a grab on a letter locked by another player and reports the owner (8.2)', () => {
    const core = coreWithLine('alpha beta');
    core.applyInput({ type: 'grab', playerId: 'p1', letterId: 'L:0', clientTick: 0 });

    const out = core.applyInput({
      type: 'grab',
      playerId: 'p2',
      letterId: 'L:0',
      clientTick: 1,
    }) as GrabOutcome;

    expect(out).toEqual({ type: 'grab', letterId: 'L:0', granted: false, ownerId: 'p1' });
    // Ownership is unchanged by the denied grab.
    expect(core.letters[0]!.ownerId).toBe('p1');
  });

  it('treats a same-player re-grab as idempotent (not a denial)', () => {
    const core = coreWithLine('alpha beta');
    core.applyInput({ type: 'grab', playerId: 'p1', letterId: 'L:0', clientTick: 0 });

    const out = core.applyInput({
      type: 'grab',
      playerId: 'p1',
      letterId: 'L:0',
      clientTick: 1,
    }) as GrabOutcome;

    expect(out).toEqual({ type: 'grab', letterId: 'L:0', granted: true, ownerId: 'p1' });
    expect(core.letters[0]!.ownerId).toBe('p1');
    // Still exactly one lock for the letter.
    expect(core.snapshot().locks).toEqual([{ letterId: 'L:0', ownerId: 'p1' }]);
  });

  it('returns granted:false / ownerId:null for a grab on a missing letter', () => {
    const core = coreWithLine('alpha beta');
    const out = core.applyInput({
      type: 'grab',
      playerId: 'p1',
      letterId: 'does-not-exist',
      clientTick: 0,
    }) as GrabOutcome;

    expect(out).toEqual({
      type: 'grab',
      letterId: 'does-not-exist',
      granted: false,
      ownerId: null,
    });
    // No locks were created.
    expect(core.snapshot().locks).toEqual([]);
  });

  it('clears the owner lock and unpins the grabbed node on release (8.4)', () => {
    const core = coreWithLine('alpha beta');
    core.applyInput({ type: 'grab', playerId: 'p1', letterId: 'L:0', clientTick: 0 });

    // While held, the grabbed node (index 0) is pinned with invMass 0.
    const grabbedNode = core.letters[0]!.particles[0]!;
    expect(grabbedNode.pinned).toBe(true);
    expect(grabbedNode.invMass).toBe(0);

    const out = core.applyInput({
      type: 'release',
      playerId: 'p1',
      letterId: 'L:0',
    }) as ReleaseOutcome;

    expect(out).toEqual({ type: 'release', letterId: 'L:0', released: true });
    expect(core.letters[0]!.ownerId).toBeNull();
    // The grabbed node is restored to a free particle.
    expect(grabbedNode.pinned).toBe(false);
    expect(grabbedNode.invMass).toBe(1);
    expect(core.snapshot().locks).toEqual([]);
  });

  it('returns released:false and changes nothing for a release of a non-owned letter', () => {
    const core = coreWithLine('alpha beta');
    core.applyInput({ type: 'grab', playerId: 'p1', letterId: 'L:0', clientTick: 0 });

    // p2 tries to release p1's letter.
    const otherOut = core.applyInput({
      type: 'release',
      playerId: 'p2',
      letterId: 'L:0',
    }) as ReleaseOutcome;
    expect(otherOut).toEqual({ type: 'release', letterId: 'L:0', released: false });
    expect(core.letters[0]!.ownerId).toBe('p1');

    // Releasing an unlocked letter is also a no-op.
    const unlockedOut = core.applyInput({
      type: 'release',
      playerId: 'p1',
      letterId: 'L:1',
    }) as ReleaseOutcome;
    expect(unlockedOut).toEqual({ type: 'release', letterId: 'L:1', released: false });
    expect(core.letters[1]!.ownerId).toBeNull();
  });

  it('records the latest cursor position and accepts the input', () => {
    const core = coreWithLine('alpha beta');
    const out = core.applyInput({ type: 'cursor', playerId: 'p1', x: 123, y: 456 });
    expect(out).toEqual({ type: 'cursor', accepted: true });

    // The cursor is observable indirectly: grab a letter, set a cursor, tick,
    // and the grabbed node snaps to the recorded position.
    core.applyInput({ type: 'grab', playerId: 'p1', letterId: 'L:0', clientTick: 0 });
    core.tick(1000 / 30);
    expect(core.letters[0]!.particles[0]!.x).toEqual({ x: 123, y: 456 });
  });
});

describe('GameCore — held-letter steering toward owner cursor (task 4.4, Req 8.3)', () => {
  it('snaps the held grabbed node to the owner cursor on tick and keeps it pinned', () => {
    const core = coreWithLine('alpha beta');
    core.applyInput({ type: 'grab', playerId: 'p1', letterId: 'L:0', clientTick: 0 });
    core.applyInput({ type: 'cursor', playerId: 'p1', x: 300, y: 200 });

    core.tick(1000 / 30);

    const node = core.letters[0]!.particles[0]!;
    expect(node.x).toEqual({ x: 300, y: 200 });
    // Pinned with zero implicit velocity (prev === x) so it is a true anchor.
    expect(node.prev).toEqual({ x: 300, y: 200 });
    expect(node.pinned).toBe(true);
    expect(node.invMass).toBe(0);
  });

  it('follows the owner cursor as it moves across successive ticks', () => {
    const core = coreWithLine('alpha beta');
    core.applyInput({ type: 'grab', playerId: 'p1', letterId: 'L:0', clientTick: 0 });

    core.applyInput({ type: 'cursor', playerId: 'p1', x: 100, y: 100 });
    core.tick(1000 / 30);
    expect(core.letters[0]!.particles[0]!.x).toEqual({ x: 100, y: 100 });

    core.applyInput({ type: 'cursor', playerId: 'p1', x: 400, y: 350 });
    core.tick(1000 / 30);
    expect(core.letters[0]!.particles[0]!.x).toEqual({ x: 400, y: 350 });
  });

  it('does not steer a letter after it is released (node freed, no longer tracking)', () => {
    const core = coreWithLine('alpha beta');
    core.applyInput({ type: 'grab', playerId: 'p1', letterId: 'L:0', clientTick: 0 });
    core.applyInput({ type: 'cursor', playerId: 'p1', x: 250, y: 250 });
    core.tick(1000 / 30);
    expect(core.letters[0]!.particles[0]!.x).toEqual({ x: 250, y: 250 });

    core.applyInput({ type: 'release', playerId: 'p1', letterId: 'L:0' });
    // Move the cursor and tick again; the freed node must NOT snap to the cursor.
    core.applyInput({ type: 'cursor', playerId: 'p1', x: 700, y: 500 });
    core.tick(1000 / 30);
    expect(core.letters[0]!.particles[0]!.x).not.toEqual({ x: 700, y: 500 });
    expect(core.letters[0]!.particles[0]!.invMass).toBe(1);
  });

  it('leaves a held letter in place until its owner has a known cursor', () => {
    const core = coreWithLine('alpha beta');
    const before = { ...core.letters[0]!.particles[0]!.x };
    core.applyInput({ type: 'grab', playerId: 'p1', letterId: 'L:0', clientTick: 0 });

    // No cursor recorded for p1 yet: steering leaves the grabbed node untouched.
    core.tick(1000 / 30);
    expect(core.letters[0]!.particles[0]!.x).toEqual(before);
  });
});
