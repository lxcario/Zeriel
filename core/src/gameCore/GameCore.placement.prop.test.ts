import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { GameConfig, LyricLine, RopeLetter, SolutionSlot } from '../types/index.js';
import { GameCore } from './index.js';

/**
 * Property-based test for tolerance-based placement (task 4.8).
 *
 * Property 26: Placement marking respects tolerance.
 * **Validates: Requirements 9.2**
 *
 * Design ("Correctness Properties" / Property 26): *For any* Rope_Letter at
 * rest, it is marked as placed in Solution_Slot S if and only if it lies within
 * S's position tolerance (of the nearest slot); otherwise its placed slot is
 * null. Requirement 9.2: WHEN a Rope_Letter comes to rest within the position
 * tolerance of a Solution_Slot, THE Game_Server SHALL mark that Rope_Letter as
 * placed in that Solution_Slot.
 *
 * The unit under test is the pure {@link GameCore}: {@link GameCore.spawnLine}
 * (which lays out one letter + one slot per token; slot `i` sits on a single
 * answer row at `x = (i + 0.5)/n * bounds.width`, `y = 0.85 * bounds.height`
 * with `tolerance = config.placementTolerance`), and {@link GameCore.tick},
 * whose LAST step evaluates Solution_Slot placement (the private
 * `evaluatePlacement`). Placement is read back via `core.letters[k].placedSlot`
 * and the slot geometry via {@link GameCore.getSolutionSlots}.
 *
 * Placement contract (from the implementation): each tick the engine sets each
 * letter's `placedSlot` to the index of the NEAREST Solution_Slot of its line
 * whose distance from the letter's CENTROID (mean of its particle x positions)
 * is `<= slot.tolerance`; ties break to the lowest slot index; no slot within
 * tolerance ⇒ `placedSlot = null`. The boundary is INCLUSIVE (`<= tolerance`).
 *
 * ---------------------------------------------------------------------------
 * Zero-gravity + zero-collider isolation (why this config disables physics)
 * ---------------------------------------------------------------------------
 * Property 26 is about the *tolerance test*, NOT the physics. `tick()` runs the
 * FULL deterministic step sequence (integrate → relax → bounds → overlap →
 * evaluate placement). To make a positioned, at-rest letter's post-tick
 * `placedSlot` a PURE function of where this test places its centroid, both
 * physics movers are neutralized so it does NOT drift before placement is read:
 *
 *  - `gravity: { x: 0, y: 0 }` — with `prev === x` (a letter at rest) and zero
 *    acceleration, Verlet integration leaves every particle exactly in place,
 *    and the single distance constraint is already satisfied (the span equals
 *    the rest length), so the chain does not move. Falling/settling physics is
 *    covered by the Verlet/bounds properties 18–19, not here.
 *  - `colliderRadius: 0` — disables the inter-letter overlap (stacking) pass, so
 *    the (unmoved) other letters of a multi-word line cannot perturb the target
 *    letter's centroid. Stacking correctness is Property 20, not here.
 *
 * Generated offsets are additionally kept SMALL ENOUGH that the positioned
 * centroid (and both chain nodes) stay strictly inside `config.bounds`, so the
 * bounds-clamp pass never moves the letter either (see the spacing/bounds
 * analysis on each strand). Net effect: `tick()` reduces to "evaluate placement
 * on exactly the centroid this test set", which is precisely what Property 26
 * tests. Everything else mirrors the makeConfig() shape from
 * GameCore.scoring.test.ts.
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
    colliderRadius: 0, // disable inter-letter overlap so co-located letters don't drift.
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

/** The configured placement tolerance (mirrors makeConfig().placementTolerance). */
const TOLERANCE = 24;

/**
 * Margin (px) excluded around the exact tolerance boundary so generated
 * magnitudes never land within ~1e-3 of `tolerance`. This avoids float ties at
 * the boundary: "inside" magnitudes are <= `tolerance - MARGIN` (strictly inside)
 * and "outside" magnitudes are >= `tolerance + MARGIN` (strictly outside). The
 * implementation's boundary is INCLUSIVE (`distance <= tolerance` ⇒ placed); we
 * deliberately do not probe the exact-equality point, so the inclusive boundary
 * is respected by construction (no generated case can falsify it).
 */
