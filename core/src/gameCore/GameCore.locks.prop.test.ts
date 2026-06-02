import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { GameConfig, LyricLine, PlayerInput, InputOutcome, PlayerId } from '../types/index.js';
import { GameCore } from './index.js';

/**
 * Property-based test for ownership-lock lifecycle and exclusivity (task 4.5).
 *
 * Property 21: Ownership-lock lifecycle and exclusivity.
 * **Validates: Requirements 8.1, 8.2, 8.4**
 *
 * Design ("Correctness Properties" / Property 21): *For any* Rope_Letter and any
 * pair of Players, a grab on an unlocked letter assigns the lock to the requester
 * (8.1); a grab on a letter already locked by another Player is denied and leaves
 * the owner unchanged (8.2); and releasing a held letter clears its lock (8.4).
 *
 * This test generalizes the "pair of Players, one letter" statement to **any
 * sequence of grab/release operations by multiple Players over a set of letters**
 * and asserts the full exclusivity invariant: at most one Player holds a lock on a
 * given Rope_Letter at any time. Exclusivity is structurally trivial for the
 * single `ownerId` field, so the meaningful check is that the engine's lock state
 * EQUALS a spec-derived REFERENCE MODEL after EVERY operation — if the engine ever
 * diverges, that divergence is a real lock bug.
 *
 * ---------------------------------------------------------------------------
 * Reference model (independent spec oracle)
 * ---------------------------------------------------------------------------
 * A `Map<letterId, ownerId | null>` seeded with every spawned letterId → null,
 * plus a `Set` of valid letterIds. Each op is resolved against the model with the
 * exact spec rules, producing the EXPECTED `InputOutcome` and the model mutation:
 *
 *   grab(player, letterId):
 *     - letterId not a spawned letter  -> { granted:false, ownerId:null }; no change
 *                                         (benign no-op on a missing/stale letter)
 *     - current owner is null          -> { granted:true,  ownerId:player }; owner := player   (8.1)
 *     - current owner is the requester -> { granted:true,  ownerId:player }; no change (idempotent re-grab)
 *     - current owner is another player-> { granted:false, ownerId:current }; no change         (8.2)
 *   release(player, letterId):
 *     - letterId not a spawned letter  -> { released:false }; no change
 *     - current owner is the requester -> { released:true  }; owner := null                     (8.4)
 *     - otherwise (null / other owner) -> { released:false }; no change
 *
 * The model is computed only from the operation stream and the spec rules — never
 * from `GameCore` internals — so it is a genuine cross-check, not a restatement.
 *
 * ---------------------------------------------------------------------------
 * Generators
 * ---------------------------------------------------------------------------
 * - `n` ∈ 1..5 letters; the line text is `n` distinct word tokens (`w0 w1 ...`)
 *   so `GameCore.spawnLine` yields exactly the ids `L:0 .. L:{n-1}`.
 * - A small fixed Player set `p1 | p2 | p3` to force genuine contention.
 * - Each op = `{ kind: 'grab'|'release', playerId, letterIndex }`, where
 *   `letterIndex` is mostly in-range `0..n-1` (weight 9) and occasionally
 *   out-of-range `n..n+2` (weight 1) to exercise the missing-letter branch.
 * - Sequences of length 1..30.
 *
 * numRuns is left at the global default (100, from `vitest.setup.ts`); it is not
 * weakened. A counterexample (engine diverging from the model, a wrong outcome, a
 * denied grab that mutated ownership, or a mismatched lock set) stops the run with
 * the shrunk operation sequence.
 */

// --- Fixed representative config (mirrors GameCore.locks.test.ts) ------------

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

/** Line text of `n` distinct word tokens, yielding letter ids `L:0 .. L:{n-1}`. */
function lineTextForN(n: number): string {
  return Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
}

// --- Op type + generators ---------------------------------------------------

const PLAYERS = ['p1', 'p2', 'p3'] as const;
const playerArb = fc.constantFrom<PlayerId>(...PLAYERS);

interface Op {
  kind: 'grab' | 'release';
  playerId: PlayerId;
  letterIndex: number;
}

/** Op arb for a line of `n` letters: mostly in-range, occasionally missing. */
function opArb(n: number): fc.Arbitrary<Op> {
  return fc.record({
    kind: fc.constantFrom<'grab' | 'release'>('grab', 'release'),
    playerId: playerArb,
    letterIndex: fc.oneof(
      { weight: 9, arbitrary: fc.integer({ min: 0, max: n - 1 }) },
      { weight: 1, arbitrary: fc.integer({ min: n, max: n + 2 }) },
    ),
  });
}

