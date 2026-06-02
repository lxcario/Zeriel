import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { RoundResult } from '@glitch/core';
import {
  buildScorecardContent,
  UNOWNED_CONTRIBUTOR_KEY,
  UNOWNED_CONTRIBUTOR_LABEL,
} from './scorecardContent.ts';

/**
 * Property-based test for the Scorecard's display content (optional task 12.2).
 *
 * Property 33: Scorecard content reflects the round result.
 * **Validates: Requirements 11.1**
 *
 * Design ("Correctness Properties" / Property 33): *For any* Round result, the
 * rendered Scorecard includes the track title, the group total score, and a
 * per-Player contribution entry for every contributing Player.
 *
 * Requirement 11.1: WHEN a Round enters the scoring state, THE Client SHALL
 * render a Scorecard that includes the track title, the group total score, and
 * per-Player contributions.
 *
 * ## Strategy
 *
 * {@link buildScorecardContent} is the PURE single source of truth for the
 * Scorecard content. This file proves the universal "reflects the result" form
 * across a broad input space; the companion `scorecardContent.test.ts` pins the
 * concrete examples (sentinel relabel, sort, empty/zero).
 *
 * The MAIN strand keeps `trackTitle` a string and `totalScore` a FINITE integer
 * so the equality assertions are clean (`title === trackTitle`,
 * `totalScore === totalScore`). A separate NON-FINITE sub-strand confirms the
 * documented finite-coercion (`NaN`/`±Infinity` total -> `0`).
 *
 * Contributions are built from an array of `[key, count]` pairs and deduped via
 * `Object.fromEntries` (later keys win) so the row count is well-defined.
 * "Real" keys are filtered to exclude BOTH the sentinel key (`__unowned__`) and
 * its human label (`Unclaimed`): a real key equal to either would collide with
 * the relabeled sentinel row and produce a label clash that is an artifact of
 * the generator, not a code bug. The sentinel is instead injected explicitly
 * and SOMETIMES, so the relabel path is exercised without spurious collisions.
 *
 * numRuns is left at the global default (100, from `vitest.setup.ts`); it is not
 * weakened. If a counterexample reveals a real bug (missing/extra row, wrong
 * title/total, or a mis-sort), the failing assertion stops the run with the
 * shrunk example.
 */

// --- Generators -------------------------------------------------------------

/** Track titles: ordinary strings, full-Unicode/emoji strings, and empty. */
const titleArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.string({ unit: 'grapheme' }),
  fc.constant(''),
);

/** Finite, non-negative integer scores incl. 0 and a large edge value. */
const finiteScoreArb: fc.Arbitrary<number> = fc.oneof(
  fc.nat(),
  fc.constant(0),
  fc.constant(1_000_000),
  fc.integer({ min: 0, max: 2_147_483_647 }),
);

/** Non-finite scores: must coerce to 0 in the output (documented behavior). */
const nonFiniteScoreArb: fc.Arbitrary<number> = fc.constantFrom(
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
);

/** Non-negative integer contribution counts. */
const countArb: fc.Arbitrary<number> = fc.nat({ max: 10_000 });

/**
 * A real (non-sentinel) player id: an arbitrary non-empty string, including
 * full-Unicode/emoji, excluding the sentinel key AND its label to avoid a
 * relabel collision that the production code is not expected to disambiguate.
 */
const realKeyArb: fc.Arbitrary<string> = fc
  .oneof(fc.string({ minLength: 1 }), fc.string({ unit: 'grapheme', minLength: 1 }))
  .filter(
    (k) =>
      k.length > 0 &&
      k !== UNOWNED_CONTRIBUTOR_KEY &&
      k !== UNOWNED_CONTRIBUTOR_LABEL,
  );

/** An array of `[realKey, count]` pairs (keys deduped later via the record). */
const realEntriesArb: fc.Arbitrary<[string, number][]> = fc.array(
  fc.tuple(realKeyArb, countArb),
  { maxLength: 12 },
);

/**
 * Build a contributions record from real entries, SOMETIMES injecting the
 * `__unowned__` sentinel so its relabel path is exercised. Deduping is handled
 * by `Object.fromEntries` (the last occurrence of a key wins) — exactly as
 * `buildScorecardContent` itself reads the record, so the two stay consistent.
 */
