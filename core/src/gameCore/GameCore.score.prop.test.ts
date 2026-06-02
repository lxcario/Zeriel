import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { GameConfig, LyricLine, RopeLetter, SolutionSlot } from '../types/index.js';
import { GameCore } from './index.js';

/**
 * Property-based test for score correctness (task 4.9).
 *
 * Property 27: Score equals the count of correctly ordered letters.
 * **Validates: Requirements 9.3, 9.4**
 *
 * Design ("Correctness Properties" / Property 27): *For any* arrangement of
 * Rope_Letters within a Lyric_Line, both the provisional score (at any moment
 * during the drop window) and the finalized score (at window close) equal the
 * number of Rope_Letters whose placed Solution_Slot matches their correct index.
 *
 * Requirement 9.3: while a Lyric_Line's drop window is OPEN, the provisional
 * per-line score is updated in real time as Rope_Letters are placed into
 * matching Solution_Slots. Requirement 9.4: when the window closes, the per-line
 * score is finalized equal to the count of Rope_Letters whose placed
 * Solution_Slot matches the correct order.
 *
 * The unit under test is the pure {@link GameCore}: {@link GameCore.spawnLine}
 * (which lays out one letter + one slot per token, letter `i` carrying
 * `correctIndex === i` and slot `i` on an answer row across `config.bounds`),
 * {@link GameCore.tick} (which evaluates Solution_Slot placement and refreshes
 * the open line's provisional score as its LAST step), {@link GameCore.getLineScore},
 * the {@link GameCore.provisionalScore} getter, and {@link GameCore.finalizeLine}.
 *
 * ---------------------------------------------------------------------------
 * Zero-physics isolation (why this config disables gravity AND collisions)
 * ---------------------------------------------------------------------------
 * Property 27 is about the *score equalling the count of correctly-ordered
 * letters*, NOT about the physics. `tick()` runs the full deterministic step
 * sequence (integrate → relax → bounds → overlap → evaluate placement). To make
 * a letter's post-tick `placedSlot` a PURE function of where this test positions
 * it, both physics movers are neutralized so a resting, exactly-positioned
 * letter does not drift before placement is evaluated:
 *
 *  - `gravity: { x: 0, y: 0 }` — with `prev === x` (a letter at rest) and zero
 *    acceleration, Verlet integration leaves every particle exactly in place,
 *    and the distance constraint is already satisfied (the span equals the rest
 *    length), so the chain does not move. (Falling physics is covered by the
 *    Verlet/bounds properties 18–19.)
 *  - `colliderRadius: 0` — disables the inter-letter overlap (stacking) pass
 *    ({@link resolveOverlap} skips letters whose summed radius is `<= 0`). The
 *    "wrong"-placement scheme below intentionally drops a letter onto a slot
 *    that may ALSO hold a correctly-placed letter; with a non-zero radius the
 *    stacking pass would push those co-located letters apart and perturb their
 *    centroids before placement is evaluated. Stacking correctness is a separate
 *    concern (Property 20); neutralizing it here isolates the placement→score
 *    mapping that Property 27 is actually about.
 *
 * Everything else mirrors the makeConfig() shape from GameCore.scoring.test.ts.
 *
 * ---------------------------------------------------------------------------
 * Generator design
 * ---------------------------------------------------------------------------
 * A line of `n` words (`n` in 1..6, single-char words so every chain is tiny and
 * provably stays in-bounds), plus a per-letter placement DECISION array of
 * length `n` over `{ 'correct' | 'wrong' | 'unplaced' }`:
 *
 *  - 'correct'  → centroid placed exactly on the letter's OWN correct slot
 *                 (`slot[correctIndex]`). Distance 0 ⇒ nearest slot is that slot
 *                 ⇒ `placedSlot === correctIndex` ⇒ counted.
 *  - 'wrong'    → centroid placed exactly on a DIFFERENT slot, `slot[(i+1) % n]`.
 *                 Because every letter sits exactly on a slot CENTRE (distance 0)
 *                 and slot x-positions are strictly increasing (distinct), the
 *                 nearest in-tolerance slot is precisely that wrong slot, so
 *                 `placedSlot === (i+1) % n !== correctIndex` ⇒ NOT counted.
 *                 For `n >= 2`, `(i+1) % n !== i`, so the wrong target is always a
 *                 real, different slot.
 *  - 'unplaced' → centroid placed far above the answer row (in the spawn band,
 *                 `y = 10`) while the answer row sits at `y = 0.85 * 600 = 510`.
 *                 The vertical gap alone (>= 500) exceeds the placement tolerance
 *                 (24) for EVERY slot ⇒ `placedSlot === null` ⇒ NOT counted.
 *
 * `n === 1` handling: there is no "different" slot, so a 'wrong' decision
 * degenerates and is mapped to 'unplaced' for `n === 1` (documented). Thus a
 * single-word line only ever sees 'correct' or 'unplaced'.
 *
 * Expected correct count = number of 'correct' decisions (after the `n === 1`
 * remap). This equals the count of letters with `placedSlot === correctIndex`,
 * which the test ALSO recomputes from the real post-tick `placedSlot` values as a
 * cross-check that each placement landed where intended.
 *
 * ---------------------------------------------------------------------------
 * Assertions (per generated case)
 * ---------------------------------------------------------------------------
 *  1. CROSS-CHECK: the count of letters with `placedSlot === correctIndex` after
 *     tick equals the expected count derived from the decisions (the placements
 *     landed exactly as intended — no "wrong" accidentally became "correct").
 *  2. PROVISIONAL (9.3, window open): `getLineScore(L).provisional` equals the
 *     expected correct count, and `finalized` is still `null`.
 *  3. provisionalScore getter (single line, window open) equals the expected count.
 *  4. FINALIZE (9.4): after `finalizeLine(L)`, `finalized` equals the same count
 *     and `provisional` is frozen equal to `finalized`.
 *  5. provisionalScore getter (window closed) equals the finalized count.
 *
 * numRuns is left at the global default (100, from vitest.setup.ts).
 */

