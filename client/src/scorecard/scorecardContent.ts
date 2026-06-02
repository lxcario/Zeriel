/**
 * Scorecard display content — the PURE single source of truth (task 12.1).
 *
 * Design references:
 * - Requirement 11.1: WHEN a Round enters scoring, render a Scorecard that
 *   includes the track title, the group TOTAL score, and per-Player
 *   contributions.
 * - Requirement 11.3: the exported image reflects the SAME visible content as
 *   the on-screen Scorecard.
 * - design.md "Data Models — RoundResult": `{ trackTitle, totalScore,
 *   contributions: Record<PlayerId, number> }`.
 *
 * ## Why this module exists (parity, Requirement 11.3)
 *
 * Both the on-screen Scorecard AND the exported raster image derive their
 * visible content from the SAME {@link ScorecardContent} value produced here,
 * and both are painted by the SAME `drawScorecard` routine
 * (`renderScorecardToCanvas.ts`). Because there is one derivation and one
 * draw path, the export cannot drift from what is shown on screen — parity is
 * guaranteed by construction rather than by keeping two renderers in sync.
 *
 * This function is PURE and TOTAL: no DOM, no randomness, no throwing. It is
 * the target of Property 33 ("scorecard content reflects the round result",
 * optional task 12.2). It handles empty contributions and a zero total score.
 *
 * ## The `__unowned__` sentinel (decision: RELABEL, not omit)
 *
 * `GameCore` credits each correctly-ordered letter to exactly one contribution
 * key so the per-Player counts sum to `totalScore` (design.md Property 29). A
 * correctly-placed letter that was never grabbed is credited to a deterministic
 * sentinel key, `__unowned__`, which is explicitly NOT a real Player.
 *
 * This module RELABELS that sentinel to a human label ("Unclaimed") and keeps
 * it as a row, rather than omitting it. Rationale: keeping the sentinel row
 * preserves the invariant that the visible rows sum to the displayed
 * `totalScore`, so the Scorecard is internally consistent (the rows add up to
 * the total). Omitting it would show rows that silently fail to reconcile with
 * the headline total. The label is exported so the view/tests can reference it.
 */

import type { RoundResult } from '@glitch/core';

/** The deterministic non-Player sentinel key used by `GameCore` contributions. */
export const UNOWNED_CONTRIBUTOR_KEY = '__unowned__';

/** Human-facing label substituted for the {@link UNOWNED_CONTRIBUTOR_KEY}. */
export const UNOWNED_CONTRIBUTOR_LABEL = 'Unclaimed';

/** One per-Player (or relabeled-sentinel) contribution row of the Scorecard. */
export interface ScorecardRow {
  /** Player id, or {@link UNOWNED_CONTRIBUTOR_LABEL} for the sentinel key. */
  player: string;
  /** Correctly-placed-letter count credited to this row (Requirement 9.6). */
  contribution: number;
}

/**
 * The fully-derived, render-ready content of a Scorecard. This is the single
 * value consumed by BOTH the on-screen render and the exported image
 * (Requirement 11.3).
 */
export interface ScorecardContent {
  /** Track title shown as the Scorecard heading (Requirement 11.1). */
  title: string;
  /** Group TOTAL score (Requirement 11.1). */
  totalScore: number;
  /**
   * Per-Player contribution rows, sorted deterministically by contribution
   * descending then by player label ascending (Requirement 11.1). May be empty
   * when no letters were credited.
   */
  rows: ScorecardRow[];
}

/** Coerce a possibly non-finite number to a safe finite value (default 0). */
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Derive the render-ready {@link ScorecardContent} from a {@link RoundResult}.
 *
 * Pure and total: tolerates an empty/zero result, non-finite numbers, and the
 * `__unowned__` sentinel (relabeled to {@link UNOWNED_CONTRIBUTOR_LABEL}). Rows
 * are sorted by contribution descending, then by player label ascending, so the
 * output is fully deterministic for a given result (Requirement 11.1, 11.3).
 */
export function buildScorecardContent(result: RoundResult): ScorecardContent {
  const title = typeof result.trackTitle === 'string' ? result.trackTitle : '';
  const totalScore = finiteOr(result.totalScore, 0);

  const contributions = result.contributions ?? {};
  const rows: ScorecardRow[] = Object.entries(contributions).map(([key, value]) => ({
    player: key === UNOWNED_CONTRIBUTOR_KEY ? UNOWNED_CONTRIBUTOR_LABEL : key,
    contribution: finiteOr(value, 0),
  }));

  // Deterministic ordering: highest contribution first, ties broken by label.
  rows.sort((a, b) => {
    if (b.contribution !== a.contribution) return b.contribution - a.contribution;
    if (a.player < b.player) return -1;
    if (a.player > b.player) return 1;
    return 0;
  });

  return { title, totalScore, rows };
}
