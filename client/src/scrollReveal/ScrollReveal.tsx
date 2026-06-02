/**
 * Scroll_Reveal_Animation React component (task 11.1).
 *
 * Based on the React Bits ScrollReveal pattern, driven by GSAP ScrollTrigger.
 *
 * Design references:
 * - design.md "Scroll_Reveal Component".
 * - Requirement 19.1: split a STRING child into one `<span>` per WORD and
 *   animate words with a configured stagger.
 * - Requirement 19.2: WHILE scrolling, scrub each word's opacity
 *   `baseOpacity → 1`, each word's blur `blurStrength → 0`, and the container
 *   rotation `baseRotation → 0`, in proportion to scroll position via GSAP
 *   ScrollTrigger.
 * - Requirement 19.5: expose `enableBlur`, `baseOpacity`, `baseRotation`,
 *   `blurStrength`, `scrollStart`, `scrollEnd` (matching `ScrollRevealConfig`).
 * - Requirement 19.6: WHERE Reduce_Motion_Mode is enabled, render the text at
 *   FULL opacity, NO blur, NO rotation, and create NO ScrollTrigger.
 * - Requirement 19.8: WHEN the hosting component unmounts, kill the
 *   ScrollTrigger instances this component created.
 *
 * ## USAGE RESTRICTION (Requirements 19.3, 19.4)
 *
 * This component is for **scroll-based NON-gameplay surfaces ONLY** — the
 * Landing_Page and an optional Scorecard reveal / how-to-play intro. It MUST
 * NOT be used to drive the in-round falling lyric animation, which is
 * audio-playback-time and physics driven by the `GameCore`/Renderer per
 * Requirements 6 and 7. The restriction is by convention (documented here, and
 * audited by the static test in task 14.2); it is not enforced at runtime.
 *
 * ## Pure-logic separation
 *
 * The word splitting (`splitWords.ts`) and the progress→style mapping
 * (`revealMapping.ts`) are PURE, DOM-free modules so the property tests
 * (11.2–11.4) target them directly. This component is the thin React/GSAP view
 * over those helpers. The GSAP wiring is factored into the injectable
 * {@link createScrollRevealAnimation} helper so the cleanup property test
 * (11.5 / Property 46) can supply a fake engine and assert the created
 * ScrollTrigger instances are killed on unmount.
 */

import { useLayoutEffect, useMemo, useRef } from 'react';
import gsapDefault from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import type { ScrollRevealConfig } from '@glitch/core';
import { getEffectiveReduceMotion } from '../theme/index.ts';
import { isWhitespaceToken, splitIntoWords } from './splitWords.ts';
import {
  FULL_OPACITY,
  NO_BLUR_PX,
  NO_ROTATION_DEG,
  styleAt,
} from './revealMapping.ts';

// ---------------------------------------------------------------------------
// Injectable GSAP engine seam (keeps the GSAP wiring testable)
// ---------------------------------------------------------------------------

/** A killable handle, structurally matching a GSAP `ScrollTrigger` instance. */
export interface ScrollTriggerInstanceLike {
  kill(reset?: boolean): void;
}

/** A GSAP tween handle, exposing its associated ScrollTrigger (if any). */
export interface TweenLike {
  scrollTrigger?: ScrollTriggerInstanceLike;
  kill(): void;
}

/** The minimal slice of the GSAP API this component depends on. */
export interface GsapLike {
  fromTo(targets: unknown, fromVars: object, toVars: object): TweenLike;
}

/** Engine bundle the component uses; injectable for testing (Property 46). */
export interface ScrollRevealEngine {
  gsap: GsapLike;
}

/** Tracks the GSAP tweens and ScrollTrigger instances created for one reveal. */
export interface CreatedReveal {
  /** The ScrollTrigger instances created by this reveal (Requirement 19.8). */
  triggers: ScrollTriggerInstanceLike[];
  /** The tweens created by this reveal. */
  tweens: TweenLike[];
  /** Kill every ScrollTrigger and tween this reveal created. */
  kill(): void;
}

/** Default per-word stagger (seconds) when none is supplied (Requirement 19.1). */
export const DEFAULT_STAGGER = 0.05 as const;

/**
 * Default reveal configuration. Consumers may override any subset; this keeps
 * the component ergonomic while still exposing every configurable parameter
 * (Requirement 19.5).
 */
export const DEFAULT_SCROLL_REVEAL_CONFIG: ScrollRevealConfig = {
  enableBlur: true,
  baseOpacity: 0.1,
  baseRotation: 3,
  blurStrength: 4,
  scrollStart: 'top bottom',
  scrollEnd: 'bottom center',
};

