/**
 * Barrel for the Scorecard module (task 12.1).
 *
 * Re-exports the PURE content derivation (single source of truth for both the
 * on-screen render and the exported image), the canvas painter + its minimal
 * context seam, the export/copy/download helpers + retry, and the React view so
 * consumers (the UI shell in task 14.1, the property test in 12.2, and the
 * export-controls unit test in 12.3) can import from a single entry point.
 */

export {
  buildScorecardContent,
  UNOWNED_CONTRIBUTOR_KEY,
  UNOWNED_CONTRIBUTOR_LABEL,
  type ScorecardContent,
  type ScorecardRow,
} from './scorecardContent.ts';

export {
  drawScorecard,
  DEFAULT_SCORECARD_SIZE,
  type CanvasContextLike,
  type ScorecardDrawOptions,
} from './renderScorecardToCanvas.ts';

export {
  exportScorecardImage,
  exportWithRetry,
  copyImageToClipboard,
  downloadImage,
  type ClipboardLike,
  type CopyImageOptions,
  type DownloadEnv,
} from './exportScorecard.ts';

export { Scorecard, default as ScorecardView, type ScorecardProps } from './Scorecard.tsx';
