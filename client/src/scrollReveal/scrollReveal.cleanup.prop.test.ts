// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { act } from 'react';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import * as fc from 'fast-check';
import type { ScrollRevealConfig } from '@glitch/core';
import ScrollReveal, {
  type GsapLike,
  type TweenLike,
  type ScrollRevealEngine,
  type ScrollTriggerInstanceLike,
} from './ScrollReveal.tsx';

/**
 * Property-based test for ScrollTrigger cleanup (task 11.5).
 *
 * Property 46: ScrollTrigger instances are cleaned up on unmount.
 * **Validates: Requirements 19.8**
 *
 * Design ("Correctness Properties" / Property 46): *For any* ScrollReveal that
 * is mounted and then unmounted, all ScrollTrigger instances it created are
 * killed, leaving none registered for that component. Requirement 19.8: WHEN a
 * component hosting a Scroll_Reveal_Animation unmounts, THE Client SHALL clean
 * up the ScrollTrigger instances created for that Scroll_Reveal_Animation.
 *
 * ## Approach (COMPONENT-LEVEL render/unmount under jsdom)
 *
 * We render the real {@link ScrollReveal} component (not just the
 * `createScrollRevealAnimation` helper) so this test exercises the actual
 * `useLayoutEffect` setup + cleanup wiring that fires on unmount — the behavior
 * Requirement 19.8 is about.
 *
 * Rendering uses `react-dom/client` `createRoot` + `act` (from `react`) under
 * the `jsdom` environment, mirroring the existing `client/src/App.test.tsx`
 * (no new test deps such as @testing-library are added — they are not present).
 *
 * The GSAP engine is INJECTED via the component's `engine` seam with a FAKE
 * that records every tween + ScrollTrigger it creates and flips a `killed`
 * flag whenever `.kill()` is called on them. The fake also exposes a `killAll`
 * spy that the component has NO API path to reach: the only way for every
 * created instance to end up killed is the per-instance `kill()` invoked by the
 * effect cleanup — i.e. "kill exactly those, not `ScrollTrigger.killAll()`".
 *
 * We force `reduceMotion={false}` so the component DOES create triggers
 * (Requirement 19.6 means reduce-motion would create none, which is a separate
 * property). The generated child always contains >= 1 word, so beyond the
 * always-present container-rotation trigger there is at least an opacity
 * trigger, and (when `enableBlur`) a blur trigger too — letting us vary the
 * created-instance count across runs and assert the invariant holds regardless.
 *
 * numRuns is left at the global default (100, from `vitest.setup.ts`); we do
 * not weaken it. Children are kept short (1-4 short words) to bound the
 * per-run mount/unmount work.
 */

// React 19's `act` expects this flag; set it so warnings don't pollute output.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Fake recording engine (the injection seam)
// ---------------------------------------------------------------------------

interface FakeTrigger extends ScrollTriggerInstanceLike {
  killed: boolean;
  killCount: number;
}

interface FakeTween extends TweenLike {
  killed: boolean;
  killCount: number;
}

interface RecordingEngine extends ScrollRevealEngine {
  createdTriggers: FakeTrigger[];
  createdTweens: FakeTween[];
  /** Spy for a global kill-all; the component must NEVER use this to clean up. */
  killAll(): void;
  killAllCalls: number;
}