const contributionsArb: fc.Arbitrary<Record<string, number>> = fc
  .record({
    entries: realEntriesArb,
    includeSentinel: fc.boolean(),
    sentinelCount: countArb,
  })
  .map(({ entries, includeSentinel, sentinelCount }) => {
    const all: [string, number][] = includeSentinel
      ? [...entries, [UNOWNED_CONTRIBUTOR_KEY, sentinelCount]]
      : entries;
    return Object.fromEntries(all);
  });

/** A full, finite RoundResult for the main strand. */
const finiteResultArb: fc.Arbitrary<RoundResult> = fc.record({
  trackTitle: titleArb,
  totalScore: finiteScoreArb,
  contributions: contributionsArb,
});

// --- Property 33 ------------------------------------------------------------

describe('Property 33: Scorecard content reflects the round result (Req 11.1)', () => {
  it('reflects title, total, and one row per contributor (finite main strand)', () => {
    fc.assert(
      fc.property(finiteResultArb, (result) => {
        const content = buildScorecardContent(result);

        // TITLE: the heading carries the track title verbatim.
        expect(content.title).toBe(result.trackTitle);

        // TOTAL: the group total is preserved (finite => no coercion).
        expect(content.totalScore).toBe(result.totalScore);

        const keys = Object.keys(result.contributions);

        // ONE ROW PER CONTRIBUTOR: no extra rows, none missing.
        expect(content.rows).toHaveLength(keys.length);

        // Each contribution key maps to exactly one row carrying its count,
        // with the sentinel key relabeled to its human label.
        for (const key of keys) {
          const expectedLabel =
            key === UNOWNED_CONTRIBUTOR_KEY ? UNOWNED_CONTRIBUTOR_LABEL : key;
          const matching = content.rows.filter((r) => r.player === expectedLabel);
          expect(matching).toHaveLength(1);
          expect(matching[0]!.contribution).toBe(result.contributions[key]);
        }

        // SORT ORDER: contribution descending, ties broken by player ascending.
        for (let i = 1; i < content.rows.length; i++) {
          const prev = content.rows[i - 1]!;
          const cur = content.rows[i]!;
          expect(prev.contribution).toBeGreaterThanOrEqual(cur.contribution);
          if (prev.contribution === cur.contribution) {
            expect(prev.player <= cur.player).toBe(true);
          }
        }

        // SENTINEL: when present, exactly one relabeled row and no raw key row.
        if (UNOWNED_CONTRIBUTOR_KEY in result.contributions) {
          expect(
            content.rows.filter((r) => r.player === UNOWNED_CONTRIBUTOR_LABEL),
          ).toHaveLength(1);
          expect(
            content.rows.some((r) => r.player === UNOWNED_CONTRIBUTOR_KEY),
          ).toBe(false);
        }
      }),
    );
  });

  it('coerces a non-finite total score to 0 while still reflecting the title (sub-strand)', () => {
    fc.assert(
      fc.property(
        fc.record({
          trackTitle: titleArb,
          totalScore: nonFiniteScoreArb,
          contributions: contributionsArb,
        }),
        (result) => {
          const content = buildScorecardContent(result);
          // Documented finite-coercion: non-finite total => 0.
          expect(content.totalScore).toBe(0);
          // Title still reflects the result.
          expect(content.title).toBe(result.trackTitle);
          // Rows still reflect one entry per contributor.
          expect(content.rows).toHaveLength(Object.keys(result.contributions).length);
        },
      ),
    );
  });

  it('is total: never throws and yields rows:[] for empty contributions', () => {
    fc.assert(
      fc.property(
        fc.record({ trackTitle: titleArb, totalScore: finiteScoreArb }),
        ({ trackTitle, totalScore }) => {
          const result: RoundResult = { trackTitle, totalScore, contributions: {} };
          const content = buildScorecardContent(result);
          expect(content.rows).toEqual([]);
          expect(content.title).toBe(trackTitle);
          expect(content.totalScore).toBe(totalScore);
        },
      ),
    );
  });
});
