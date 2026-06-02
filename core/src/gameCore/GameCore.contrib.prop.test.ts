import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { GameConfig, LyricLine, RopeLetter, PlayerId } from '../types/index.js';
import { GameCore } from './index.js';

/**
 * Property-based test for per-player contribution conservation (task 4.11).
 *
 * Property 29: Per-player contributions conserve the total.
 * Validates: Requirements 9.6.
 *
 * Design ("Correctness Properties" / Property 29): *For any* completed Round,
 * the sum of per-Player contribution counts equals the total number of
 * correctly placed Rope_Letters reflected in the Round total. Requirement 9.6:
 * "WHEN a Round ends, THE Game_Server SHALL produce a final Round result
 * including the total score and per-Player contribution counts."
 *
 * The unit under test is the pure `GameCore`: {@link GameCore.applyInput}
 * (grab/release → last-owner attribution), {@link GameCore.finalizeLine}
 * (credits exactly one contribution per correctly-ordered letter, to its last
 * owner or the `'__unowned__'` sentinel), and {@link GameCore.getRoundResult}
 * (`{ trackTitle, totalScore, contributions }`).
 *
 * ---------------------------------------------------------------------------
 * The conservation invariant (Property 29) — the core assertion
 * ---------------------------------------------------------------------------
 * For EVERY generated scenario:
 *
 *   sum(Object.values(getRoundResult().contributions)) === getRoundResult().totalScore
 *
 * This holds because `finalizeLine` credits exactly ONE contribution key per
 * correctly-ordered letter (`placedSlot === correctIndex`): the letter's last
 * owner, or the deterministic `'__unowned__'` sentinel when the letter was never
 * grabbed. Crediting the sentinel (rather than dropping never-owned correct
 * letters) is precisely what keeps the sum equal to the total even when some
 * correctly-placed letters were never grabbed.
 *
 * ---------------------------------------------------------------------------
 * Stronger per-key assertion (precise 9.6 attribution)
 * ---------------------------------------------------------------------------
 * Beyond the sum, we compute the EXACT expected `contributions` map from the
 * generated scenario decisions and assert deep equality, plus
 * `totalScore === number of correctly-placed letters`. This validates that:
 *  - each correctly-placed letter is credited to its LAST owner (the most recent
 *    player to GRAB it; release does NOT clear the last owner),
 *  - a correctly-placed letter that was NEVER grabbed is credited to
 *    `'__unowned__'` (and still counted, so the sum matches),
 *  - wrong/unplaced letters are NOT counted toward the total and NOT credited —
 *    even when they were grabbed (a grabbed-but-misplaced letter must not earn
 *    its grabber a contribution).
 *
 * ---------------------------------------------------------------------------
 * Last-owner model (matches the implementation exactly)
 * ---------------------------------------------------------------------------
 * `GameCore` sets `lastOwnerByLetter[id] = player` on every SUCCESSFUL grab and
 * NEVER clears it on release. A grab on a letter currently locked by ANOTHER
 * player is denied and does NOT change the last owner. In this test every grab
 * is immediately followed by a release by the same player, so the letter is
 * unlocked before the next grab and every grab in the sequence succeeds.
 * Therefore the last owner is simply the LAST player in the letter's generated
 * grab sequence, and an empty sequence means "never grabbed" → `'__unowned__'`
 * (only credited if the letter is correctly placed).
 *
 * ---------------------------------------------------------------------------
 * Grab/release/place sequencing (so placement is exactly as positioned)
 * ---------------------------------------------------------------------------
 * Grabbing pins node 0; if the letter were still held during `tick()`,
 * {@link GameCore.tick}'s steering would snap that node onto the owner's cursor
 * and move the letter off its intended placement. To set the last owner WITHOUT
 * disturbing placement we use the simplest safe order per letter:
 *
 *   1. for each grabber g in the sequence: applyInput(grab by g), applyInput(release by g)
 *      — sets the last owner to g and leaves the letter UNOWNED + UNPINNED;
 *   2. placeLetterAt(letter, target)  — teleport the (now free) chain onto its target;
 *   3. (after all letters across all lines are placed) tick() once;
 *   4. finalizeLine(each line).
 *
 * Because every letter is released before placement, no letter is steered during
 * the tick, so its centroid stays exactly where `placeLetterAt` put it and
 * `placedSlot` is deterministic.
 *
 * ---------------------------------------------------------------------------
 * Config: zero gravity AND zero collider radius (no drift, isolate scoring)
 * ---------------------------------------------------------------------------
 * We reuse the `makeConfig()` shape from GameCore.scoring.test.ts with two
 * deliberate changes so a positioned letter's centroid does NOT move during the
 * single `tick()` (which would make `placedSlot` — and thus the exact map —
 * non-deterministic):
 *  - `gravity: { x: 0, y: 0 }` — `placeLetterAt` sets `prev === x` (zero implicit
 *    velocity); with no gravity, Verlet integration leaves a free, at-rest,
 *    constraint-satisfied chain exactly where it is.
 *  - `colliderRadius: 0` — ALL Solution_Slots across EVERY line sit on a single
 *    shared answer row (`y = 0.85 * bounds.height`), so letters from different
 *    lines placed on the same slot x — and a "wrong" letter placed onto a slot
 *    that its line's correct letter also occupies — are COINCIDENT. With a
 *    nonzero radius `resolveOverlap` would push such coincident nodes apart
 *    during `tick()`, drifting centroids out of tolerance and changing
 *    `placedSlot`. Inter-letter stacking (Requirement 7.5) is orthogonal to
 *    contribution attribution (Requirement 9.6); zeroing the collider footprint
 *    isolates the scoring/attribution logic under test without weakening any
 *    assertion. (Zero gravity alone is NOT sufficient because the drift source
 *    here is the overlap push, not gravity.)
 *
 * numRuns is left at the global default (100, from vitest.setup.ts).
 */

