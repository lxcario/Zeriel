import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { GameConfig, LyricLine, RopeLetter } from '../types/index.js';
import { GameCore } from './index.js';

/**
 * Property-based test for snapshot reproduction (task 4.13).
 *
 * Property 37: Snapshot round trip reproduces authoritative state.
 * **Validates: Requirements 16.3**
 *
 * Design ("Correctness Properties" / Property 37): *For any* authoritative game
 * state, serializing it to a {@link GameCore.snapshot} and applying that
 * snapshot (via {@link GameCore.applySnapshot}) to a fresh Client reproduces an
 * equal set of Rope_Letter positions, Ownership_Locks, and scores — so a Client
 * joining a Round in progress renders the SAME play state as existing Players
 * (Requirement 16.3).
 *
 * ---------------------------------------------------------------------------
 * SAME-LINES / DIFFERENT-SEED setup (proves overwrite, not equal spawns)
 * ---------------------------------------------------------------------------
 * The SOURCE and TARGET cores spawn the SAME lines (identical line ids + text,
 * so identical rope-letter ids `L{line}:{index}`) but are constructed with
 * DIFFERENT seeds. Different seeds drive different spawn jitter, so the two
 * cores start from DIFFERENT particle positions. The test asserts that after
 * `target.applySnapshot(source.snapshot())` the target reproduces the source's
 * authoritative state EXACTLY. Because the initial positions differ, a passing
 * assertion proves `applySnapshot` overwrites positions from the snapshot rather
 * than coincidentally agreeing because both cores spawned identically.
 *
 * The property holds REGARDLESS of how the source reached its state — the claim
 * is only that snapshot -> applySnapshot reproduces it — so no determinism of
 * the physics between the two cores is required (gravity is left on).
 *
 * ---------------------------------------------------------------------------
 * Scenario generator — broad authoritative states
 * ---------------------------------------------------------------------------
 *   - `linesArb`: 1..3 lines, each 1..5 non-whitespace WORDS. Lines are assigned
 *     deterministic ids `L0`,`L1`,`L2` by position so ids (and therefore the
 *     `L{n}:{i}` letter ids) are unique across lines. Each line has >= 1 token,
 *     so both cores always spawn >= 1 rope-letter.
 *   - `opsArb`: 0..12 operations applied to the SOURCE to build varied
 *     authoritative state:
 *       - `grab`   — a player from a small fixed set grabs a letter (creates
 *                    Ownership_Locks + pinned grabbed nodes);
 *       - `release`— a player releases a letter (clears locks, for variety);
 *       - `cursor` — records a player's cursor (presence + steers held letters);
 *       - `place`  — teleports a letter's chain onto its OWN correct Solution_Slot
 *                    so that, after a tick's placement pass, it counts toward the
 *                    provisional score (exercises `placedSlot` + score reproduction).
 *   - `ticksArb`: 1..5 `tick(stepMs)` calls AFTER the ops, so the source runs the
 *     real physics + steering + placement pass at least once and its snapshot
 *     carries deterministic `placedSlot` values and a settled state.
 *   - seeds: arbitrary `fc.integer()` source seed and a target seed forced to
 *     DIFFER from it (so spawn jitter, hence initial positions, differ).
 *
 * Assertions (Property 37 / Requirement 16.3):
 *   - target.snapshot().letters  deep-equals s.letters  (positions + prev + placedSlot);
 *   - target.snapshot().locks    deep-equals s.locks     (Ownership_Locks);
 *   - target.snapshot().cursors  deep-equals s.cursors   (presence);
 *   - target.snapshot().tick           === s.tick;
 *   - target.snapshot().provisionalScore === s.provisionalScore;
 *   - target.provisionalScore (getter) === source.provisionalScore;
 *   - IDEMPOTENCE: applying s a SECOND time leaves target.snapshot() deep-equal
 *     to s (apply twice == apply once) — reconciliation is a stable fixed point.
 *
 * numRuns is left at the global default (100, from `vitest.setup.ts`).
 */

// --- Fixed representative config (mirrors the sibling GameCore tests) --------

/** A representative config; gravity is ON (the property is independent of it). */
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

/** Small fixed set of player ids used for grabs/cursors. */
const PLAYERS = ['p1', 'p2', 'p3'] as const;

/**
 * Teleport a letter's 2-node chain so its centroid sits at `pos`, with zero
 * implicit velocity (`prev === x`). Mirrors the sibling `placeLetterAt` helper
 * in GameCore.tick.test.ts.
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

/** Spawn the SAME lines (deterministic ids `L{i}`) on a core; returns nothing. */
function spawnLines(core: GameCore, lines: string[][]): void {
  for (let i = 0; i < lines.length; i++) {
    core.spawnLine(makeLine(`L${i}`, lines[i]!.join(' ')));
  }
}

// --- Generators -------------------------------------------------------------

/** Non-whitespace characters: letters, digits, punctuation, Unicode, emoji. */
const wordCharArb = fc.constantFrom(
  'a', 'B', 'z', 'Q', '0', '7', '-', '_', '.', '!', '日', 'é', 'Ω', '🎤',
);