/** Reused makeConfig() shape, with gravity AND collisions neutralized (see the file doc). */
function makeConfig(): GameConfig {
  return {
    gravity: { x: 0, y: 0 }, // no integration drift for a resting letter.
    damping: 0.98,
    constraintIterations: 8,
    subSteps: 1,
    defaultStiffness: 0.8,
    constraintTolerance: 0.5,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    restitution: 0.3,
    colliderRadius: 0, // disable inter-letter overlap so co-located placements don't drift.
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
 * Teleport a letter's whole 2-node chain so its centroid sits exactly at `pos`
 * (replicated from GameCore.scoring.test.ts). Both particles are placed
 * symmetrically around `pos` on the x-axis, preserving the chain's current
 * half-length, so the centroid (mean) equals `pos`, and `prev === x` so the
 * letter is at rest.
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

/** The letter whose `correctIndex === i`, asserted present (one per index by Property 25). */
function letterFor(core: GameCore, i: number): RopeLetter {
  const letter = core.letters.find((l) => l.correctIndex === i);
  if (!letter) throw new Error(`no letter for correctIndex ${i}`);
  return letter;
}

/** Single-char words 'a'..'f' so a line of n words has n single-character tokens. */
const WORD_ALPHABET = ['a', 'b', 'c', 'd', 'e', 'f'] as const;

/** Build the lyric text for a line of `n` single-char words (n in 1..6). */
function lineText(n: number): string {
  return WORD_ALPHABET.slice(0, n).join(' ');
}

type Decision = 'correct' | 'wrong' | 'unplaced';

/**
 * Position letter `i` according to its decision and return the EFFECTIVE
 * decision actually applied (a 'wrong' on a single-word line degenerates to
 * 'unplaced'). 'unplaced' sits in the spawn band, far above the answer row.
 */
function positionLetter(core: GameCore, lineId: string, i: number, n: number, decision: Decision): Decision {
  const letter = letterFor(core, i);
  const effective: Decision = decision === 'wrong' && n === 1 ? 'unplaced' : decision;

  switch (effective) {
    case 'correct':
      placeLetterAt(letter, slotFor(core, lineId, i).position);
      break;
    case 'wrong':
      placeLetterAt(letter, slotFor(core, lineId, (i + 1) % n).position);
      break;
    case 'unplaced':
      // Far above the answer row (y = 510): the vertical gap alone exceeds tolerance.
      placeLetterAt(letter, { x: slotFor(core, lineId, i).position.x, y: 10 });
      break;
  }
  return effective;
}

/** Count letters whose placed slot matches their correct index (the Property-27 quantity). */
function countCorrectlyOrdered(core: GameCore): number {
  let count = 0;
  for (const letter of core.letters) {
    if (letter.placedSlot === letter.correctIndex) count += 1;
  }
  return count;
}

// --- Generators --------------------------------------------------------------

const seedArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 0xffffffff });

