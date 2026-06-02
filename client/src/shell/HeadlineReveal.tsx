/**
 * `HeadlineReveal` — a test-safe wrapper around {@link ScrollReveal} for the
 * Premium_Entry_Surfaces (task 14.1).
 *
 * The Landing_Page uses the Scroll_Reveal_Animation (Requirement 19.3) for its
 * headline copy. {@link ScrollReveal} only animates when NOT in
 * Reduce_Motion_Mode; under reduce motion it renders the text fully revealed and
 * creates NO ScrollTrigger (Requirement 19.6).
 *
 * GSAP's ScrollTrigger requires a real browser environment (it calls
 * `window.matchMedia`). In non-browser environments (jsdom/SSR) that API is
 * absent, so this wrapper detects an animation-capable environment and forces
 * the fully-revealed (reduce-motion) path otherwise. The visible text is
 * identical either way — only the scroll animation differs — so the content and
 * accessibility of the premium surface are unaffected.
 */

import { useMemo } from 'react';
import { ScrollReveal, type ScrollRevealProps } from '../scrollReveal/index.ts';

/**
 * `true` when the environment can drive a GSAP ScrollTrigger animation — i.e.
 * `window.matchMedia` exists (real browsers). `false` under jsdom/SSR, where we
 * fall back to fully-revealed static text.
 */
export function canAnimateScroll(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
  } catch {
    return false;
  }
}

/**
 * Props for {@link HeadlineReveal}. Mirrors {@link ScrollRevealProps}; the
 * effective Reduce_Motion_Mode is the caller's `reduceMotion` OR a forced `true`
 * whenever the environment cannot animate (see {@link canAnimateScroll}).
 */
export type HeadlineRevealProps = ScrollRevealProps;

/**
 * Reveal headline text word-by-word on scroll (premium surfaces only,
 * Requirements 19.3/19.4), degrading to fully-revealed static text when the
 * environment cannot drive ScrollTrigger.
 */
export function HeadlineReveal({ reduceMotion, ...rest }: HeadlineRevealProps) {
  // Force reduce-motion (fully revealed, no ScrollTrigger) when we cannot
  // animate, so the component is safe to render under jsdom/SSR. When we CAN
  // animate, defer to the caller's `reduceMotion` (which may be undefined, in
  // which case ScrollReveal resolves the effective setting itself).
  const forcedReduceMotion = useMemo(() => !canAnimateScroll(), []);
  const reduceMotionProp: Pick<ScrollRevealProps, 'reduceMotion'> = forcedReduceMotion
    ? { reduceMotion: true }
    : reduceMotion !== undefined
      ? { reduceMotion }
      : {};
  return <ScrollReveal {...reduceMotionProp} {...rest} />;
}

export default HeadlineReveal;
