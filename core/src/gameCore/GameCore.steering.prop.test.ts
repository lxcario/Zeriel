import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { GameConfig, LyricLine, GrabOutcome, ReleaseOutcome } from '../types/index.js';
import { GameCore } from './index.js';

/**
 * Property-based test for held-letter cursor tracking (task 4.6).
 *
 * Property 22: A held letter moves toward its owner's cursor.
 * **Validates: Requirements 8.3**
 *
 * Design ("Correctness Properties" / Property 22): *For any* Rope_Letter held by
 * a Player and any cursor position, the distance between the grabbed node and the
 * owner's cursor does not increase across a tick. Requirement 8.3: "WHILE a Player
 * holds an Ownership_Lock on a Rope_Letter, THE Physics_Engine SHALL move that
 * Rope_Letter toward the owning Player's Cursor position." This corresponds to
 * tick step 2 of the deterministic sequence ("For each owned letter, set its
 * grabbed node toward the owner's cursor").
 *
 * ---------------------------------------------------------------------------
 * SNAP vs MOVES-TOWARD framing (important)
 * ---------------------------------------------------------------------------
 * Property 22 only requires the grabbed-node→cursor distance to be NON-INCREASING
 * across a tick (`distAfter <= distBefore`). The task-4.4 implementation
 * (`GameCore.steerHeldLetters`) realizes the STRONGEST possible form of "moves
 * toward": because the grabbed node is pinned (`invMass === 0`), integration and
 * the constraint solver leave it fixed, so steering SNAPS the node's position
 * (both `x` AND `prev`) directly onto the owner's cursor each tick. A snap to the
 * target is the limit case of "moves toward" — the after-distance is exactly 0,
 * which trivially satisfies `distAfter <= distBefore` for any starting distance.
 *
 * These tests therefore assert BOTH framings, and do not weaken the invariant:
 *   - the Property 22 invariant proper: `distAfter <= distBefore` (non-increasing);
 *   - the stronger exact form the impl guarantees: the grabbed node EQUALS the
 *     owner's cursor after the tick (distance == 0).
 * The grabbed node stays PINNED while held (`pinned === true`, `invMass === 0`),
 * and steering only acts when a cursor is known and only while the letter is held.
 *
 * ---------------------------------------------------------------------------
 * Generators — broad input space (task 4.6)
 * ---------------------------------------------------------------------------
 *   - `seedArb`: arbitrary `fc.integer()` construction seed (mulberry32 coerces
 *     via `>>> 0`), proving the assertions hold regardless of spawn jitter.
 *   - `wordsArb`: 1..5 non-whitespace WORDS so the spawned line has >= 1 letter;
 *     joined by single spaces, the line's `\S+` tokens equal the words exactly,
 *     so letter ids are `L:0..L:(n-1)` and there is always a letter to grab.
 *   - `playerIdArb`: an arbitrary non-empty owner id (any string is a valid id).
 *   - `coordArb` / `cursorArb`: bounded finite doubles in [-1000, 1000]
 *     (`noNaN`, `noDefaultInfinity`) for cursor coordinates — covers negatives,
 *     zero, and values outside the spawn band / play bounds.
 *   - `dtArb`: a positive finite step (~`config.stepMs`); steering snaps a pinned
 *     node regardless of `dt`, so this exercises dt-independence of the snap.
 *   - `indexNatArb`: a `fc.nat()` reduced modulo the token count to pick which
 *     spawned letter to grab.
 *   - `cursorSeqArb`: 1..5 cursor positions for the moving-cursor multi-tick case.
 *
 * Distance is computed with `Math.hypot` over the grabbed node's position vs the
 * cursor. numRuns is left at the global default (100, from `vitest.setup.ts`).
 */

// --- Fixed representative config (mirrors GameCore.locks.test.ts) ------------

/** A representative config; identical to the one used by the locks tests. */
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

