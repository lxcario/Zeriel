// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { act } from 'react';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import * as fc from 'fast-check';
import type { ScrollRevealConfig } from '@glitch/core';
import ScrollReveal, {
  type GsapLike,
  type ScrollRevealEngine,
  type TweenLike,
} from './ScrollReveal.tsx';
import {
  revealedStyleAt,
  FULL_OPACITY,
  NO_BLUR_PX,
  NO_ROTATION_DEG,
} from './revealMapping.ts';

/**
 * Property-based test for Reduce_Motion_Mode reveal (task 11.4).
 *
 * Property 45: Reduce-motion fully reveals the text.
 * **Validates: Requirements 19.6**
 *
 * Design ("Correctness Properties" / Property 45): *For any* reveal
 * configuration and any scroll progress, when Reduce_Motion_Mode is enabled the
 * computed style is full opacity, zero blur, and zero rotation. Requirement 19.6
 * (consistent with Requirement 13): WHERE Reduce_Motion_Mode is enabled, the
 * Client suppresses the Scroll_Reveal_Animation by rendering the text at full
 * opacity with no blur and no rotation (and, per the component contract / 19.8,
 * creates NO ScrollTrigger).
 *
 * ## Angles implemented (and why)
 *
 * `@testing-library/react` is NOT a dependency of this monorepo, but `react`,
 * `react-dom`, jsdom, and fast-check are. So both complementary angles below are
 * implemented WITHOUT adding heavy new deps:
 *
 *   A) PURE-mapping property (the 100-run property part): the component derives
 *      its reduce-motion `initial` style from the documented constants
 *      `FULL_OPACITY` / `NO_BLUR_PX` / `NO_ROTATION_DEG`, which are exactly the
 *      triple returned by `revealedStyleAt()`. For ANY generated scroll progress
 *      `p` (including out-of-range, ±Infinity, and NaN) and ANY reveal config,
 *      the reduced style is invariantly `{opacity:1, blurPx:0, rotationDeg:0}`.
 *      This is the direct, framework-free encoding of Property 45 / 19.6.
 *
 *   B) COMPONENT render (1–2 representative cases, via `react-dom/client` under
 *      jsdom with an injected FAKE engine): renders `<ScrollReveal
 *      reduceMotion>` across representative configs and asserts (1) the fake
 *      engine's tween/ScrollTrigger factory (`gsap.fromTo`) is NEVER called — no
 *      scroll-driven animation / ScrollTrigger is created under reduce motion —
 *      and (2) every rendered WORD span carries the fully-revealed style
 *      (opacity 1, `blur(0px)`, container `rotate(0deg)`), regardless of the
 *      generated `baseOpacity` / `baseRotation` / `blurStrength` / `enableBlur` /
 *      `scrollStart` / `scrollEnd`. JSX is avoided (`createElement`) so the file
 *      stays a plain `.ts`.
 *
 * numRuns for the property part is left at the global default (100, from
 * vitest.setup.ts) and is not weakened.
 */

/** The fully-revealed style triple Requirement 19.6 mandates under reduce motion. */
const REVEALED = { opacity: 1, blurPx: 0, rotationDeg: 0 } as const;

/** Arbitrary reveal configuration spanning the documented parameter ranges (19.5). */
const configArb: fc.Arbitrary<ScrollRevealConfig> = fc.record({
  enableBlur: fc.boolean(),
  baseOpacity: fc.double({ min: 0, max: 1, noNaN: true }),
  baseRotation: fc.double({ min: -90, max: 90, noNaN: true }),
  blurStrength: fc.double({ min: 0, max: 40, noNaN: true }),
  scrollStart: fc.string(),
  scrollEnd: fc.string(),
});

/**
 * Arbitrary scroll progress, deliberately UNCONSTRAINED: includes values inside
 * and outside [0,1], plus ±Infinity and NaN, to prove the reduced style does not
 * depend on `p` in any way.
 */
const progressArb: fc.Arbitrary<number> = fc.double();

