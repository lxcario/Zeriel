import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { GameConfig, LyricLine, RopeLetter, SolutionSlot } from '../types/index.js';
import { GameCore } from './index.js';

/**
 * Property-based test for round-total summation (task 4.10).
 *
 * Property 28: Round total is the sum of finalized line scores.
 * **Validates: Requirements 9.5**
 *
 * Design ("Correctness Properties" / Property 28): *For any* set of finalized
 * per-line scores, the Round total equals their sum. Requirement 9.5: "THE
 * Game_Server SHALL accumulate finalized per-line scores into a Round total
 * score." The unit under test is the pure {@link GameCore}: {@link GameCore.spawnLine}
 * builds each line's `0..n-1` Solution_Slot row, {@link GameCore.finalizeLine}
 * freezes a line's `finalized` = count of its correctly-ordered letters, and
 * {@link GameCore.getRoundResult}'s `totalScore` sums all FINALIZED per-line
 * scores (open/unfinalized lines contribute 0).
 *
 * ---------------------------------------------------------------------------
 * Why this test configures away the physics (faithful to Property 28)
 * ---------------------------------------------------------------------------
 * Property 28 is purely about ARITHMETIC over finalized per-line scores — it is
 * NOT a physics property. To make "centroid placed on a slot ⇒ `placedSlot ===
 * correctIndex`" exact and tick-stable, the config neutralizes the two ways a
 * positioned letter could drift inside `tick()`'s full physics sequence:
 *
 *  - **`gravity = { x: 0, y: 0 }`** — positioned letters start at rest
 *    (`prev === x`, zero implicit velocity), so Verlet integration leaves them
 *    fixed; without gravity there is no acceleration to move them.
 *  - **`colliderRadius = 0`** — disables inter-letter overlap resolution
 *    (`resolveOverlap` skips pairs whose summed radius is `<= 0`). This matters
 *    because the implementation lays EVERY line's answer-row Solution_Slots on a
 *    single shared `y` row; two different lines that each place a correct letter
 *    at a coinciding slot `x` would otherwise be pushed apart by overlap
 *    resolution (compounding across the per-line ticks) and could fall out of
 *    tolerance — a physics artifact wholly unrelated to the summation being
 *    tested. Removing the collider footprint isolates Property 28.
 *
 * Everything else mirrors `makeConfig()` from GameCore.scoring.test.ts, and the
 * `placeLetterAt` helper is reused verbatim. The constraint solver still runs but
 * is a no-op here: `placeLetterAt` preserves each 2-node chain's rest length, so
 * no constraint is violated. Bounds clamping is a no-op too (all positions lie
 * inside `bounds`). The result: after any number of `tick()`s, a letter whose
 * centroid was placed exactly on its correct slot has `placedSlot === correctIndex`
 * deterministically, so each line's finalized score is EXACTLY its generated
 * correct-count `c_k`. The property under test (totalScore === sum of finalized)
 * is then exercised with full strength.
 *
 * ---------------------------------------------------------------------------
 * Generator design (multi-line)
 * ---------------------------------------------------------------------------
 * Each run generates a SET of `K ∈ 1..5` lines. Line `k` gets id `L${k}`, a word
 * count `n_k ∈ 1..5`, and a correct-count `c_k ∈ 0..n_k`. The line's text is
 * `n_k` distinct space-separated word tokens (`w0 w1 ...`), so `spawnLine`
 * tokenizes it into exactly `n_k` rope-letters / slots. For that line, the
 * letters with `correctIndex` `0..c_k-1` are teleported (via `placeLetterAt`) so
 * their centroid sits EXACTLY on their own correct slot center (⇒ correctly
 * ordered), and the remaining `c_k..n_k-1` letters are parked far above in the
 * spawn band (`y = 10`), distance `>> placementTolerance` from every answer-row
 * slot (⇒ `placedSlot = null`, not counted). Thus the finalized score of line
 * `k` is exactly `c_k` by construction.
 *
 * ---------------------------------------------------------------------------
 * Strands (each a numRuns=100 property at the global default)
 * ---------------------------------------------------------------------------
 *  1. FULL FINALIZATION — finalize every line, then assert
 *     `getRoundResult().totalScore === Σ c_k`, cross-checked against
 *     `Σ getLineScore(lineId).finalized`, and that each line's `finalized === c_k`.
 *  2. PARTIAL FINALIZATION — finalize only a generated SUBSET of lines; assert
 *     the total equals the finalized subset's `c_k` sum only, and that every
 *     unfinalized line stays open (`finalized === null`, contributing 0).
 *  3. ORDER-INDEPENDENCE — finalizing the lines in a generated (shuffled) order
 *     yields the same total as natural order, both equal to `Σ c_k`.
 *
 * If a genuine summation bug surfaces, the strand fails with fast-check's
 * shrunk counterexample — do not patch it away.
 */