/** One WORD: a non-empty run of strictly non-whitespace characters. */
const wordArb: fc.Arbitrary<string> = fc.string({
  unit: wordCharArb,
  minLength: 1,
  maxLength: 6,
});

/** 1..5 words; joined by single spaces the `\S+` tokens equal these words. */
const wordsArb: fc.Arbitrary<string[]> = fc.array(wordArb, { minLength: 1, maxLength: 5 });

/** 1..3 lines, each a non-empty word list. */
const linesArb: fc.Arbitrary<string[][]> = fc.array(wordsArb, { minLength: 1, maxLength: 3 });

/** A bounded finite cursor coordinate (covers negatives, zero, out-of-bounds). */
const coordArb = fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true });

/** One scenario operation applied to the SOURCE core to build varied state. */
type Op =
  | { kind: 'grab'; letterNat: number; playerNat: number }
  | { kind: 'release'; letterNat: number; playerNat: number }
  | { kind: 'cursor'; playerNat: number; x: number; y: number }
  | { kind: 'place'; letterNat: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('grab' as const), letterNat: fc.nat(), playerNat: fc.nat() }),
  fc.record({ kind: fc.constant('release' as const), letterNat: fc.nat(), playerNat: fc.nat() }),
  fc.record({ kind: fc.constant('cursor' as const), playerNat: fc.nat(), x: coordArb, y: coordArb }),
  fc.record({ kind: fc.constant('place' as const), letterNat: fc.nat() }),
);

const opsArb: fc.Arbitrary<Op[]> = fc.array(opArb, { minLength: 0, maxLength: 12 });

/** 1..5 ticks so the source runs placement/steering at least once. */
const ticksArb = fc.integer({ min: 1, max: 5 });

const seedArb = fc.integer();

/**
 * Build varied authoritative state on `core` (already constructed + lines spawned)
 * by applying `ops` in order, then running `ticks` fixed steps.
 */
function applyScenario(core: GameCore, ops: Op[], ticks: number): void {
  for (const op of ops) {
    const letters = core.letters;
    switch (op.kind) {
      case 'grab': {
        const letter = letters[op.letterNat % letters.length]!;
        core.applyInput({
          type: 'grab',
          playerId: PLAYERS[op.playerNat % PLAYERS.length]!,
          letterId: letter.id,
          clientTick: 0,
        });
        break;
      }
      case 'release': {
        const letter = letters[op.letterNat % letters.length]!;
        core.applyInput({
          type: 'release',
          playerId: PLAYERS[op.playerNat % PLAYERS.length]!,
          letterId: letter.id,
        });
        break;
      }
      case 'cursor': {
        core.applyInput({
          type: 'cursor',
          playerId: PLAYERS[op.playerNat % PLAYERS.length]!,
          x: op.x,
          y: op.y,
        });
        break;
      }
      case 'place': {
        const letter = letters[op.letterNat % letters.length]!;
        const slots = core.getSolutionSlots(letter.lineId)!;
        const slot = slots[letter.correctIndex]!;
        placeLetterAt(letter, slot.position);
        break;
      }
    }
  }
  for (let i = 0; i < ticks; i++) core.tick(STEP);
}

// --- Property 37 ------------------------------------------------------------

describe('Property 37: Snapshot round trip reproduces authoritative state (Req 16.3)', () => {
  it('a target core with the SAME lines but a DIFFERENT seed reproduces the source snapshot (incl. idempotence)', () => {
    fc.assert(
      fc.property(
        seedArb,
        seedArb,
        linesArb,
        opsArb,
        ticksArb,
        (sourceSeed, targetSeedRaw, lines, ops, ticks) => {
          // Force the target seed to DIFFER so spawn jitter (initial positions)
          // differs — proving applySnapshot overwrites rather than relying on
          // equal spawns.
          const targetSeed = targetSeedRaw === sourceSeed ? sourceSeed + 1 : targetSeedRaw;

          // SOURCE: spawn the lines, build varied authoritative state, snapshot.
          const source = new GameCore(sourceSeed, makeConfig());
          spawnLines(source, lines);
          applyScenario(source, ops, ticks);
          const s = source.snapshot();

          // TARGET: SAME lines (identical ids/text => identical letter ids), but
          // a DIFFERENT construction seed => different spawn positions.
          const target = new GameCore(targetSeed, makeConfig());
          spawnLines(target, lines);

          target.applySnapshot(s);
          const t = target.snapshot();

          // Rope_Letter positions (x + prev) AND resting placement reproduced.
          expect(t.letters).toEqual(s.letters);
          // Ownership_Locks reproduced.
          expect(t.locks).toEqual(s.locks);
          // Cursor presence reproduced.
          expect(t.cursors).toEqual(s.cursors);
          // Authoritative tick reproduced.
          expect(t.tick).toBe(s.tick);
          // Provisional score reproduced (recomputed from applied placedSlot values).
          expect(t.provisionalScore).toBe(s.provisionalScore);
          // The getter agrees with the source's live provisional total.
          expect(target.provisionalScore).toBe(source.provisionalScore);

          // IDEMPOTENCE: applying the same snapshot again is a stable fixed point.
          target.applySnapshot(s);
          expect(target.snapshot()).toEqual(s);
        },
      ),
    );
  });
});