/** Euclidean distance from a grabbed-node position to a cursor (Property 22 metric). */
function distance(node: { x: number; y: number }, cursor: { x: number; y: number }): number {
  return Math.hypot(node.x - cursor.x, node.y - cursor.y);
}

// --- Generators -------------------------------------------------------------

/** Non-whitespace characters: letters, digits, punctuation, Unicode, emoji. */
const wordCharArb = fc.constantFrom(
  'a', 'B', 'z', 'Q', '0', '7', '-', '_', '.', '!', '日', 'é', 'Ω', '🎤',
);

/** One WORD: a non-empty string of strictly non-whitespace characters. */
const wordArb: fc.Arbitrary<string> = fc.string({
  unit: wordCharArb,
  minLength: 1,
  maxLength: 6,
});

/** 1..5 words; joined by single spaces the `\S+` tokens equal these words. */
const wordsArb: fc.Arbitrary<string[]> = fc.array(wordArb, { minLength: 1, maxLength: 5 });

/** An arbitrary non-empty owner Player_Id. */
const playerIdArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 6 });

/** A bounded finite cursor coordinate (covers negatives, zero, out-of-bounds). */
const coordArb = fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true });

/** A bounded finite cursor position. */
const cursorArb = fc.record({ x: coordArb, y: coordArb });

/** A positive finite physics step (~config.stepMs); snap is dt-independent. */
const dtArb = fc.double({ min: 1, max: 200, noNaN: true, noDefaultInfinity: true });

/** Raw nat used to select a letter index modulo the token count. */
const indexNatArb = fc.nat({ max: 1000 });

/** A non-empty sequence of cursor positions for the moving-cursor case. */
const cursorSeqArb = fc.array(cursorArb, { minLength: 1, maxLength: 5 });

const seedArb = fc.integer();

// --- Property 22 ------------------------------------------------------------

