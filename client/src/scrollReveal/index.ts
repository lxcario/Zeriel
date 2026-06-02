/**
 * Barrel for the client `scrollReveal` module (task 11.1).
 *
 * Re-exports the Scroll_Reveal_Animation React component plus its PURE,
 * DOM-free helpers (word tokenization and the scroll-progress→style mapping)
 * so consumers — the Landing_Page (task 14.1) and the optional property tests
 * (tasks 11.2–11.5) — can import from a single entry point.
 *
 * USAGE RESTRICTION (Requirements 19.3, 19.4): the component is for scroll-based
 * NON-gameplay surfaces only and must never drive the in-round falling lyrics.
 */

export {
  default as ScrollReveal,
  createScrollRevealAnimation,
  DEFAULT_SCROLL_REVEAL_CONFIG,
  DEFAULT_STAGGER,
  type ScrollRevealProps,
  type ScrollRevealEngine,
  type GsapLike,
  type TweenLike,
  type ScrollTriggerInstanceLike,
  type CreatedReveal,
} from './ScrollReveal.tsx';

export { splitIntoWords, isWhitespaceToken } from './splitWords.ts';

export {
  clampProgress,
  opacityAt,
  blurAt,
  rotationAt,
  styleAt,
  revealedStyleAt,
  FULL_OPACITY,
  NO_BLUR_PX,
  NO_ROTATION_DEG,
  type RevealStyle,
} from './revealMapping.ts';