/** A case is an `n` in 1..6 with a length-`n` per-letter decision array. */
const caseArb = fc.integer({ min: 1, max: 6 }).chain((n) =>
  fc.record({
    n: fc.constant(n),
    decisions: fc.array(fc.constantFrom<Decision>('correct', 'wrong', 'unplaced'), {
      minLength: n,
      maxLength: n,
    }),
  }),
);

describe('Property 27: Score equals the count of correctly ordered letters (Req 9.3, 9.4)', () => {
  it('provisional and finalized scores equal the count of letters placed on their own correct slot', () => {
    fc.assert(
      fc.property(caseArb, seedArb, ({ n, decisions }, seed) => {
        const core = new GameCore(seed, makeConfig());
        const line = makeLine('L', lineText(n));
        core.spawnLine(line);
        expect(core.letters.length).toBe(n); // sanity: one letter per word.

        // Position every letter per its decision; tally the expected correct count.
        let expectedCorrect = 0;
        for (let i = 0; i < n; i++) {
          const effective = positionLetter(core, 'L', i, n, decisions[i]!);
          if (effective === 'correct') expectedCorrect += 1;
        }

        // Run the full deterministic tick once (placement + provisional scoring run last).
        core.tick(STEP);

        // (1) CROSS-CHECK: placements landed exactly as intended.
        expect(countCorrectlyOrdered(core)).toBe(expectedCorrect);

        // (2) PROVISIONAL (9.3) — window still open.
        const open = core.getLineScore('L')!;
        expect(open.finalized).toBeNull();
        expect(open.provisional).toBe(expectedCorrect);

        // (3) provisionalScore getter (single line, window open).
        expect(core.provisionalScore).toBe(expectedCorrect);

        // (4) FINALIZE (9.4) — frozen equal to the correct count.
        core.finalizeLine('L');
        const closed = core.getLineScore('L')!;
        expect(closed.finalized).toBe(expectedCorrect);
        expect(closed.provisional).toBe(expectedCorrect); // provisional frozen to finalized.

        // (5) provisionalScore getter (window closed) reads the finalized value.
        expect(core.provisionalScore).toBe(expectedCorrect);
      }),
    );
  });

  it('all-correct yields provisional === n and finalized === n (n in 1..6)', () => {
    for (let n = 1; n <= 6; n++) {
      const core = new GameCore(n, makeConfig());
      const line = makeLine('L', lineText(n));
      core.spawnLine(line);
      for (let i = 0; i < n; i++) positionLetter(core, 'L', i, n, 'correct');
      core.tick(STEP);

      expect(core.getLineScore('L')!.provisional).toBe(n);
      expect(core.provisionalScore).toBe(n);
      core.finalizeLine('L');
      expect(core.getLineScore('L')!.finalized).toBe(n);
      expect(core.provisionalScore).toBe(n);
    }
  });

  it('all-wrong yields 0 (n in 2..6; n === 1 has no wrong slot)', () => {
    for (let n = 2; n <= 6; n++) {
      const core = new GameCore(n, makeConfig());
      const line = makeLine('L', lineText(n));
      core.spawnLine(line);
      for (let i = 0; i < n; i++) positionLetter(core, 'L', i, n, 'wrong');
      core.tick(STEP);

      expect(core.getLineScore('L')!.provisional).toBe(0);
      expect(core.provisionalScore).toBe(0);
      core.finalizeLine('L');
      expect(core.getLineScore('L')!.finalized).toBe(0);
      expect(core.provisionalScore).toBe(0);
    }
  });

  it('all-unplaced yields 0 (n in 1..6)', () => {
    for (let n = 1; n <= 6; n++) {
      const core = new GameCore(n, makeConfig());
      const line = makeLine('L', lineText(n));
      core.spawnLine(line);
      for (let i = 0; i < n; i++) positionLetter(core, 'L', i, n, 'unplaced');
      core.tick(STEP);

      expect(core.getLineScore('L')!.provisional).toBe(0);
      expect(core.provisionalScore).toBe(0);
      core.finalizeLine('L');
      expect(core.getLineScore('L')!.finalized).toBe(0);
      expect(core.provisionalScore).toBe(0);
    }
  });
});
