/**
 * Scorecard React view (task 12.1).
 *
 * Design references:
 * - Requirement 11.1: render a Scorecard including the track title, the group
 *   TOTAL score, and per-Player contributions.
 * - Requirement 11.3: the exported image reflects the SAME visible content +
 *   art direction as the on-screen Scorecard.
 * - Requirement 11.4: provide a control to COPY or DOWNLOAD the exported image.
 * - Requirement 11.5: on export failure, allow a transparent RETRY (may retry
 *   without showing an error message).
 * - Requirement 11.6: works for a single Player (one contribution row).
 * - Requirement 13.5 (spirit): semantic headings + labeled controls outside the
 *   Canvas play area.
 *
 * ## On-screen / export parity (Requirement 11.3)
 *
 * The view derives its content ONCE via {@link buildScorecardContent} and uses
 * it for BOTH:
 *   1. the semantic HTML rows shown to the Player, and
 *   2. the on-screen `<canvas>` painted by {@link drawScorecard}.
 * The export path (`Copy`/`Download`) paints a fresh off-screen canvas with the
 * SAME content + SAME `drawScorecard` routine, so the exported raster cannot
 * drift from what is on screen — parity holds by construction.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { RoundResult } from '@glitch/core';
import { buildScorecardContent } from './scorecardContent.ts';
import {
  drawScorecard,
  DEFAULT_SCORECARD_SIZE,
} from './renderScorecardToCanvas.ts';
import {
  exportScorecardImage,
  exportWithRetry,
  copyImageToClipboard,
  downloadImage,
} from './exportScorecard.ts';

/** Props for {@link Scorecard}. */
export interface ScorecardProps {
  /** The finalized Round result to display + export (Requirement 11.1). */
  result: RoundResult;
}

/** Build a filesystem-safe download filename from the track title. */
function scorecardFilename(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `glitch-scorecard${slug ? `-${slug}` : ''}.png`;
}

/**
 * Render an off-screen canvas painted with the given content and resolve a PNG
 * Blob from it, retrying transparently on failure (Requirement 11.5).
 */
async function renderAndExport(
  draw: (canvas: HTMLCanvasElement) => void,
): Promise<Blob> {
  return exportWithRetry(() => {
    const canvas = document.createElement('canvas');
    canvas.width = DEFAULT_SCORECARD_SIZE.width;
    canvas.height = DEFAULT_SCORECARD_SIZE.height;
    draw(canvas);
    return exportScorecardImage(canvas);
  });
}

/**
 * The end-of-round Scorecard surface. Shows the track title, group total, and
 * per-Player rows as semantic HTML, mirrors them onto an on-screen canvas, and
 * exposes Copy + Download controls wired to the canvas `toBlob` export.
 */
export function Scorecard({ result }: ScorecardProps) {
  // Single derivation → drives BOTH the HTML and the canvas (Requirement 11.3).
  const content = useMemo(() => buildScorecardContent(result), [result]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Paint the on-screen canvas from the SAME content + routine as the export.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawScorecard(ctx, content, DEFAULT_SCORECARD_SIZE);
  }, [content]);

  // Paint a fresh off-screen canvas with the identical content for export.
  const drawForExport = useCallback(
    (canvas: HTMLCanvasElement) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D context unavailable for export');
      drawScorecard(ctx, content, DEFAULT_SCORECARD_SIZE);
    },
    [content],
  );

  const handleCopy = useCallback(async () => {
    // Transparent retry (11.5): on failure we simply try again; no error UI.
    const blob = await renderAndExport(drawForExport);
    const copied = await copyImageToClipboard(blob);
    // Fall back to download when the clipboard API is unavailable (11.4).
    if (!copied) downloadImage(blob, scorecardFilename(content.title));
  }, [content.title, drawForExport]);

  const handleDownload = useCallback(async () => {
    const blob = await renderAndExport(drawForExport);
    downloadImage(blob, scorecardFilename(content.title));
  }, [content.title, drawForExport]);

  return (
    <section
      aria-labelledby="scorecard-heading"
      className="mx-auto w-full max-w-2xl rounded-2xl border-2 border-indigo-500 bg-neutral-950 p-6 text-neutral-100 shadow-xl"
    >
      <header className="mb-5">
        <p className="text-sm font-medium uppercase tracking-wider text-neutral-400">
          Zeriel — Round Scorecard
        </p>
        <h2
          id="scorecard-heading"
          className="mt-1 text-3xl font-bold tracking-tight text-neutral-50"
        >
          {content.title || 'Untitled track'}
        </h2>
      </header>

      {/* Group TOTAL score (Requirement 11.1). */}
      <div className="mb-6">
        <p className="text-sm font-medium uppercase tracking-wider text-neutral-400">
          Total score
        </p>
        <p className="text-6xl font-extrabold tabular-nums text-indigo-400">
          {content.totalScore}
        </p>
      </div>

      {/* Per-Player contributions (Requirement 11.1; single row in SP, 11.6). */}
      <div className="mb-6">
        <h3 className="mb-2 text-sm font-medium uppercase tracking-wider text-neutral-400">
          Contributions
        </h3>
        {content.rows.length === 0 ? (
          <p className="text-sm text-neutral-400">No contributions recorded.</p>
        ) : (
          <ul className="flex flex-col gap-1" aria-label="Per-player contributions">
            {content.rows.map((row) => (
              <li
                key={row.player}
                className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900/60 px-4 py-2"
              >
                <span className="font-medium text-neutral-100">{row.player}</span>
                <span className="tabular-nums text-indigo-300">{row.contribution}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* On-screen canvas mirror — same content + routine as the export (11.3). */}
      <canvas
        ref={canvasRef}
        width={DEFAULT_SCORECARD_SIZE.width}
        height={DEFAULT_SCORECARD_SIZE.height}
        role="img"
        aria-label={`Scorecard image for ${content.title || 'the round'}`}
        className="mb-5 w-full rounded-lg border border-neutral-800"
      />

      {/* Copy / Download controls (Requirement 11.4). */}
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center justify-center rounded-lg bg-indigo-500 px-5 py-2.5 text-base font-medium text-white transition-colors hover:bg-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-400/50"
        >
          Copy image
        </button>
        <button
          type="button"
          onClick={handleDownload}
          className="inline-flex items-center justify-center rounded-lg border border-neutral-700 bg-neutral-900 px-5 py-2.5 text-base font-medium text-neutral-100 transition-colors hover:border-neutral-500 hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-indigo-400/40"
        >
          Download image
        </button>
      </div>
    </section>
  );
}

export default Scorecard;
