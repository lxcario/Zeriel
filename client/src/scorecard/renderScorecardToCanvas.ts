/**
 * Scorecard canvas painter (task 12.1).
 *
 * Design references:
 * - Requirement 11.2: generate a downloadable RASTER image of the Scorecard.
 * - Requirement 11.3: the exported image reflects the SAME visible content +
 *   art direction as the on-screen Scorecard.
 * - design.md "Scorecard export uses Canvas `toBlob`".
 *
 * ## Parity seam (Requirement 11.3)
 *
 * {@link drawScorecard} is the ONE routine that paints {@link ScorecardContent}
 * onto a 2D context. It is used by BOTH:
 *   - the off-screen export canvas (`exportScorecardImage`), and
 *   - the on-screen `<canvas>` hosted by `Scorecard.tsx`.
 * Painting both surfaces from the same content + same routine guarantees the
 * exported image matches what is shown on screen.
 *
 * ## Testability seam ({@link CanvasContextLike})
 *
 * Rather than depend on the full `CanvasRenderingContext2D` (which jsdom does
 * not implement), this module declares the MINIMAL subset of context methods
 * and properties it actually uses. Tests can pass a lightweight fake that
 * records calls, and the real `HTMLCanvasElement.getContext('2d')` satisfies
 * the same shape structurally.
 */

import type { ScorecardContent } from './scorecardContent.ts';

/**
 * The minimal subset of `CanvasRenderingContext2D` used by {@link drawScorecard}.
 * A real 2D context satisfies this structurally; tests supply a recording fake.
 */
export interface CanvasContextLike {
  /**
   * Current fill color used by {@link fillRect} and {@link fillText}. Typed as
   * the full `CanvasRenderingContext2D.fillStyle` union so a real 2D context is
   * structurally assignable; the painter only ever assigns string colors.
   */
  fillStyle: string | CanvasGradient | CanvasPattern;
  /** Current stroke color used by {@link strokeRect} (same union as above). */
  strokeStyle: string | CanvasGradient | CanvasPattern;
  /** Line width used by {@link strokeRect}. */
  lineWidth: number;
  /** Font shorthand used by {@link fillText}. */
  font: string;
  /** Horizontal text alignment. */
  textAlign: 'left' | 'right' | 'center' | 'start' | 'end';
  /** Vertical text baseline. */
  textBaseline: 'top' | 'middle' | 'bottom' | 'alphabetic' | 'hanging' | 'ideographic';
  /** Fill a rectangle with the current {@link fillStyle}. */
  fillRect(x: number, y: number, w: number, h: number): void;
  /** Stroke a rectangle outline with the current {@link strokeStyle}/{@link lineWidth}. */
  strokeRect(x: number, y: number, w: number, h: number): void;
  /** Paint text with the current {@link fillStyle}/{@link font}. */
  fillText(text: string, x: number, y: number): void;
}

/** Layout + art-direction options for {@link drawScorecard}. */
export interface ScorecardDrawOptions {
  /** Canvas width in pixels. */
  width: number;
  /** Canvas height in pixels. */
  height: number;
}

/** Default export canvas dimensions (a shareable card aspect). */
export const DEFAULT_SCORECARD_SIZE: ScorecardDrawOptions = { width: 1200, height: 630 };

/** Palette + metrics for the Scorecard art direction (kept in one place). */
const PALETTE = {
  background: '#0a0a0f',
  border: '#6366f1',
  title: '#fafafa',
  subtitle: '#a3a3a3',
  totalScore: '#818cf8',
  rowPlayer: '#e5e5e5',
  rowContribution: '#a5b4fc',
} as const;

/**
 * Paint {@link ScorecardContent} onto a 2D context. Pure with respect to the
 * content (no randomness): the same content + options always produce the same
 * sequence of draw calls, which is what makes on-screen/export parity hold
 * (Requirement 11.3) and makes the routine testable with a fake context.
 */
export function drawScorecard(
  ctx: CanvasContextLike,
  content: ScorecardContent,
  opts: ScorecardDrawOptions = DEFAULT_SCORECARD_SIZE,
): void {
  const { width, height } = opts;
  const pad = Math.round(width * 0.06);

  // --- Background + neo-brutalist border (consistent art direction). ---
  ctx.fillStyle = PALETTE.background;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = PALETTE.border;
  ctx.lineWidth = Math.max(4, Math.round(width * 0.01));
  ctx.strokeRect(
    ctx.lineWidth,
    ctx.lineWidth,
    width - ctx.lineWidth * 2,
    height - ctx.lineWidth * 2,
  );

  // --- Track title (Requirement 11.1). ---
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = PALETTE.subtitle;
  ctx.font = '500 28px system-ui, sans-serif';
  ctx.fillText('GLITCH — ROUND SCORECARD', pad, pad);

  ctx.fillStyle = PALETTE.title;
  ctx.font = '700 64px system-ui, sans-serif';
  ctx.fillText(content.title, pad, pad + 44);

  // --- Group TOTAL score (Requirement 11.1). ---
  ctx.fillStyle = PALETTE.subtitle;
  ctx.font = '500 28px system-ui, sans-serif';
  ctx.fillText('TOTAL SCORE', pad, pad + 132);

  ctx.fillStyle = PALETTE.totalScore;
  ctx.font = '800 96px system-ui, sans-serif';
  ctx.fillText(String(content.totalScore), pad, pad + 168);

  // --- Per-Player contribution rows (Requirement 11.1). ---
  const rowsTop = pad + 300;
  const rowHeight = Math.max(36, Math.round((height - rowsTop - pad) / Math.max(content.rows.length, 1)));
  ctx.font = '600 32px system-ui, sans-serif';
  ctx.textBaseline = 'middle';

  content.rows.forEach((row, index) => {
    const y = rowsTop + rowHeight * index + rowHeight / 2;
    ctx.textAlign = 'left';
    ctx.fillStyle = PALETTE.rowPlayer;
    ctx.fillText(row.player, pad, y);

    ctx.textAlign = 'right';
    ctx.fillStyle = PALETTE.rowContribution;
    ctx.fillText(String(row.contribution), width - pad, y);
  });
}
