import { describe, it, expect } from 'vitest';
import type { GameConfig, LyricLine } from '../types/index.js';
import { GameCore } from './index.js';

/**
 * Smoke unit tests for task 4.1: `spawnLine` + Solution_Slot generation.
 *
 * These prove the core guarantees of the task — per-token spawning, determinism,
 * slot ordering aligned to `correctIndex`, and in-band placement. The dedicated
 * property tests are optional tasks 4.2 / 4.3 and are NOT written here.
 */

/** A representative config; values are arbitrary but cover the fields spawnLine reads. */
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

describe('GameCore.spawnLine (task 4.1)', () => {
  it('spawns exactly one rope-letter per non-whitespace (word) token', () => {
    const core = new GameCore(123, makeConfig());
    core.spawnLine(makeLine('L1', 'hello  big   world'));

    // 3 word tokens despite the extra/irregular spacing; no letter for spaces.
    expect(core.letters).toHaveLength(3);
    expect(core.letters.map((l) => l.glyph)).toEqual(['hello', 'big', 'world']);
  });

  it('ignores leading/trailing whitespace and spawns nothing for a blank line', () => {
    const core = new GameCore(1, makeConfig());
    core.spawnLine(makeLine('blank', '   \t  '));
    expect(core.letters).toHaveLength(0);

    const line = makeLine('blank', '   \t  ');
    core.spawnLine(line);
    expect(line.solutionSlots).toHaveLength(0);
  });

  it('builds each letter as a 2-particle chain joined by one distance constraint', () => {
    const config = makeConfig();
    const core = new GameCore(7, config);
    core.spawnLine(makeLine('L1', 'ab cd'));

    for (const letter of core.letters) {
      expect(letter.particles).toHaveLength(2);
      expect(letter.constraints).toHaveLength(1);
      const c = letter.constraints[0]!;
      expect(c.a).toBe(0);
      expect(c.b).toBe(1);
      expect(c.stiffness).toBe(config.defaultStiffness);
      expect(c.restLength).toBeGreaterThan(0);
      expect(letter.colliderRadius).toBe(config.colliderRadius);
      // Both nodes start movable and at rest (zero implicit velocity).
      for (const p of letter.particles) {
        expect(p.pinned).toBe(false);
        expect(p.invMass).toBe(1);
        expect(p.prev).toEqual(p.x);
      }
    }
  });

  it('assigns unique deterministic ids, null owner/placedSlot, and correctIndex 0..n-1', () => {
    const core = new GameCore(42, makeConfig());
    core.spawnLine(makeLine('LINE', 'one two three'));

    expect(core.letters.map((l) => l.id)).toEqual(['LINE:0', 'LINE:1', 'LINE:2']);
    core.letters.forEach((l, i) => {
      expect(l.lineId).toBe('LINE');
      expect(l.correctIndex).toBe(i);
      expect(l.ownerId).toBeNull();
      expect(l.placedSlot).toBeNull();
    });
  });

  it('is deterministic: same seed + line yields identical letters (positions + jitter seeds)', () => {
    const lineText = 'deterministic ransom note letters';
    const a = new GameCore(2024, makeConfig());
    const b = new GameCore(2024, makeConfig());
    a.spawnLine(makeLine('L', lineText));
    b.spawnLine(makeLine('L', lineText));

    expect(a.letters).toEqual(b.letters);
    // Spot-check the jitter seeds and particle positions explicitly.
    expect(a.letters.map((l) => l.spawnJitterSeed)).toEqual(
      b.letters.map((l) => l.spawnJitterSeed),
    );
    expect(a.letters.map((l) => l.particles.map((p) => p.x))).toEqual(
      b.letters.map((l) => l.particles.map((p) => p.x)),
    );
  });

  it('produces different jitter for different seeds (PRNG is actually used)', () => {
    const a = new GameCore(1, makeConfig());
    const b = new GameCore(999, makeConfig());
    a.spawnLine(makeLine('L', 'alpha beta gamma'));
    b.spawnLine(makeLine('L', 'alpha beta gamma'));
    expect(a.letters.map((l) => l.spawnJitterSeed)).not.toEqual(
      b.letters.map((l) => l.spawnJitterSeed),
    );
  });

  it('generates a 0..n-1 solution-slot sequence aligned to correctIndex', () => {
    const config = makeConfig();
    const core = new GameCore(5, config);
    const line = makeLine('L1', 'order these words now');
    core.spawnLine(line);

    const n = core.letters.length;
    expect(n).toBe(4);

    // Slots are filled in place on the line AND stored in GameCore state.
    expect(line.solutionSlots).toHaveLength(n);
    expect(core.getSolutionSlots('L1')).toBe(line.solutionSlots);

    line.solutionSlots.forEach((slot, i) => {
      expect(slot.index).toBe(i);
      expect(slot.tolerance).toBe(config.placementTolerance);
      // Slot i is the target for the letter whose correctIndex === i.
      const letter = core.letters.find((l) => l.correctIndex === i)!;
      expect(letter).toBeDefined();
      // Answer row: all slots share the same y, increasing x by index.
      expect(slot.position.y).toBeCloseTo(config.bounds.y + 0.85 * config.bounds.height, 6);
      if (i > 0) {
        expect(slot.position.x).toBeGreaterThan(line.solutionSlots[i - 1]!.position.x);
      }
    });
  });

  it('places every spawned particle within the spawn band', () => {
    const config = makeConfig();
    const core = new GameCore(31337, config);
    // A long line with varied token lengths to stress the placement clamps.
    core.spawnLine(makeLine('L', 'a bb ccc dddd eeeee ffffff g hh iii'));

    const band = config.spawnBand;
    for (const letter of core.letters) {
      for (const p of letter.particles) {
        expect(p.x.x).toBeGreaterThanOrEqual(band.x);
        expect(p.x.x).toBeLessThanOrEqual(band.x + band.width);
        expect(p.x.y).toBeGreaterThanOrEqual(band.y);
        expect(p.x.y).toBeLessThanOrEqual(band.y + band.height);
      }
    }
  });

  it('accumulates letters across multiple spawned lines', () => {
    const core = new GameCore(8, makeConfig());
    core.spawnLine(makeLine('A', 'first line'));
    core.spawnLine(makeLine('B', 'second line here'));

    expect(core.letters).toHaveLength(2 + 3);
    expect(core.letters.map((l) => l.lineId)).toEqual(['A', 'A', 'B', 'B', 'B']);
    // Each line keeps its own 0..n-1 correctIndex sequence.
    expect(core.letters.filter((l) => l.lineId === 'A').map((l) => l.correctIndex)).toEqual([0, 1]);
    expect(core.letters.filter((l) => l.lineId === 'B').map((l) => l.correctIndex)).toEqual([
      0, 1, 2,
    ]);
  });
});