// Register the ScrollTrigger plugin lazily and exactly once. Registration is
// guarded so importing this module never throws during test collection in a
// non-browser-complete environment (jsdom/SSR); the pure helpers are imported
// separately and are unaffected.
let pluginRegistered = false;
function getDefaultEngine(): ScrollRevealEngine {
  if (!pluginRegistered) {
    try {
      gsapDefault.registerPlugin(ScrollTrigger);
    } catch {
      // Non-DOM/SSR/test environment — registration is a no-op here.
    }
    pluginRegistered = true;
  }
  return { gsap: gsapDefault as unknown as GsapLike };
}

/**
 * Create the scrubbed GSAP tweens + ScrollTrigger instances for one reveal and
 * return handles to exactly those, so the caller can kill precisely what it
 * created on unmount (Requirement 19.8 — never `ScrollTrigger.killAll()`).
 *
 * Builds, against scroll progress 0→1 (Requirement 19.2):
 *  - container rotation `baseRotation → 0`,
 *  - per-word opacity `baseOpacity → 1` (staggered),
 *  - per-word blur `blurStrength → 0` (staggered), only when `enableBlur`.
 *
 * Each tween uses `scrub: true` so its progress is tied to scroll position, and
 * `ease: 'none'` so the on-screen interpolation matches the linear pure mapping
 * in `revealMapping.ts`.
 *
 * @returns A {@link CreatedReveal} tracking the created instances.
 */