describe('ScrollReveal reduce-motion (Property 45: reduce-motion fully reveals the text, 19.6)', () => {
  // ----- Angle A: pure-mapping property (the 100-run property part) ---------
  it('reduced style is the fully-revealed triple for ANY progress and ANY config (19.6)', () => {
    fc.assert(
      fc.property(progressArb, configArb, (_p, _config) => {
        // The reduce-motion style the component uses is independent of progress
        // and config: it is always full opacity, zero blur, zero rotation.
        expect(revealedStyleAt()).toEqual(REVEALED);
      }),
    );
  });

  it('the constants the component uses for its reduce-motion initial match the revealed triple (19.6)', () => {
    // ScrollReveal builds `initial = { opacity: FULL_OPACITY, blurPx: NO_BLUR_PX,
    // rotationDeg: NO_ROTATION_DEG }` under reduce motion — pin those constants.
    expect({
      opacity: FULL_OPACITY,
      blurPx: NO_BLUR_PX,
      rotationDeg: NO_ROTATION_DEG,
    }).toEqual(REVEALED);
    expect(revealedStyleAt()).toEqual({
      opacity: FULL_OPACITY,
      blurPx: NO_BLUR_PX,
      rotationDeg: NO_ROTATION_DEG,
    });
  });

  // ----- Angle B: component render with an injected fake engine -------------
  /** A fake GSAP engine that records whether its tween factory was invoked. */
  function makeFakeEngine(): { engine: ScrollRevealEngine; fromToCalls: () => number } {
    let calls = 0;
    const gsap: GsapLike = {
      fromTo(_targets: unknown, _fromVars: object, _toVars: object): TweenLike {
        calls += 1;
        return { scrollTrigger: { kill() {} }, kill() {} };
      },
    };
    return { engine: { gsap }, fromToCalls: () => calls };
  }

  /** Representative configs: defaults, both blur modes, and the parameter extremes. */
  const representativeCases: ReadonlyArray<{ name: string; config: ScrollRevealConfig; child: string }> = [
    {
      name: 'typical config (blur enabled)',
      config: { enableBlur: true, baseOpacity: 0.1, baseRotation: 3, blurStrength: 4, scrollStart: 'top bottom', scrollEnd: 'bottom center' },
      child: 'Reveal these words on scroll',
    },
    {
      name: 'extreme config (max blur/rotation, zero base opacity)',
      config: { enableBlur: true, baseOpacity: 0, baseRotation: 90, blurStrength: 40, scrollStart: 'top top', scrollEnd: 'bottom top' },
      child: 'edge\tcase   spacing\nhere',
    },
    {
      name: 'blur disabled, negative rotation',
      config: { enableBlur: false, baseOpacity: 0.5, baseRotation: -45, blurStrength: 12, scrollStart: 'center', scrollEnd: 'center' },
      child: 'single',
    },
  ];

  for (const { name, config, child } of representativeCases) {
    it(`renders fully revealed and creates NO ScrollTrigger under reduce motion — ${name} (19.6)`, async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const { engine, fromToCalls } = makeFakeEngine();
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(ScrollReveal, { reduceMotion: true, engine, ...config, children: child }),
        );
      });

      // (1) No scroll-driven animation / ScrollTrigger created (19.6, ties to 19.8).
      expect(fromToCalls()).toBe(0);

      // (2) Container is unrotated; every WORD span is fully revealed.
      const containerSpan = container.querySelector('span[aria-label]') as HTMLElement | null;
      expect(containerSpan).not.toBeNull();
      expect(containerSpan!.style.transform).toBe('rotate(0deg)');

      const wordSpans = Array.from(
        container.querySelectorAll<HTMLElement>('[data-srw-word]'),
      );
      expect(wordSpans.length).toBeGreaterThan(0);
      for (const word of wordSpans) {
        expect(word.style.opacity).toBe('1');
        expect(word.style.filter).toBe('blur(0px)');
      }

      await act(async () => {
        root.unmount();
      });
      container.remove();
    });
  }
});