const MARGIN = 1e-3;

/**
 * Teleport a letter's whole 2-node chain so its centroid sits exactly at `pos`
 * (replicated from GameCore.scoring.test.ts). Both particles are placed
 * symmetrically around `pos` on the x-axis, preserving the chain's current
 * half-length, so the centroid (mean) equals `pos` exactly, and `prev === x` so
 * the letter is at rest (zero implicit velocity).
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

/** The Solution_Slot for a given index, asserted present. */
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

/** Single-char words 'a'..'e' so a line of n words has n single-character tokens. */
const WORD_ALPHABET = ['a', 'b', 'c', 'd', 'e'] as const;

/** Build the lyric text for a line of `n` single-char words (n in 1..5). */
function lineText(n: number): string {
  return WORD_ALPHABET.slice(0, n).join(' ');
}

// --- Generators --------------------------------------------------------------

const seedArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 0xffffffff });

/** A direction angle in [0, 2π); the offset is `magnitude * (cos θ, sin θ)`. */
const angleArb: fc.Arbitrary<number> = fc.double({
  min: 0,
  max: 2 * Math.PI,
  noNaN: true,
  noDefaultInfinity: true,
});

/** A unit fraction in [0, 1], used to interpolate within an inside/outside magnitude band. */
const unitArb: fc.Arbitrary<number> = fc.double({
  min: 0,
  max: 1,
  noNaN: true,
  noDefaultInfinity: true,
});

/** Whether a case probes a magnitude strictly INSIDE or strictly OUTSIDE the tolerance. */
const sideArb: fc.Arbitrary<'inside' | 'outside'> = fc.constantFrom('inside', 'outside');

/**
 * Map a unit fraction into a magnitude band:
 *  - inside  → [0, tolerance - MARGIN]                (strictly within tolerance)
 *  - outside → [tolerance + MARGIN, outsideMax]        (strictly beyond tolerance)
 *
 * `outsideMax` is the largest "outside" magnitude that keeps the letter (a) in
 * bounds and (b) — for the multi-slot strand — outside every OTHER slot's
 * tolerance too. See each strand's analysis for the value passed.
 */
function magnitudeFor(side: 'inside' | 'outside', unit: number, outsideMax: number): number {
  if (side === 'inside') return unit * (TOLERANCE - MARGIN);
  const lo = TOLERANCE + MARGIN;
  return lo + unit * (outsideMax - lo);
}

