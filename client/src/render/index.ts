/**
 * Barrel for the client `render` module (task 9.1).
 *
 * Re-exports the Renderer contract + concrete {@link CanvasRenderer}, the
 * RenderState/LetterView/RenderContainer shapes `draw()` consumes, the
 * {@link CanvasContextLike} testability seam, and the pure deterministic helpers
 * ({@link letterVariation}, {@link offGridOffset}) so the host (task 14.1) and
 * the optional property tests (9.2, 9.3) can import from a single entry point.
 */

export {
  CanvasRenderer,
  letterVariation,
  offGridOffset,
  hashUnit,
  hashString,
  MAX_LETTER_ROTATION_RAD,
  MAX_LETTER_VARIATION_PX,
  type Renderer,
  type RenderState,
  type LetterView,
  type RenderContainer,
  type CanvasContextLike,
  type CanvasImageSourceLike,
  type TextMetricsLike,
  type RenderBuffer,
  type CanvasRendererConfig,
} from './Renderer.ts';
