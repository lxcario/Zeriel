import { describe, it, expect } from 'vitest';
import type { GameConfig, LyricLine, RopeLetter, SolutionSlot } from '../types/index.js';
import { GameCore } from './index.js';

/**
 * Smoke unit tests for task 4.7: Solution_Slot placement marking + scoring.
 *
 * These prove the core guarantees of the task — a resting letter is marked
 * placed only within a slot's tolerance else `null` (9.2); the provisional
 * per-line score counts correctly-ordered letters while the window is open
 * (9.3); finalize freezes the per-line score as the count of correctly-ordered
 * letters at close (9.4); the Round total is the sum of finalized line scores
 * (9.5); per-Player contributions sum to the total (9.6); and the pure logic is
 * mode-agnostic (9.7). The dedicated property tests are optional tasks 4.8–4.11
 * and are NOT written here.
 *
 * Positions are set by directly mutating particle `x` positions (the full
 * physics tick is task 4.12), then `tick(dt)` is called to run the placement +
 * provisional-scoring step (tick step 6).
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

const STEP = 1000 / 30;

/**
 * Teleport a letter's whole 2-node chain so its centroid sits exactly at `pos`.
 * Both particles are placed symmetrically around `pos` on the x-axis, preserving
 * the chain's current half-length, so the centroid (mean) equals `pos`.
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

/** The Solution_Slot for a given correct index, asserted present. */
function slotFor(core: GameCore, lineId: string, index: number): SolutionSlot {
  const slots = core.getSolutionSlots(lineId);
  if (!slots) throw new Error(`no slots for ${lineId}`);
  const slot = slots.find((s) => s.index === index);
  if (!slot) throw new Error(`no slot index ${index}`);
  return slot;
}

describe('GameCore placement marking (task 4.7, Req 9.2)', () => {
  it('marks a letter placed in its correct slot when within tolerance', () => {
    const core = new GameCore(1, makeConfig());
    const line = makeLine('L', 'one two three');
    core.spawnLine(line);

    const letter = core.letters.find((l) => l.correctIndex === 1)!;
    const slot = slotFor(core, 'L', 1);
    placeLetterAt(letter, slot.position); // exactly on target.

    core.tick(STEP);

    expect(letter.placedSlot).toBe(1);
    expect(letter.placedSlot).toBe(letter.correctIndex); // correctly ordered.
  });

  it('marks a letter null when outside every slot tolerance', () => {
    const config = makeConfig();
    const core = new GameCore(1, config);
    const line = makeLine('L', 'one two three');
    core.spawnLine(line);

    const letter = core.letters.find((l) => l.correctIndex === 0)!;
    // Far below the answer row, well outside any tolerance.
    placeLetterAt(letter, { x: 400, y: 50 });

    core.tick(STEP);

    expect(letter.placedSlot).toBeNull();
  });

  it('marks a letter placed in the WRONG slot (placed but not correctly ordered)', () => {
    const core = new GameCore(1, makeConfig());
    const line = makeLine('L', 'one two three');
    core.spawnLine(line);

    // Letter whose correctIndex is 0, dropped onto slot index 2's position.
    const letter = core.letters.find((l) => l.correctIndex === 0)!;
    const wrongSlot = slotFor(core, 'L', 2);
    placeLetterAt(letter, wrongSlot.position);

    core.tick(STEP);

    expect(letter.placedSlot).toBe(2); // placed (9.2)...
    expect(letter.placedSlot).not.toBe(letter.correctIndex); // ...but not correct.
  });

  it('chooses the nearest slot when more than one is within tolerance', () => {
    // Use a large tolerance so adjacent slots overlap, then sit closer to one.
    const config = makeConfig();
    config.placementTolerance = 1000; // every slot is within tolerance everywhere.
    const core = new GameCore(1, config);
    const line = makeLine('L', 'a b c');
    core.spawnLine(line);

    const letter = core.letters.find((l) => l.correctIndex === 0)!;
    const slot2 = slotFor(core, 'L', 2);
    // Place the centroid exactly on slot 2 → slot 2 is the nearest (distance 0).
    placeLetterAt(letter, slot2.position);

    core.tick(STEP);

    expect(letter.placedSlot).toBe(2);
  });
});

