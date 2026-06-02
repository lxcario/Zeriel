/**
 * Render and scroll-reveal configuration shapes shared across packages.
 *
 * Design references: design.md "Data Models — Audio / config", the Renderer
 * interface, and the Scroll_Reveal Component section. These are configuration
 * shapes only; the consuming Renderer/ScrollReveal live in the client package.
 */

/**
 * Options passed to the Renderer at init (design.md Renderer interface).
 */
export interface RenderOptions {
  /** When true, suppress non-essential motion (Requirement 13.1). */
  reduceMotion: boolean;
  /** Maximum bounded off-grid offset applied to play/UI elements (Requirement 12.3). */
  offGridMaxOffsetPx: number;
}

/**
 * Configurable parameters for the Scroll_Reveal_Animation (Requirement 19.5).
 * `scrollStart`/`scrollEnd` are GSAP ScrollTrigger start/end strings
 * (e.g. `"top bottom"`).
 */
export interface ScrollRevealConfig {
  /** Whether per-word blur is animated (Requirement 19.5). */
  enableBlur: boolean;
  /** Per-word opacity at scroll progress 0 (Requirement 19.2). */
  baseOpacity: number;
  /** Container rotation in degrees at scroll progress 0 (Requirement 19.2). */
  baseRotation: number;
  /** Per-word blur strength at scroll progress 0, in pixels (Requirement 19.2). */
  blurStrength: number;
  /** GSAP ScrollTrigger start point (Requirement 19.5). */
  scrollStart: string;
  /** GSAP ScrollTrigger end point (Requirement 19.5). */
  scrollEnd: string;
}