describe("Property 22: A held letter moves toward its owner's cursor (Req 8.3)", () => {
  it('snaps the grabbed node to the cursor (after-distance 0 <= before-distance) and keeps it pinned', () => {
    fc.assert(
      fc.property(
        seedArb,
        wordsArb,
        playerIdArb,
        cursorArb,
        indexNatArb,
        dtArb,
        (seed, words, playerId, cursor, indexNat, dt) => {
          const core = new GameCore(seed, makeConfig());
          core.spawnLine(makeLine('L', words.join(' ')));

          const n = core.letters.length;
          expect(n).toBe(words.length); // line always has >= 1 letter
          const idx = indexNat % n;
          const letterId = `L:${idx}`;

          // Grab the letter for the player: lock granted, grabbed node PINNED.
          const grab = core.applyInput({
            type: 'grab',
            playerId,
            letterId,
            clientTick: 0,
          }) as GrabOutcome;
          expect(grab.granted).toBe(true);

          const node = core.letters[idx]!.particles[0]!; // GRABBED_NODE_INDEX
          expect(node.pinned).toBe(true);
          expect(node.invMass).toBe(0);

          // Send the owner's target cursor, then measure distance BEFORE the tick.
          core.applyInput({ type: 'cursor', playerId, x: cursor.x, y: cursor.y });
          const distBefore = distance(node.x, cursor);

          core.tick(dt);

          // Property 22 invariant: distance to the cursor is NON-INCREASING.
          const distAfter = distance(node.x, cursor);
          expect(distAfter).toBeLessThanOrEqual(distBefore);

          // Strongest form of "moves toward": the node SNAPS exactly onto the
          // cursor (so distAfter === 0), with prev == x (zero implicit velocity).
          expect(distAfter).toBe(0);
          expect(node.x).toEqual({ x: cursor.x, y: cursor.y });
          expect(node.prev).toEqual({ x: cursor.x, y: cursor.y });

          // PINNED WHILE HELD: still pinned with infinite mass after the tick.
          expect(node.pinned).toBe(true);
          expect(node.invMass).toBe(0);
        },
      ),
    );
  });

  it('tracks a MOVING cursor across a sequence of ticks (node equals the latest cursor each tick)', () => {
    fc.assert(
      fc.property(
        seedArb,
        wordsArb,
        playerIdArb,
        cursorSeqArb,
        indexNatArb,
        dtArb,
        (seed, words, playerId, cursors, indexNat, dt) => {
          const core = new GameCore(seed, makeConfig());
          core.spawnLine(makeLine('L', words.join(' ')));

          const n = core.letters.length;
          const idx = indexNat % n;
          const letterId = `L:${idx}`;

          const grab = core.applyInput({
            type: 'grab',
            playerId,
            letterId,
            clientTick: 0,
          }) as GrabOutcome;
          expect(grab.granted).toBe(true);

          const node = core.letters[idx]!.particles[0]!;

          // After each (cursor then tick), the node equals the LATEST cursor and
          // its distance to that cursor is 0 — it tracks the cursor across moves.
          for (const cursor of cursors) {
            core.applyInput({ type: 'cursor', playerId, x: cursor.x, y: cursor.y });
            core.tick(dt);
            expect(distance(node.x, cursor)).toBe(0);
            expect(node.x).toEqual({ x: cursor.x, y: cursor.y });
            expect(node.pinned).toBe(true);
            expect(node.invMass).toBe(0);
          }
        },
      ),
    );
  });

  it('leaves the grabbed node UNCHANGED when the owner has no recorded cursor (steering needs a known cursor)', () => {
    fc.assert(
      fc.property(
        seedArb,
        wordsArb,
        playerIdArb,
        indexNatArb,
        dtArb,
        (seed, words, playerId, indexNat, dt) => {
          const core = new GameCore(seed, makeConfig());
          core.spawnLine(makeLine('L', words.join(' ')));

          const n = core.letters.length;
          const idx = indexNat % n;
          const letterId = `L:${idx}`;

          core.applyInput({ type: 'grab', playerId, letterId, clientTick: 0 });
          const node = core.letters[idx]!.particles[0]!;
          // Capture the spawn position BEFORE the tick (no cursor ever sent).
          const before = { x: node.x.x, y: node.x.y };

          core.tick(dt);

          // No cursor known for the owner => steering is a no-op, node unchanged.
          expect(node.x).toEqual(before);
          expect(node.pinned).toBe(true);
        },
      ),
    );
  });

  it('does NOT snap the node to the cursor AFTER release (steering applies only to held letters)', () => {
    fc.assert(
      fc.property(
        seedArb,
        wordsArb,
        playerIdArb,
        cursorArb,
        indexNatArb,
        dtArb,
        (seed, words, playerId, cursor, indexNat, dt) => {
          const core = new GameCore(seed, makeConfig());
          core.spawnLine(makeLine('L', words.join(' ')));

          const n = core.letters.length;
          const idx = indexNat % n;
          const letterId = `L:${idx}`;

          // Grab, steer to a first cursor, then release.
          core.applyInput({ type: 'grab', playerId, letterId, clientTick: 0 });
          core.applyInput({ type: 'cursor', playerId, x: cursor.x, y: cursor.y });
          core.tick(dt);

          const node = core.letters[idx]!.particles[0]!;
          expect(node.x).toEqual({ x: cursor.x, y: cursor.y }); // snapped while held

          const release = core.applyInput({
            type: 'release',
            playerId,
            letterId,
          }) as ReleaseOutcome;
          expect(release.released).toBe(true);
          // Node is freed: unpinned with finite (unit) mass.
          expect(node.pinned).toBe(false);
          expect(node.invMass).toBe(1);

          // Move the cursor to a guaranteed-different position and tick again.
          const moved = { x: cursor.x + 137, y: cursor.y - 113 };
          core.applyInput({ type: 'cursor', playerId, x: moved.x, y: moved.y });
          core.tick(dt);

          // The now-unpinned node must NOT have snapped to the freshly moved cursor.
          expect(node.x).not.toEqual({ x: moved.x, y: moved.y });
          expect(node.invMass).toBe(1);
        },
      ),
    );
  });
});