export function createScrollRevealAnimation(params: {
  gsap: GsapLike;
  container: Element;
  wordElements: readonly Element[];
  config: ScrollRevealConfig;
  stagger: number;
}): CreatedReveal {
  const { gsap, container, wordElements, config, stagger } = params;
  const tweens: TweenLike[] = [];

  const scrollTriggerVars = () => ({
    trigger: container,
    start: config.scrollStart,
    end: config.scrollEnd,
    scrub: true as const,
  });

  // Container rotation: baseRotation -> 0 (Requirement 19.2).
  tweens.push(
    gsap.fromTo(
      container,
      { rotate: config.baseRotation },
      { rotate: NO_ROTATION_DEG, ease: 'none', scrollTrigger: scrollTriggerVars() },
    ),
  );

  // Per-word opacity: baseOpacity -> 1, staggered (Requirements 19.1, 19.2).
  if (wordElements.length > 0) {
    tweens.push(
      gsap.fromTo(
        wordElements as Element[],
        { opacity: config.baseOpacity },
        { opacity: FULL_OPACITY, ease: 'none', stagger, scrollTrigger: scrollTriggerVars() },
      ),
    );

    // Per-word blur: blurStrength -> 0, staggered, only when enabled (19.2, 19.5).
    if (config.enableBlur) {
      tweens.push(
        gsap.fromTo(
          wordElements as Element[],
          { filter: `blur(${config.blurStrength}px)` },
          { filter: `blur(${NO_BLUR_PX}px)`, ease: 'none', stagger, scrollTrigger: scrollTriggerVars() },
        ),
      );
    }
  }

  const triggers: ScrollTriggerInstanceLike[] = [];
  for (const tween of tweens) {
    if (tween.scrollTrigger) triggers.push(tween.scrollTrigger);
  }

  return {
    triggers,
    tweens,
    kill() {
      // Kill the ScrollTrigger instances first (killing a tween does not kill
      // its ScrollTrigger in GSAP), then the tweens themselves.
      for (const trigger of triggers) trigger.kill();
      for (const tween of tweens) tween.kill();
    },
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Props for {@link ScrollReveal}. The reveal-config fields mirror
 * `ScrollRevealConfig` (Requirement 19.5) and are all optional, defaulting to
 * {@link DEFAULT_SCROLL_REVEAL_CONFIG}.
 */
export interface ScrollRevealProps extends Partial<ScrollRevealConfig> {
  /** The text to reveal. A STRING child only, per Requirement 19.1. */
  children: string;
  /** Per-word reveal stagger in seconds. Defaults to {@link DEFAULT_STAGGER}. */
  stagger?: number;
  /**
   * Whether Reduce_Motion_Mode is enabled. Defaults to the effective client
   * setting via {@link getEffectiveReduceMotion}. When `true`, the text renders
   * fully revealed and NO ScrollTrigger is created (Requirement 19.6).
   */
  reduceMotion?: boolean;
  /** Optional class for the container element. */
  className?: string;
  /** Optional class applied to each WORD span. */
  wordClassName?: string;
  /** Injectable GSAP engine seam for testing; defaults to the real GSAP. */
  engine?: ScrollRevealEngine;
}

/** `data-*` marker used to locate WORD spans within the container for GSAP. */
const WORD_ATTR = 'data-srw-word';

/**
 * Reveal a string word-by-word as the user scrolls (Requirement 19).
 *
 * Splits `children` into one `<span>` per word (whitespace preserved verbatim
 * for layout), then either renders the text fully revealed under
 * Reduce_Motion_Mode (Requirement 19.6) or wires scrubbed GSAP ScrollTrigger
 * animations on mount and tears them down on unmount (Requirements 19.2, 19.8).
 *
 * USAGE RESTRICTION: non-gameplay scroll surfaces only — never the in-round
 * falling lyrics (Requirements 19.3, 19.4). See the file header.
 */
export default function ScrollReveal({
  children,
  stagger = DEFAULT_STAGGER,
  reduceMotion,
  className,
  wordClassName,
  engine,
  enableBlur = DEFAULT_SCROLL_REVEAL_CONFIG.enableBlur,
  baseOpacity = DEFAULT_SCROLL_REVEAL_CONFIG.baseOpacity,
  baseRotation = DEFAULT_SCROLL_REVEAL_CONFIG.baseRotation,
  blurStrength = DEFAULT_SCROLL_REVEAL_CONFIG.blurStrength,
  scrollStart = DEFAULT_SCROLL_REVEAL_CONFIG.scrollStart,
  scrollEnd = DEFAULT_SCROLL_REVEAL_CONFIG.scrollEnd,
}: ScrollRevealProps) {
  const containerRef = useRef<HTMLSpanElement | null>(null);

  const config: ScrollRevealConfig = useMemo(
    () => ({ enableBlur, baseOpacity, baseRotation, blurStrength, scrollStart, scrollEnd }),
    [enableBlur, baseOpacity, baseRotation, blurStrength, scrollStart, scrollEnd],
  );

  // Lossless tokenization (Requirement 19.1 / Property 43): tokens.join('') === children.
  const tokens = useMemo(() => splitIntoWords(children), [children]);

  // Resolve the effective Reduce_Motion_Mode. An explicit prop always wins;
  // otherwise fall back to the persisted/browser setting (Requirements 13, 19.6).
  const effectiveReduceMotion = reduceMotion ?? getEffectiveReduceMotion();

  useLayoutEffect(() => {
    // Reduce_Motion_Mode: render fully revealed, create NO ScrollTrigger (19.6).
    if (effectiveReduceMotion) return undefined;

    const container = containerRef.current;
    if (container === null) return undefined;

    const activeEngine = engine ?? getDefaultEngine();
    const wordElements = Array.from(
      container.querySelectorAll(`[${WORD_ATTR}]`),
    );

    const reveal = createScrollRevealAnimation({
      gsap: activeEngine.gsap,
      container,
      wordElements,
      config,
      stagger,
    });

    // Unmount/dep-change cleanup: kill exactly the instances we created (19.8).
    return () => {
      reveal.kill();
    };
  }, [effectiveReduceMotion, engine, config, stagger]);

  // Initial inline styles. Under Reduce_Motion the words are fully revealed
  // (opacity 1, no blur, no rotation; Requirement 19.6). Otherwise they start at
  // the configured base state (progress 0) to avoid a flash before GSAP runs.
  const initial = effectiveReduceMotion
    ? { opacity: FULL_OPACITY, blurPx: NO_BLUR_PX, rotationDeg: NO_ROTATION_DEG }
    : styleAt(0, config);

  const containerStyle: React.CSSProperties = {
    display: 'inline-block',
    whiteSpace: 'pre-wrap',
    transform: `rotate(${initial.rotationDeg}deg)`,
  };

  const wordStyle: React.CSSProperties = {
    display: 'inline-block',
    opacity: initial.opacity,
    filter: `blur(${initial.blurPx}px)`,
    willChange: 'opacity, filter',
  };

  return (
    <span ref={containerRef} className={className} style={containerStyle} aria-label={children}>
      {tokens.map((token, index) =>
        isWhitespaceToken(token) ? (
          // Whitespace preserved verbatim so the original layout is reproduced.
          <span key={index} aria-hidden="true">
            {token}
          </span>
        ) : (
          <span
            key={index}
            {...{ [WORD_ATTR]: '' }}
            className={wordClassName}
            style={wordStyle}
            aria-hidden="true"
          >
            {token}
          </span>
        ),
      )}
    </span>
  );
}
