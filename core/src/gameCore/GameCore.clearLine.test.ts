import { describe, it, expect } from 'vitest';
import { GameCore } from './GameCore.js';
import type { GameConfig, LyricLine } from '../types/index.js';

/**
 * Tests for {@link GameCore.clearLine} (line despawn).
 *
 * Clearing a line removes its live Rope_Letters from play (so lines do not pile
 * up forever) WITHOUT disturbing scoring: a finalized line's score and the
 * Round total are retained after its letters are cleared.
 */

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

function makeLine(id: string, text: string): LyricLine {
  return { id, startMs: 0, text, solutionSlots: [] };
}

describe('GameCore.clearLine', () => {
  it('removes only the target line\'s letters, keeping other lines', () => {
    const core = new GameCore(1, makeConfig());
    core.spawnLine(makeLine('line-0', 'one two'));
    core.spawnLine(makeLine('line-1', 'three four'));
    expect(core.letters.length).toBe(4);

    core.clearLine('line-0');

    const remaining = core.letters;
    expect(remaining.length).toBe(2);
    expect(remaining.every((l) => l.lineId === 'line-1')).toBe(true);
    // Cleared line's slots are forgotten; the surviving line's are intact.
    expect(core.getSolutionSlots('line-0')).toBeUndefined();
    expect(core.getSolutionSlots('line-1')).toBeDefined();
  });

  it('is a no-op for an unknown or already-cleared line', () => {
    const core = new GameCore(1, makeConfig());
    core.spawnLine(makeLine('line-0', 'hello world'));
    expect(core.letters.length).toBe(2);

    core.clearLine('nope');
    expect(core.letters.length).toBe(2);

    core.clearLine('line-0');
    expect(core.letters.length).toBe(0);
    core.clearLine('line-0'); // again: still a no-op
    expect(core.letters.length).toBe(0);
  });

  it('retains the finalized score and Round total after clearing', () => {
    const core = new GameCore(1, makeConfig());
    const line = makeLine('line-0', 'a b');
    core.spawnLine(line);

    // Force both letters to their correct slots so the line scores 2.
    const slots = core.getSolutionSlots('line-0')!;
    for (const letter of core.letters) {
      const slot = slots.find((s) => s.index === letter.correctIndex)!;
      for (const p of letter.particles) {
        p.x.x = slot.position.x;
        p.x.y = slot.position.y;
        p.prev.x = slot.position.x;
        p.prev.y = slot.position.y;
      }
    }
    core.tick(core['config'].stepMs); // evaluate placement
    core.finalizeLine('line-0');
    const before = core.getRoundResult().totalScore;
    expect(before).toBe(2);

    // Clearing the line's letters must NOT change the finalized total.
    core.clearLine('line-0');
    expect(core.letters.length).toBe(0);
    expect(core.getRoundResult().totalScore).toBe(2);
  });

  it('clears pinned-grabbed-node bookkeeping so a held cleared letter is gone', () => {
    const core = new GameCore(1, makeConfig());
    core.spawnLine(makeLine('line-0', 'grab me'));
    const target = core.letters[0]!;
    const grab = core.applyInput({ type: 'grab', playerId: 'p1', letterId: target.id, clientTick: 0 });
    expect(grab.type === 'grab' && grab.granted).toBe(true);

    core.clearLine('line-0');
    expect(core.letters.length).toBe(0);
    // Re-grabbing the now-removed letter is a benign denial (no dangling pin).
    const regrab = core.applyInput({ type: 'grab', playerId: 'p1', letterId: target.id, clientTick: 1 });
    expect(regrab.type === 'grab' && regrab.granted).toBe(false);
  });
});