function makeRecordingEngine(): RecordingEngine {
  const createdTriggers: FakeTrigger[] = [];
  const createdTweens: FakeTween[] = [];

  const gsap: GsapLike = {
    fromTo(_targets: unknown, _fromVars: object, toVars: object): TweenLike {
      // Mirror real GSAP: when the `toVars` carry a `scrollTrigger` config, a
      // ScrollTrigger instance is created and exposed on the returned tween.
      const hasScrollTrigger =
        typeof (toVars as { scrollTrigger?: unknown }).scrollTrigger !== 'undefined';

      let trigger: FakeTrigger | undefined;
      if (hasScrollTrigger) {
        trigger = {
          killed: false,
          killCount: 0,
          kill() {
            this.killed = true;
            this.killCount += 1;
          },
        };
        createdTriggers.push(trigger);
      }

      const tween: FakeTween = {
        // Only attach `scrollTrigger` when one was created: the property is
        // optional and under `exactOptionalPropertyTypes` must not be set to
        // `undefined` explicitly.
        ...(trigger ? { scrollTrigger: trigger } : {}),
        killed: false,
        killCount: 0,
        kill() {
          this.killed = true;
          this.killCount += 1;
        },
      };
      createdTweens.push(tween);
      return tween;
    },
  };

  const engine: RecordingEngine = {
    gsap,
    createdTriggers,
    createdTweens,
    killAllCalls: 0,
    killAll() {
      this.killAllCalls += 1;
    },
  };
  return engine;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** A single non-whitespace "word" of letters/digits. */
const wordArb: fc.Arbitrary<string> = fc.string({
  unit: fc.constantFrom('a', 'b', 'c', 'x', 'y', 'z', 'A', 'M', 'Z', '1', '7'),
  minLength: 1,
  maxLength: 5,
});

/** 1-4 words joined by single spaces (guarantees >= 1 word element). */
const childArb: fc.Arbitrary<string> = fc
  .array(wordArb, { minLength: 1, maxLength: 4 })
  .map((words) => words.join(' '));

/** Typical GSAP start/end strings, plus some arbitrary ones to broaden. */
const scrollEdgeArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('top bottom', 'bottom center', 'top center', 'center center', 'bottom top'),
  fc.string({ minLength: 1, maxLength: 16 }),
);

const configArb: fc.Arbitrary<ScrollRevealConfig> = fc.record({
  enableBlur: fc.boolean(),
  baseOpacity: fc.double({ min: 0, max: 1, noNaN: true }),
  baseRotation: fc.double({ min: -180, max: 180, noNaN: true }),
  blurStrength: fc.double({ min: 0, max: 20, noNaN: true }),
  scrollStart: scrollEdgeArb,
  scrollEnd: scrollEdgeArb,
});

const staggerArb: fc.Arbitrary<number> = fc.double({ min: 0, max: 0.5, noNaN: true });

// ---------------------------------------------------------------------------
// Property 46
// ---------------------------------------------------------------------------

describe('Property 46: ScrollTrigger instances are cleaned up on unmount (Requirement 19.8)', () => {
  it('kills exactly the ScrollTrigger/tween instances it created — never a global killAll', async () => {
    await fc.assert(
      fc.asyncProperty(childArb, configArb, staggerArb, async (children, config, stagger) => {
        const engine = makeRecordingEngine();

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        // --- Mount: with reduceMotion=false the component DOES create triggers.
        await act(async () => {
          root.render(
            createElement(ScrollReveal, {
              children,
              reduceMotion: false,
              engine,
              stagger,
              ...config,
            }),
          );
        });

        // At least one ScrollTrigger was set up on mount (container rotation),
        // and each created tween has an associated trigger.
        expect(engine.createdTriggers.length).toBeGreaterThanOrEqual(1);
        expect(engine.createdTweens.length).toBe(engine.createdTriggers.length);
        expect(engine.killAllCalls).toBe(0);
        // Nothing killed yet while still mounted.
        expect(engine.createdTriggers.every((t) => !t.killed)).toBe(true);
        expect(engine.createdTweens.every((t) => !t.killed)).toBe(true);

        const triggersCreated = engine.createdTriggers.length;
        const tweensCreated = engine.createdTweens.length;

        // --- Unmount: effect cleanup must kill exactly what it created.
        await act(async () => {
          root.unmount();
        });
        container.remove();

        // EVERY created ScrollTrigger instance was killed (no leaks)...
        const triggersKilled = engine.createdTriggers.filter((t) => t.killed).length;
        expect(triggersKilled).toBe(triggersCreated);
        expect(engine.createdTriggers.every((t) => t.killed && t.killCount >= 1)).toBe(true);

        // ...and every created tween was killed too.
        const tweensKilled = engine.createdTweens.filter((t) => t.killed).length;
        expect(tweensKilled).toBe(tweensCreated);
        expect(engine.createdTweens.every((t) => t.killed && t.killCount >= 1)).toBe(true);

        // Cleanup happened via per-instance kill(), NOT a global killAll
        // (design note for 19.8: kill exactly those, not ScrollTrigger.killAll()).
        expect(engine.killAllCalls).toBe(0);
      }),
    );
  });
});