interface Scenario {
  n: number;
  seed: number;
  ops: Op[];
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.integer({ min: 1, max: 5 }).chain((n) =>
  fc.record({
    n: fc.constant(n),
    seed: fc.integer(),
    ops: fc.array(opArb(n), { minLength: 1, maxLength: 30 }),
  }),
);

// --- Reference model --------------------------------------------------------

/**
 * Resolve `op` against the reference `model` (and `validIds`), MUTATING the model
 * per the spec rules and returning the EXPECTED {@link InputOutcome}.
 */
function expectedAndApply(
  op: Op,
  model: Map<string, PlayerId | null>,
  validIds: Set<string>,
): InputOutcome {
  const letterId = `L:${op.letterIndex}`;

  if (op.kind === 'grab') {
    if (!validIds.has(letterId)) {
      return { type: 'grab', letterId, granted: false, ownerId: null };
    }
    const current = model.get(letterId) ?? null;
    if (current === null) {
      model.set(letterId, op.playerId); // 8.1: lock assigned to requester
      return { type: 'grab', letterId, granted: true, ownerId: op.playerId };
    }
    if (current === op.playerId) {
      return { type: 'grab', letterId, granted: true, ownerId: op.playerId }; // idempotent
    }
    return { type: 'grab', letterId, granted: false, ownerId: current }; // 8.2: denied, owner unchanged
  }

  // release
  if (!validIds.has(letterId)) {
    return { type: 'release', letterId, released: false };
  }
  const current = model.get(letterId) ?? null;
  if (current === op.playerId) {
    model.set(letterId, null); // 8.4: owner clears its own lock
    return { type: 'release', letterId, released: true };
  }
  return { type: 'release', letterId, released: false }; // non-owner release is a no-op
}

/** Build the `GameCore` input for an op (grab carries a clientTick). */
function toInput(op: Op, clientTick: number): PlayerInput {
  const letterId = `L:${op.letterIndex}`;
  return op.kind === 'grab'
    ? { type: 'grab', playerId: op.playerId, letterId, clientTick }
    : { type: 'release', playerId: op.playerId, letterId };
}

// --- Property 21 ------------------------------------------------------------

describe('Property 21: Ownership-lock lifecycle and exclusivity (Req 8.1, 8.2, 8.4)', () => {
  it('keeps the engine lock state, outcomes, and snapshot locks matching the spec model after every op', () => {
    fc.assert(
      fc.property(scenarioArb, ({ n, seed, ops }) => {
        const core = new GameCore(seed, makeConfig());
        core.spawnLine(makeLine('L', lineTextForN(n)));

        const validIds = new Set(core.letters.map((l) => l.id));
        expect(validIds.size).toBe(n); // line yields exactly L:0 .. L:{n-1}

        // Reference model: every spawned letter starts unlocked.
        const model = new Map<string, PlayerId | null>();
        for (const id of validIds) model.set(id, null);

        ops.forEach((op, i) => {
          const letterId = `L:${op.letterIndex}`;
          // Owner BEFORE the op (null for missing/unlocked) — used for the
          // denied-grab "no mutation" check (8.2).
          const beforeOwner = model.get(letterId) ?? null;

          const expected = expectedAndApply(op, model, validIds);
          const actual = core.applyInput(toInput(op, i));

          // OUTCOME CORRECTNESS: engine outcome matches the spec-derived outcome.
          expect(actual).toEqual(expected);

          // DENIED GRAB DOES NOT MUTATE (8.2): a denied grab on an existing
          // letter leaves its ownerId exactly as it was before the op.
          if (op.kind === 'grab' && expected.type === 'grab' && !expected.granted && validIds.has(letterId)) {
            const letter = core.letters.find((l) => l.id === letterId)!;
            expect(letter.ownerId).toBe(beforeOwner);
          }

          // EXCLUSIVITY (core invariant): the single ownerId field can hold at
          // most one owner; assert it equals the model owner for EVERY letter so
          // the engine's lock state matches the spec-derived state exactly.
          for (const letter of core.letters) {
            expect(letter.ownerId).toBe(model.get(letter.id) ?? null);
          }

          // snapshot().locks == the (letterId, ownerId) set of all owned letters
          // in the model — no extra and no missing locks (spawn order in both).
          const expectedLocks = core.letters
            .filter((l) => (model.get(l.id) ?? null) !== null)
            .map((l) => ({ letterId: l.id, ownerId: model.get(l.id)! }));
          expect(core.snapshot().locks).toEqual(expectedLocks);
        });

        // GLOBAL INVARIANT after the whole sequence: every letter's ownerId is
        // either null or a single playerId from the known player set, and it
        // matches the reference model (at most one holder per letter).
        for (const letter of core.letters) {
          const owner = model.get(letter.id) ?? null;
          expect(owner === null || (PLAYERS as readonly string[]).includes(owner)).toBe(true);
          expect(letter.ownerId).toBe(owner);
        }
      }),
    );
  });
});
