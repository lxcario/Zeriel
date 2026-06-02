import { describe, it, expect } from 'vitest';
import type { RoundResult } from '@glitch/core';
import {
  buildScorecardContent,
  UNOWNED_CONTRIBUTOR_KEY,
  UNOWNED_CONTRIBUTOR_LABEL,
} from './scorecardContent.ts';

/**
 * Task 12.1 — smoke/unit coverage for {@link buildScorecardContent}, the PURE
 * single source of truth for the Scorecard's display content (Requirement 11.1,
 * 11.3). The dedicated Property 33 (optional task 12.2) is NOT written here.
 *
 * Covers: title carries the trackTitle; the group total is preserved; one row
 * per real contributor; sentinel relabeling; deterministic sort; and the
 * empty/zero edge cases (the function must be total).
 */

function result(partial: Partial<RoundResult>): RoundResult {
  return {
    trackTitle: 'Untitled',
    totalScore: 0,
    contributions: {},
    ...partial,
  };
}

describe('buildScorecardContent — content reflects the round result (Req 11.1)', () => {
  it('uses the track title as the heading and preserves the total score', () => {
    const content = buildScorecardContent(
      result({ trackTitle: 'Never Gonna Give You Up', totalScore: 7 }),
    );
    expect(content.title).toBe('Never Gonna Give You Up');
    expect(content.totalScore).toBe(7);
  });

  it('produces one row per real player contribution', () => {
    const content = buildScorecardContent(
      result({ totalScore: 5, contributions: { p1: 3, p2: 2 } }),
    );
    expect(content.rows).toHaveLength(2);
    expect(content.rows.map((r) => r.player).sort()).toEqual(['p1', 'p2']);
    const total = content.rows.reduce((sum, r) => sum + r.contribution, 0);
    expect(total).toBe(content.totalScore);
  });

  it('sorts rows by contribution descending, then by player label ascending', () => {
    const content = buildScorecardContent(
      result({ contributions: { zoe: 2, amy: 2, bob: 5 } }),
    );
    expect(content.rows).toEqual([
      { player: 'bob', contribution: 5 },
      { player: 'amy', contribution: 2 },
      { player: 'zoe', contribution: 2 },
    ]);
  });

  it('relabels the __unowned__ sentinel rather than dropping it', () => {
    const content = buildScorecardContent(
      result({ totalScore: 4, contributions: { p1: 3, [UNOWNED_CONTRIBUTOR_KEY]: 1 } }),
    );
    const labels = content.rows.map((r) => r.player);
    expect(labels).toContain(UNOWNED_CONTRIBUTOR_LABEL);
    expect(labels).not.toContain(UNOWNED_CONTRIBUTOR_KEY);
    // Rows still reconcile with the displayed total.
    const total = content.rows.reduce((sum, r) => sum + r.contribution, 0);
    expect(total).toBe(content.totalScore);
  });

  it('handles a single-player result with exactly one row (Req 11.6)', () => {
    const content = buildScorecardContent(
      result({ trackTitle: 'Solo', totalScore: 3, contributions: { solo: 3 } }),
    );
    expect(content.rows).toEqual([{ player: 'solo', contribution: 3 }]);
  });

  it('is total for an empty/zero result', () => {
    const content = buildScorecardContent(result({ trackTitle: '', totalScore: 0, contributions: {} }));
    expect(content).toEqual({ title: '', totalScore: 0, rows: [] });
  });
});