/**
 * Representative config mirroring GameCore.scoring.test.ts, with `gravity` and
 * `colliderRadius` zeroed so positioned letters do not drift during `tick()`
 * (see the file header for the rationale).
 */
function makeConfig(): GameConfig {
  return {
    gravity: { x: 0, y: 0 }, // no drift: at-rest free chains stay put.
    damping: 0.98,
    constraintIterations: 8,
    subSteps: 1,
    defaultStiffness: 0.8,
    constraintTolerance: 0.5,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    restitution: 0.3,
    colliderRadius: 0, // disable inter-letter overlap push (isolate scoring).
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

/**
 * Teleport a letter's whole 2-node chain so its centroid sits exactly at `pos`
 * (copied from GameCore.scoring.test.ts). Both particles are placed
 * symmetrically around `pos` on the x-axis, preserving the chain's current
 * half-length, and `prev` is set to `x` so the implicit velocity is zero.
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

const STEP = 1000 / 30;

/** The sentinel key the implementation credits never-grabbed correct letters to. */
const UNOWNED = '__unowned__';

// --- Generators --------------------------------------------------------------

/** A small fixed player set (mirrors the multiplayer style of the scoring tests). */
const playerArb: fc.Arbitrary<PlayerId> = fc.constantFrom('p1', 'p2', 'p3');

/**
 * The ordered sequence of players who grab a letter (each grab is followed by a
 * release in the test, so every grab succeeds and the LAST entry is the letter's
 * last owner). An empty sequence means the letter is never grabbed.
 */
const grabbersArb: fc.Arbitrary<PlayerId[]> = fc.array(playerArb, { minLength: 0, maxLength: 3 });

/** What the test does with a letter's final position. */
type Placement = 'correct' | 'wrong' | 'unplaced';
const placementArb: fc.Arbitrary<Placement> = fc.constantFrom('correct', 'wrong', 'unplaced');

interface LetterDecision {
  grabbers: PlayerId[];
  placement: Placement;
}

const letterDecisionArb: fc.Arbitrary<LetterDecision> = fc.record({
  grabbers: grabbersArb,
  placement: placementArb,
});

/** A line is 1..5 letters; each entry decides that token's grabbers + placement. */
const lineArb: fc.Arbitrary<LetterDecision[]> = fc.array(letterDecisionArb, {
  minLength: 1,
  maxLength: 5,
});

/** A scenario is 1..4 lines. */
const scenarioArb: fc.Arbitrary<LetterDecision[][]> = fc.array(lineArb, {
  minLength: 1,
  maxLength: 4,
});

/** Any 32-bit unsigned seed (the PRNG coerces via `>>> 0`). */
const seedArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 0xffffffff });