describe('GameCore provisional scoring (task 4.7, Req 9.3)', () => {
  it('increments the provisional score as letters are correctly placed', () => {
    const core = new GameCore(1, makeConfig());
    const line = makeLine('L', 'one two three');
    core.spawnLine(line);

    // Initially nothing is placed.
    core.tick(STEP);
    expect(core.getLineScore('L')!.provisional).toBe(0);
    expect(core.snapshot().provisionalScore).toBe(0);

    // Correctly place the letter for slot 0.
    const l0 = core.letters.find((l) => l.correctIndex === 0)!;
    placeLetterAt(l0, slotFor(core, 'L', 0).position);
    core.tick(STEP);
    expect(core.getLineScore('L')!.provisional).toBe(1);
    expect(core.snapshot().provisionalScore).toBe(1);

    // Correctly place a second letter.
    const l1 = core.letters.find((l) => l.correctIndex === 1)!;
    placeLetterAt(l1, slotFor(core, 'L', 1).position);
    core.tick(STEP);
    expect(core.getLineScore('L')!.provisional).toBe(2);
    expect(core.snapshot().provisionalScore).toBe(2);
  });

  it('does not count letters placed in the wrong slot toward the provisional score', () => {
    const core = new GameCore(1, makeConfig());
    const line = makeLine('L', 'one two three');
    core.spawnLine(line);

    // Place correctIndex-0 letter onto slot 1's position (wrong slot).
    const l0 = core.letters.find((l) => l.correctIndex === 0)!;
    placeLetterAt(l0, slotFor(core, 'L', 1).position);
    core.tick(STEP);

    expect(l0.placedSlot).toBe(1);
    expect(core.getLineScore('L')!.provisional).toBe(0);
  });
});

describe('GameCore finalize + round total (task 4.7, Req 9.4, 9.5)', () => {
  it('finalizes the per-line score as the count of correctly-ordered letters', () => {
    const core = new GameCore(1, makeConfig());
    const line = makeLine('L', 'one two three');
    core.spawnLine(line);

    // Correctly place two of three; leave the third unplaced.
    placeLetterAt(core.letters.find((l) => l.correctIndex === 0)!, slotFor(core, 'L', 0).position);
    placeLetterAt(core.letters.find((l) => l.correctIndex === 2)!, slotFor(core, 'L', 2).position);
    core.tick(STEP);

    expect(core.getLineScore('L')!.finalized).toBeNull(); // window still open.
    expect(core.getLineScore('L')!.provisional).toBe(2);

    core.finalizeLine('L');

    const score = core.getLineScore('L')!;
    expect(score.finalized).toBe(2);
    expect(score.provisional).toBe(2); // frozen to the finalized value.
  });

  it('round total is the sum of finalized line scores', () => {
    const core = new GameCore(1, makeConfig());
    const lineA = makeLine('A', 'one two');
    const lineB = makeLine('B', 'three four five');
    core.spawnLine(lineA);
    core.spawnLine(lineB);

    // Line A: both correct (2). Line B: one correct (1).
    placeLetterAt(core.letters.find((l) => l.lineId === 'A' && l.correctIndex === 0)!, slotFor(core, 'A', 0).position);
    placeLetterAt(core.letters.find((l) => l.lineId === 'A' && l.correctIndex === 1)!, slotFor(core, 'A', 1).position);
    placeLetterAt(core.letters.find((l) => l.lineId === 'B' && l.correctIndex === 0)!, slotFor(core, 'B', 0).position);
    core.tick(STEP);

    core.finalizeLine('A');
    core.finalizeLine('B');

    const result = core.getRoundResult();
    expect(result.totalScore).toBe(3); // 2 + 1.
  });

  it('finalizeLine is idempotent (a double close does not double-count)', () => {
    const core = new GameCore(1, makeConfig());
    const line = makeLine('L', 'one two');
    core.spawnLine(line);
    core.applyInput({ type: 'grab', playerId: 'p1', letterId: 'L:0', clientTick: 0 });
    placeLetterAt(core.letters.find((l) => l.correctIndex === 0)!, slotFor(core, 'L', 0).position);
    core.tick(STEP);

    core.finalizeLine('L');
    core.finalizeLine('L'); // second close: no-op.

    expect(core.getLineScore('L')!.finalized).toBe(1);
    const result = core.getRoundResult();
    expect(result.totalScore).toBe(1);
    expect(result.contributions['p1']).toBe(1); // not double-credited.
  });
});