describe('Property 26: Placement marking respects tolerance (Req 9.2)', () => {
  /**
   * STRAND 1 — single slot (cleanest tolerance test).
   *
   * A 1-word line has exactly one slot (index 0) at `(400, 510)` in the 800x600
   * play area. The letter's centroid is placed at `slot[0].position + offset`,
   * where `offset = magnitude * (cos θ, sin θ)` so the centroid-to-slot distance
   * equals `magnitude` exactly. Because there is only ONE slot:
   *   - magnitude <= tolerance ⇒ within tolerance ⇒ placedSlot === 0.
   *   - magnitude  > tolerance ⇒ outside the only slot ⇒ placedSlot === null.
   *
   * Bounds analysis (so the bounds-clamp pass never moves the letter): the slot
   * is at y = 510 and the outside band caps magnitude at 80, so the centroid y
   * stays in [430, 590] ⊂ [0, 600], and x stays in [320, 480] (±7 half-chain →
   * [313, 487] ⊂ [0, 800]). No particle ever leaves `bounds`, so with zero
   * gravity + zero collider the post-tick centroid equals the placed centroid.
   */
  it('single-slot: placed in slot 0 iff within tolerance, else null', () => {
    // outsideMax = 80 keeps the centroid in bounds (510 + 80 = 590 <= 600).
    const SINGLE_OUTSIDE_MAX = 80;

    fc.assert(
      fc.property(seedArb, angleArb, sideArb, unitArb, (seed, angle, side, unit) => {
        const core = new GameCore(seed, makeConfig());
        const line = makeLine('L', lineText(1));
        core.spawnLine(line);
        expect(core.letters.length).toBe(1);

        const slot0 = slotFor(core, 'L', 0);
        const magnitude = magnitudeFor(side, unit, SINGLE_OUTSIDE_MAX);
        const pos = {
          x: slot0.position.x + magnitude * Math.cos(angle),
          y: slot0.position.y + magnitude * Math.sin(angle),
        };

        const letter = letterFor(core, 0);
        placeLetterAt(letter, pos);
        core.tick(STEP);

        if (side === 'inside') {
          // magnitude <= tolerance - MARGIN < tolerance ⇒ within the only slot.
          expect(letter.placedSlot).toBe(0);
        } else {
          // magnitude >= tolerance + MARGIN > tolerance ⇒ outside the only slot.
          expect(letter.placedSlot).toBeNull();
        }
      }),
    );
  });

  /**
   * STRAND 2 — multi-slot with the target slot isolated.
   *
   * An n-word line (n in 2..5) lays n slots on the answer row at
   * `x = (i + 0.5)/n * 800`, `y = 510`, each with tolerance 24. Inter-slot x
   * spacing is `800/n`, which is >= 160 for n <= 5 (smallest at n = 5). The
   * target letter (correctIndex === t) is placed at `slot[t].position + offset`
   * (distance == magnitude); the other letters stay where they spawned (top
   * band, far from the answer row) and, with colliderRadius 0, never touch the
   * target.
   *
   * The outside band caps magnitude at `min(60, halfSpacing - MARGIN)`. For
   * n <= 5, halfSpacing = (800/n)/2 >= 80 > 60, so the cap is always 60. This is
   * what makes the "null when outside" assertion valid:
   *   - The target slot t is at distance `magnitude`; outside cases have
   *     magnitude > tolerance ⇒ letter is outside slot t's tolerance.
   *   - Every OTHER slot is >= one full spacing away. The nearest other slot's
   *     distance from the letter is >= spacing - magnitude >= 160 - 60 = 100,
   *     which is FAR greater than tolerance 24 — even when the offset points
   *     straight at an adjacent slot. So the letter is outside EVERY slot's
   *     tolerance ⇒ placedSlot === null.
   *   - Inside cases have magnitude <= tolerance - MARGIN < tolerance and the
   *     letter is >= 100 from every other slot, so slot t is the unique nearest
   *     in-tolerance slot ⇒ placedSlot === t.
   *
   * Bounds analysis: y stays in [510 - 60, 510 + 60] = [450, 570] ⊂ [0, 600].
   * The extreme slots sit at x = 80 (slot 0, n = 5) and x = 720 (slot 4, n = 5);
   * with magnitude <= 60 and a ±7 half-chain, x stays within [13, 787] ⊂
   * [0, 800]. So no particle leaves `bounds` and the letter does not drift.
   */
  it('multi-slot: placed in the isolated target slot t iff within tolerance, else null', () => {
    const caseArb = fc.integer({ min: 2, max: 5 }).chain((n) =>
      fc.record({
        n: fc.constant(n),
        t: fc.integer({ min: 0, max: n - 1 }),
        seed: seedArb,
        angle: angleArb,
        side: sideArb,
        unit: unitArb,
      }),
    );

    fc.assert(
      fc.property(caseArb, ({ n, t, seed, angle, side, unit }) => {
        const core = new GameCore(seed, makeConfig());
        const line = makeLine('L', lineText(n));
        core.spawnLine(line);
        expect(core.letters.length).toBe(n);

        // halfSpacing = (800/n)/2; for n in 2..5 this is >= 80, so the cap is 60.
        const halfSpacing = 800 / n / 2;
        const outsideMax = Math.min(60, halfSpacing - MARGIN);

        const slotT = slotFor(core, 'L', t);
        const magnitude = magnitudeFor(side, unit, outsideMax);
        const pos = {
          x: slotT.position.x + magnitude * Math.cos(angle),
          y: slotT.position.y + magnitude * Math.sin(angle),
        };

        const letter = letterFor(core, t);
        placeLetterAt(letter, pos);
        core.tick(STEP);

        if (side === 'inside') {
          // Within slot t's tolerance and >= 100 from every other slot ⇒ t.
          expect(letter.placedSlot).toBe(t);
        } else {
          // Outside slot t and still >= 100 from every other slot ⇒ null.
          expect(letter.placedSlot).toBeNull();
        }
      }),
    );
  });
});