/** A position guaranteed to be outside every Solution_Slot tolerance (slots sit on the bottom row). */
const UNPLACED_POS = { x: 400, y: 30 } as const;

describe('Property 29: Per-player contributions conserve the total (Req 9.6)', () => {
  it('contributions sum to the total and exactly match the per-key attribution model', () => {
    fc.assert(
      fc.property(scenarioArb, seedArb, (scenario, seed) => {
        const config = makeConfig();
        const core = new GameCore(seed, config);

        // --- Apply the scenario -------------------------------------------
        scenario.forEach((line, li) => {
          const lineId = `L${li}`;
          const n = line.length;
          // n words joined by single spaces → exactly n non-whitespace tokens.
          const text = Array.from({ length: n }, () => 'wd').join(' ');
          core.spawnLine(makeLine(lineId, text));

          const slots = core.getSolutionSlots(lineId)!;

          line.forEach((decision, i) => {
            const letterId = `${lineId}:${i}`;
            const letter = core.letters.find((l) => l.id === letterId)!;

            // 1) Set the last owner via grab+release (leaves the letter unowned).
            for (const g of decision.grabbers) {
              core.applyInput({ type: 'grab', playerId: g, letterId, clientTick: 0 });
              core.applyInput({ type: 'release', playerId: g, letterId });
            }

            // 2) Position per the placement decision.
            if (decision.placement === 'correct') {
              placeLetterAt(letter, slots[i]!.position); // centroid on its own slot.
            } else if (decision.placement === 'wrong' && n >= 2) {
              const j = (i + 1) % n; // a different slot of the same line (j !== i).
              placeLetterAt(letter, slots[j]!.position);
            } else {
              // 'unplaced', or 'wrong' on a 1-token line (no other slot exists):
              // park it far from the answer row so placedSlot resolves to null.
              placeLetterAt(letter, UNPLACED_POS);
            }
          });
        });

        // 3) One tick evaluates placement for every letter (no drift here).
        core.tick(STEP);

        // 4) Close every line's drop window (credits contributions).
        scenario.forEach((_line, li) => core.finalizeLine(`L${li}`));

        // --- Expected attribution model -----------------------------------
        // A letter is correctly placed iff its decision is 'correct' (we always
        // place such a letter exactly on its own slot → placedSlot === correctIndex).
        const expectedContributions: Record<PlayerId, number> = {};
        let expectedCorrectCount = 0;
        for (const line of scenario) {
          for (const decision of line) {
            if (decision.placement !== 'correct') continue; // wrong/unplaced: not counted.
            expectedCorrectCount += 1;
            const contributor =
              decision.grabbers.length > 0
                ? decision.grabbers[decision.grabbers.length - 1]! // last owner.
                : UNOWNED; // never grabbed → sentinel.
            expectedContributions[contributor] = (expectedContributions[contributor] ?? 0) + 1;
          }
        }

        const result = core.getRoundResult();

        // (A) totalScore equals the number of correctly-placed letters (9.4/9.5).
        expect(result.totalScore).toBe(expectedCorrectCount);

        // (B) CONSERVATION (Property 29): contributions sum to the total.
        const sum = Object.values(result.contributions).reduce((a, b) => a + b, 0);
        expect(sum).toBe(result.totalScore);

        // (C) EXACT per-key attribution (stronger than the sum): each player's
        //     count equals the number of correctly-placed letters whose last
        //     owner is that player, and the '__unowned__' sentinel appears iff
        //     there are never-owned correct letters (9.6 attribution precisely).
        expect(result.contributions).toEqual(expectedContributions);
      }),
    );
  });
});
