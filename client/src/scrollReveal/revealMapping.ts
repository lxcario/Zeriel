/**
 * Pure scroll-progress → style mapping for the Scroll_Reveal_Animation (task 11.1).
 *
 * Design references:
 * - Requirement 19.2: WHILE scrolling, scrub each word's opacity from
 *   `baseOpacity` → full (1), each word's blur from `blurStrength` → 0, and the
 *   container rotation from `baseRotation` → 0, in proportion to scroll position.
 * - Requirement 19.5: the configurable params (`enableBlur`, `baseOpacity`,
 *   `baseRotation`, `blurStrength`, `scrollStart`, `scrollEnd`) are honored.
 * - Requirement 19.6: under Reduce_Motion_Mode the text is rendered at full
 *   opacity, no blur, and no rotation (see {@link revealedStyleAt}).
 * - design.md Property 44 ("Scroll-progress mapping is monotonic and honors
 *   configured endpoints").
 *
 * This module is intentionally PURE (no DOM, no React, no GSAP) so it is the
 * direct target of the optional Property 44 test (task 11.3) and can be unit-
 * tested in a plain `node` environment. The React/GSAP view in
 * `ScrollReveal.tsx` uses these same functions to set base/initial values, so
 * the property tests exercise the real production mapping.
 *
 * ## Mapping definitions (endpoints + linear interpolation)
 *
 * Let `p` be the scroll progress, clamped to `[0, 1]` (see {@link clampProgress}).
 *
 *   opacityAt(p)  = baseOpacity + (1 - baseOpacity) * p
 *                 → p=0 ⇒ baseOpacity ;  p=1 ⇒ 1
 *
 *   blurAt(p)     = enableBlur ? blurStrength * (1 - p) : 0      (pixels)
 *                 → p=0 ⇒ blurStrength ; p=1 ⇒ 0 ; (always 0 when blur disabled)
 *
 *   rotationAt(p) = baseRotation * (1 - p)                        (degrees)
 *                 → p=0 ⇒ baseRotation ; p=1 ⇒ 0
 *
 * Each is a LINEAR interpolation, hence monotonic in `p` (non-decreasing for
 * opacity, non-increasing for blur and |rotation|), and each hits the configured
 * base value exactly at `p=0` and the fully-revealed value exactly at `p=1`
 * (Property 44).
 */

import type { ScrollRevealConfig } from '@glitch/core';

/** The fully-revealed per-word/container style (progress 1, or Reduce_Motion). */
export interface RevealStyle {
  /** Per-word opacity in `[0, 1]`. */
  opacity: number;
  /** Per-word blur radius in pixels (`>= 0`). */
  blurPx: number;
  /** Container rotation in degrees. */
  rotationDeg: number;
}

/** Opacity of fully-revealed text (Requirement 19.2 endpoint). */
export const FULL_OPACITY = 1 as const;
/** Blur of fully-revealed text, in pixels (Requirement 19.2 endpoint). */
export const NO_BLUR_PX = 0 as const;
/** Rotation of fully-revealed text, in degrees (Requirement 19.2 endpoint). */
export const NO_ROTATION_DEG = 0 as const;

/**
 * Clamp raw scroll progress to the `[0, 1]` domain used by the mappings.
 *
 * GSAP ScrollTrigger reports scrub progress in `[0, 1]`, but clamping keeps the
 * pure functions total and well-defined for any input (Property 44 quantifies
 * over `[0, 1]`, and clamping guarantees the endpoints are respected even if a
 * caller passes a slightly out-of-range value). Non-finite input is treated as
 * `0` (the un-revealed base state).
 *
 * @param p - Raw progress value.
 * @returns `p` constrained to `[0, 1]`.
 */
export function clampProgress(p: number): number {
  if (!Number.isFinite(p)) return 0;
  if (p < 0) return 0;
  if (p > 1) return 1;
  return p;
}

/**
 * Per-word opacity at scroll progress `p`.
 *
 * Linear interpolation `baseOpacity → 1`. Non-decreasing in `p`; equals
 * `baseOpacity` at `p=0` and `1` at `p=1` (Requirement 19.2).
 *
 * @param p - Scroll progress (clamped to `[0, 1]`).
 * @param baseOpacity - Opacity at progress 0 (`ScrollRevealConfig.baseOpacity`).
 */
export function opacityAt(p: number, baseOpacity: number): number {
  const t = clampProgress(p);
  return baseOpacity + (FULL_OPACITY - baseOpacity) * t;
}

/**
 * Per-word blur (in pixels) at scroll progress `p`.
 *
 * Linear interpolation `blurStrength → 0`. Non-increasing in `p`; equals
 * `blurStrength` at `p=0` and `0` at `p=1` (Requirement 19.2). When
 * `enableBlur` is `false`, blur is ALWAYS `0` regardless of progress
 * (Requirement 19.5).
 *
 * @param p - Scroll progress (clamped to `[0, 1]`).
 * @param blurStrength - Blur radius in px at progress 0 (`ScrollRevealConfig.blurStrength`).
 * @param enableBlur - Whether blur is animated at all (`ScrollRevealConfig.enableBlur`).
 */
export function blurAt(p: number, blurStrength: number, enableBlur: boolean): number {
  if (!enableBlur) return NO_BLUR_PX;
  const t = clampProgress(p);
  return blurStrength * (1 - t);
}

/**
 * Container rotation (in degrees) at scroll progress `p`.
 *
 * Linear interpolation `baseRotation → 0`. Monotonic in `p` (|rotation|
 * non-increasing); equals `baseRotation` at `p=0` and `0` at `p=1`
 * (Requirement 19.2).
 *
 * @param p - Scroll progress (clamped to `[0, 1]`).
 * @param baseRotation - Rotation in degrees at progress 0 (`ScrollRevealConfig.baseRotation`).
 */
export function rotationAt(p: number, baseRotation: number): number {
  const t = clampProgress(p);
  return baseRotation * (1 - t);
}

/**
 * Compute the full {@link RevealStyle} at scroll progress `p` for a given
 * reveal configuration. Convenience composition of {@link opacityAt},
 * {@link blurAt}, and {@link rotationAt} used by the React/GSAP view to set
 * base/initial values.
 *
 * @param p - Scroll progress (clamped to `[0, 1]`).
 * @param config - The reveal configuration endpoints (Requirement 19.5).
 */
export function styleAt(p: number, config: ScrollRevealConfig): RevealStyle {
  return {
    opacity: opacityAt(p, config.baseOpacity),
    blurPx: blurAt(p, config.blurStrength, config.enableBlur),
    rotationDeg: rotationAt(p, config.baseRotation),
  };
}

/**
 * The fully-revealed style: full opacity, no blur, no rotation.
 *
 * This is both the `p=1` endpoint (Requirement 19.2) and the Reduce_Motion_Mode
 * style (Requirement 19.6) — under reduced motion the text is rendered fully
 * revealed with no animation, identical to having scrolled all the way through.
 */
export function revealedStyleAt(): RevealStyle {
  return { opacity: FULL_OPACITY, blurPx: NO_BLUR_PX, rotationDeg: NO_ROTATION_DEG };
}