describe('GameCore per-player contributions (task 4.7, Req 9.6)', () => {
  it('credits each correctly-placed letter to its last owner and conserves the total', () => {
    const core = new GameCore(1, makeConfig());
    const line = makeLine('L', 'one two three');
    core.spawnLine(line);

    // p1 grabs+places letters 0 and 1; p2 grabs+places letter 2.
    core.applyInput({ type: 'grab', playerId: 'p1', letterId: 'L:0', clientTick: 0 });
    core.applyInput({ type: 'grab', playerId: 'p1', letterId: 'L:1', clientTick: 0 });
    core.applyInput({ type: 'grab', playerId: 'p2', letterId: 'L:2', clientTick: 0 });

    placeLetterAt(core.letters.find((l) => l.correctIndex === 0)!, slotFor(core, 'L', 0).position);
    placeLetterAt(core.letters.find((l) => l.correctIndex === 1)!, slotFor(core, 'L', 1).position);
    placeLetterAt(core.letters.find((l) => l.correctIndex === 2)!, slotFor(core, 'L', 2).position);

    // Release p1's letters; last owner is retained for attribution.
    core.applyInput({ type: 'release', playerId: 'p1', letterId: 'L:0' });
    core.tick(STEP);

    core.finalizeLine('L');
    const result = core.getRoundResult();

    expect(result.totalScore).toBe(3);
    expect(result.contributions['p1']).toBe(2);
    expect(result.contributions['p2']).toBe(1);

    // Property-29 style conservation: contributions sum to the total.
    const sum = Object.values(result.contributions).reduce((a, b) => a + b, 0);
    expect(sum).toBe(result.totalScore);
  });

  it('attributes a never-owned correct letter to the sentinel so the sum still equals the total', () => {
    const core = new GameCore(1, makeConfig());
    const line = makeLine('L', 'one two');
    core.spawnLine(line);

    // Letter 0 is grabbed by p1; letter 1 is never grabbed but lands correctly.
    core.applyInput({ type: 'grab', playerId: 'p1', letterId: 'L:0', clientTick: 0 });
    placeLetterAt(core.letters.find((l) => l.correctIndex === 0)!, slotFor(core, 'L', 0).position);
    placeLetterAt(core.letters.find((l) => l.correctIndex === 1)!, slotFor(core, 'L', 1).position);
    core.tick(STEP);

    core.finalizeLine('L');
    const result = core.getRoundResult();

    expect(result.totalScore).toBe(2);
    // Conservation holds even with a never-owned correct letter.
    const sum = Object.values(result.contributions).reduce((a, b) => a + b, 0);
    expect(sum).toBe(result.totalScore);
    expect(result.contributions['p1']).toBe(1);
  });
});

describe('GameCore scoring is mode-agnostic (task 4.7, Req 9.7)', () => {
  it('computes identical results for the same arrangement regardless of "mode"', () => {
    // The pure GameCore has no mode branch; running the same arrangement twice
    // (a single-player-style and a multiplayer-style player set) yields the same
    // total. Single player: one player owns everything.
    function run(owners: string[]): ReturnType<GameCore['getRoundResult']> {
      const core = new GameCore(1, makeConfig());
      const line = makeLine('L', 'one two three');
      core.spawnLine(line);
      owners.forEach((owner, i) => {
        core.applyInput({ type: 'grab', playerId: owner, letterId: `L:${i}`, clientTick: 0 });
        placeLetterAt(core.letters.find((l) => l.correctIndex === i)!, slotFor(core, 'L', i).position);
      });
      core.tick(STEP);
      core.finalizeLine('L');
      return core.getRoundResult();
    }

    const single = run(['solo', 'solo', 'solo']);
    const multi = run(['p1', 'p2', 'p3']);

    // Same ordering rules → same total and same number of correctly placed letters.
    expect(single.totalScore).toBe(3);
    expect(multi.totalScore).toBe(3);
    expect(single.totalScore).toBe(multi.totalScore);

    // Single player: one contributor holding the whole total.
    expect(single.contributions['solo']).toBe(3);
    // Multiplayer: distributed, but conserves the same total.
    const multiSum = Object.values(multi.contributions).reduce((a, b) => a + b, 0);
    expect(multiSum).toBe(multi.totalScore);
  });

  it('sets the round result track title via setTrackTitle', () => {
    const core = new GameCore(1, makeConfig());
    expect(core.getRoundResult().trackTitle).toBe(''); // default.
    core.setTrackTitle('Never Gonna Give You Up');
    expect(core.getRoundResult().trackTitle).toBe('Never Gonna Give You Up');
  });
});