/**
 * Representative config — the `makeConfig()` shape from GameCore.scoring.test.ts
 * with `gravity = {x:0,y:0}` and `colliderRadius = 0` (see the header rationale)
 * so positioned letters neither fall nor get pushed apart between ticks.
 */
function makeConfig(): GameConfig {
  return {
    gravity: { x: 0, y: 0 },
    damping: 0.98,
    constraintIterations: 8,
    subSteps: 1,
    defaultStiffness: 0.8,
    constraintTolerance: 0.5,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    restitution: 0.3,
    colliderRadius: 0,
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

/** Deterministic construction seed (a fixed value keeps spawns reproducible). */
const SEED = 0x5eed_28;

/**
 * Teleport a letter's whole 2-node chain so its centroid sits exactly at `pos`
 * (reused verbatim from GameCore.scoring.test.ts). Both particles are placed
 * symmetrically around `pos` on the x-axis, preserving the chain's current
 * half-length, so the centroid (mean) equals `pos` and the rest length is
 * unchanged (the constraint solver stays a no-op).
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

/** The Solution_Slot for a given correct index of a line, asserted present. */
function slotFor(core: GameCore, lineId: string, index: number): SolutionSlot {
  const slots = core.getSolutionSlots(lineId);
  if (!slots) throw new Error(`no slots for ${lineId}`);
  const slot = slots.find((s) => s.index === index);
  if (!slot) throw new Error(`no slot index ${index}`);
  return slot;
}

/** Per-line generation spec: `n` word tokens, of which `c` are placed correctly. */
interface LineSpec {
  n: number;
  c: number;
}

/**
 * Spawn every line and position its letters WITHOUT finalizing or ticking:
 * letters `0..c-1` land exactly on their own correct slot; letters `c..n-1` are
 * parked far above in the spawn band (`y = 10`, distance `>> tolerance` from the
 * answer row) so they are unplaced. Returns the core plus the ordered line ids
 * (`lineIds[k]` aligns with `specs[k]`).
 */
function buildCore(specs: readonly LineSpec[]): { core: GameCore; lineIds: string[] } {
  const core = new GameCore(SEED, makeConfig());
  const lineIds: string[] = [];

  // Spawn all lines first so every slot row exists before placement.
  specs.forEach((spec, k) => {
    const id = `L${k}`;
    lineIds.push(id);
    const text = Array.from({ length: spec.n }, (_, i) => `w${i}`).join(' ');
    core.spawnLine(makeLine(id, text));
  });

  // Place each line's letters: correct ones on their slot, the rest far above.
  specs.forEach((spec, k) => {
    const id = lineIds[k]!;
    for (let i = 0; i < spec.n; i++) {
      const letter = core.letters.find((l) => l.lineId === id && l.correctIndex === i)!;
      if (i < spec.c) {
        placeLetterAt(letter, slotFor(core, id, i).position); // exactly on correct slot.
      } else {
        // Far above in the spawn band, > tolerance from every (y = answer-row) slot.
        placeLetterAt(letter, { x: 10 + i, y: 10 });
      }
    }
  });

  return { core, lineIds };
}

/** Build, then settle placement by ticking once per line (idempotent here). */
function buildAndSettle(specs: readonly LineSpec[]): { core: GameCore; lineIds: string[] } {
  const built = buildCore(specs);
  for (let i = 0; i < built.lineIds.length; i++) built.core.tick(STEP);
  return built;
}

// --- Generators --------------------------------------------------------------

/** A single line: `n ∈ 1..5` tokens, correct-count `c ∈ 0..n`. */
const lineSpecArb: fc.Arbitrary<LineSpec> = fc
  .integer({ min: 1, max: 5 })
  .chain((n) => fc.record({ n: fc.constant(n), c: fc.integer({ min: 0, max: n }) }));

/** A set of `K ∈ 1..5` lines. */
const specsArb: fc.Arbitrary<LineSpec[]> = fc.array(lineSpecArb, { minLength: 1, maxLength: 5 });

/** A line that also carries whether it will be finalized (partial-finalization strand). */
interface PartialSpec extends LineSpec {
  finalize: boolean;
}

const partialSpecsArb: fc.Arbitrary<PartialSpec[]> = fc.array(
  fc
    .integer({ min: 1, max: 5 })
    .chain((n) =>
      fc.record({ n: fc.constant(n), c: fc.integer({ min: 0, max: n }), finalize: fc.boolean() }),
    ),
  { minLength: 1, maxLength: 5 },
);

/** A set of lines paired with a sort-key per line, used to derive a shuffled finalize order. */
const specsWithOrderArb: fc.Arbitrary<[LineSpec[], number[]]> = specsArb.chain((specs) =>
  fc.tuple(
    fc.constant(specs),
    fc.array(fc.integer({ min: 0, max: 1_000_000 }), {
      minLength: specs.length,
      maxLength: specs.length,
    }),
  ),
);

describe('Property 28: Round total is the sum of finalized line scores (Req 9.5)', () => {
  it('totalScore equals the sum of every finalized line score', () => {
    fc.assert(
      fc.property(specsArb, (specs) => {
        const { core, lineIds } = buildCore(specs);

        // For each line: tick() once (placement updates), then finalizeLine.
        lineIds.forEach((id) => {
          core.tick(STEP);
          core.finalizeLine(id);
        });

        const expectedTotal = specs.reduce((sum, s) => sum + s.c, 0);
        const result = core.getRoundResult();

        // (A) Round total === Σ c_k (the per-line correct counts).
        expect(result.totalScore).toBe(expectedTotal);

        // (B) Cross-check: each line finalized to exactly its c_k, and the total
        //     equals the sum of those finalized per-line scores.
        let sumFinalized = 0;
        specs.forEach((spec, k) => {
          const ls = core.getLineScore(lineIds[k]!)!;
          expect(ls.finalized).toBe(spec.c);
          sumFinalized += ls.finalized!;
        });
        expect(result.totalScore).toBe(sumFinalized);
      }),
    );
  });

  it('partial finalization: total counts only finalized lines; open lines contribute 0', () => {
    fc.assert(
      fc.property(partialSpecsArb, (specs) => {
        const { core, lineIds } = buildCore(specs);

        // Settle placement for all lines, then finalize ONLY the chosen subset.
        for (let i = 0; i < lineIds.length; i++) core.tick(STEP);
        specs.forEach((spec, k) => {
          if (spec.finalize) core.finalizeLine(lineIds[k]!);
        });

        // Total equals the sum of c_k over FINALIZED lines only.
        const expectedTotal = specs.reduce((sum, s) => sum + (s.finalize ? s.c : 0), 0);
        expect(core.getRoundResult().totalScore).toBe(expectedTotal);

        // Finalized lines froze at c_k; open lines stay null (contribute 0).
        specs.forEach((spec, k) => {
          const ls = core.getLineScore(lineIds[k]!)!;
          if (spec.finalize) {
            expect(ls.finalized).toBe(spec.c);
          } else {
            expect(ls.finalized).toBeNull();
          }
        });
      }),
    );
  });

  it('the order of finalizeLine calls does not change the total', () => {
    fc.assert(
      fc.property(specsWithOrderArb, ([specs, keys]) => {
        const expectedTotal = specs.reduce((sum, s) => sum + s.c, 0);

        // A shuffled finalize order: line indices sorted by their generated keys
        // (stable sort; ties keep natural order). This is a permutation of 0..K-1.
        const shuffledOrder = keys
          .map((_, idx) => idx)
          .sort((a, b) => keys[a]! - keys[b]!);

        // Finalize in the shuffled order.
        const shuffled = buildAndSettle(specs);
        shuffledOrder.forEach((k) => shuffled.core.finalizeLine(shuffled.lineIds[k]!));

        // Finalize in natural order on an identical, independent core.
        const natural = buildAndSettle(specs);
        natural.lineIds.forEach((id) => natural.core.finalizeLine(id));

        const shuffledTotal = shuffled.core.getRoundResult().totalScore;
        const naturalTotal = natural.core.getRoundResult().totalScore;

        expect(shuffledTotal).toBe(expectedTotal);
        expect(naturalTotal).toBe(expectedTotal);
        expect(shuffledTotal).toBe(naturalTotal); // order-independent.
      }),
    );
  });
});
