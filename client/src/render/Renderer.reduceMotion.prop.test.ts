// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  CanvasRenderer,
  letterVariation,
  offGridOffset,
  type CanvasContextLike,
  type CanvasImageSourceLike,
  type RenderBuffer,
  type RenderState,
  type LetterView,
  type TextMetricsLike,
} from './Renderer.ts';
import type { RenderOptions, Vec2 } from '@glitch/core';

/**
 * Property-based test for reduce-motion decoration suppression (task 9.3).
 *
 * Feature: glitch-karaoke, Property 35: Reduce-motion suppresses decoration but
 * preserves gameplay — *For any* render frame with Reduce_Motion_Mode enabled,
 * all decorative motion parameters (scan-line jitter, decorative shake) are
 * zero, while core gameplay physics still advances Rope_Letter positions across
 * ticks.
 *
 * **Validates: Requirements 13.1**
 *
 * Requirement 13.1: WHERE Reduce_Motion_Mode is enabled, THE Renderer SHALL
 * suppress non-essential motion effects, including scan-line jitter and
 * decorative shake, while preserving core gameplay motion.
 *
 * ## Recording-fake approach (replicated from Renderer.test.ts)
 *
 * jsdom's `canvas.getContext('2d')` returns `null`, so the Renderer's web deps
 * are injected: `createContext` returns a {@link RecordingContext} (a lightweight
 * fake that records every draw call + its args), and `createBuffer` returns a
 * fake off-screen {@link RenderBuffer}. The Renderer STAMPS the pre-rendered
 * paper-grain and scan-line textures onto the MAIN context via `drawImage`, and
 * TRANSLATES to each letter's draw origin via `translate`, so reading the
 * recorded `drawImage`/`translate` calls lets us observe both the decorative
 * scan-line jitter (the stamp's `dy`) and the exact per-letter draw position.
 *
 * ## Separating decorative shake from gameplay motion
 *
 * The implementation draws each letter at:
 *   translate( centroid + letterVariation + offGridOffset + shake )
 * where:
 *   - `centroid`      = the alpha-interpolated physics position (GAMEPLAY motion),
 *   - `letterVariation`/`offGridOffset` = deterministic, frame-stable functions
 *     of the letter's `spawnJitterSeed` (handmade look, NOT per-frame motion),
 *   - `shake`         = a per-frame DECORATIVE nudge, identical on x and y, that
 *     is `0` under reduce-motion and `(hashUnit(frame)*2-1) * 1.5` otherwise.
 * The scan-line texture is stamped at `drawImage(img, 0, jitterY)` where
 * `jitterY` is `0` under reduce-motion and a per-frame `±1.5` jitter otherwise.
 *
 * So the gameplay component (`centroid + letterVariation + offGridOffset`) is
 * computed independently here from the exact same exported helpers, and:
 *   - Under reduce-motion the recorded letter translate must EQUAL that gameplay
 *     component exactly (shake suppressed) and the scan-line `dy` must be `0`.
 *   - The ONLY difference between motion-on and motion-off is a bounded,
 *     axis-uniform decorative shake `|shake| <= 1.5`; the gameplay centroid is
 *     identical in both modes.
 *
 * Two FRESH renderers (one reduce-motion, one not) are created per run so their
 * monotonic frame counters advance in lockstep, and the SAME state + alpha is
 * drawn across many frames on each. numRuns is the global default (100).
 */

// ---- Recording fake context (replicated from Renderer.test.ts) ------------

interface Call {
  name: string;
  args: unknown[];
}

class RecordingContext implements CanvasContextLike {
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  font = '';
  globalAlpha = 1;
  textAlign = '';
  textBaseline = '';
  calls: Call[] = [];

  private rec(name: string, ...args: unknown[]): void {
    this.calls.push({ name, args });
  }
  save(): void {
    this.rec('save');
  }
  restore(): void {
    this.rec('restore');
  }
  translate(x: number, y: number): void {
    this.rec('translate', x, y);
  }
  rotate(angle: number): void {
    this.rec('rotate', angle);
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.rec('setTransform', a, b, c, d, e, f);
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this.rec('clearRect', x, y, w, h);
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.rec('fillRect', x, y, w, h);
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    this.rec('strokeRect', x, y, w, h);
  }
  fillText(text: string, x: number, y: number): void {
    this.rec('fillText', text, x, y);
  }
  measureText(text: string): TextMetricsLike {
    this.rec('measureText', text);
    return { width: text.length * 8 };
  }
  drawImage(image: CanvasImageSourceLike, dx: number, dy: number): void {
    this.rec('drawImage', image, dx, dy);
  }
}

/** A fake off-screen buffer whose ctx is a separate recording context. */
function makeBuffer(width: number, height: number): RenderBuffer {
  const ctx = new RecordingContext();
  return { width, height, ctx, image: { tag: 'buffer', width, height } };
}

const BOUNDS = { x: 0, y: 0, width: 800, height: 600 } as const;

/**
 * Build a fresh renderer wired to its own recording main context. The fake
 * `createContext` always returns `ctx`; `init` calls it once.
 */
function makeRenderer(reduceMotion: boolean, offGridMaxOffsetPx: number) {
  const ctx = new RecordingContext();
  const renderer = new CanvasRenderer({
    createContext: () => ctx,
    createBuffer: (w, h) => makeBuffer(w, h),
    random: () => 0.5, // deterministic one-time texture generation
  });
  const canvas = document.createElement('canvas');
  canvas.width = BOUNDS.width;
  canvas.height = BOUNDS.height;
  const opts: RenderOptions = { reduceMotion, offGridMaxOffsetPx };
  renderer.init(canvas, opts);
  return { renderer, ctx };
}

// ---- Pure replication of the GAMEPLAY draw position -----------------------
// (interpolated centroid + deterministic letterVariation + offGridOffset);
// the decorative per-frame `shake` is deliberately excluded.

/**
 * Replicates {@link CanvasRenderer}'s private `interpolatedCentroid`: lerp each
 * particle by `alpha` when `previous` is aligned with `current`, else average
 * `current`. Same arithmetic + accumulation order as the implementation so the
 * result is bit-identical.
 */
function interpolatedCentroid(letter: LetterView, alpha: number): Vec2 {
  const cur = letter.current;
  const prev = letter.previous;
  const n = cur.length;
  if (n === 0) return { x: 0, y: 0 };
  const canInterpolate = prev !== undefined && prev.length === n;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    const c = cur[i]!;
    if (canInterpolate) {
      const p = prev![i]!;
      sumX += p.x + (c.x - p.x) * alpha;
      sumY += p.y + (c.y - p.y) * alpha;
    } else {
      sumX += c.x;
      sumY += c.y;
    }
  }
  return { x: sumX / n, y: sumY / n };
}

/** The gameplay draw position: centroid + variation + off-grid (NO shake). */
function gameplayDrawPos(letter: LetterView, alpha: number, maxOffset: number): Vec2 {
  const center = interpolatedCentroid(letter, alpha);
  const variation = letterVariation(letter.spawnJitterSeed);
  const offGrid = offGridOffset(letter.spawnJitterSeed, maxOffset);
  return { x: center.x + variation.dx + offGrid.dx, y: center.y + variation.dy + offGrid.dy };
}

/** Per-frame decorative shake amplitude in the impl (private constant). */
const DECORATIVE_SHAKE_PX = 1.5;
/** Number of frames drawn per run; modest to bound work under jsdom. */
const FRAMES = 24;
/** Float tolerance: positions are reproduced from identical helpers/order. */
const EPS = 1e-6;

function approxEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= EPS * (1 + Math.abs(a) + Math.abs(b));
}

// ---- Generators -----------------------------------------------------------

const vec2Arb: fc.Arbitrary<Vec2> = fc.record({
  x: fc.double({ min: -2000, max: 2000, noNaN: true }),
  y: fc.double({ min: -2000, max: 2000, noNaN: true }),
});

/** A letter with bounded finite current/previous (aligned length) + seed. */
const letterArb: fc.Arbitrary<LetterView> = fc.integer({ min: 1, max: 4 }).chain((n) =>
  fc.record({
    id: fc.string(),
    glyph: fc.string({ minLength: 1, maxLength: 5 }),
    current: fc.array(vec2Arb, { minLength: n, maxLength: n }),
    // Sometimes omit `previous` (no interpolation), sometimes provide an aligned
    // one (interpolation path) — both exercise the same gameplay invariant.
    previous: fc.option(fc.array(vec2Arb, { minLength: n, maxLength: n }), { nil: undefined }),
    spawnJitterSeed: fc.integer(),
  }),
);

const stateArb: fc.Arbitrary<RenderState> = fc.record({
  bounds: fc.constant(BOUNDS),
  letters: fc.array(letterArb, { minLength: 1, maxLength: 6 }),
});

const alphaArb = fc.double({ min: 0, max: 1, noNaN: true });
const maxOffsetArb = fc.double({ min: 0, max: 20, noNaN: true });

// ---- Property -------------------------------------------------------------

describe('CanvasRenderer reduce-motion (Property 35: suppresses decoration, preserves gameplay, 13.1)', () => {
  it('suppresses scan-line jitter + decorative shake under reduce-motion while preserving gameplay positions', () => {
    fc.assert(
      fc.property(stateArb, alphaArb, maxOffsetArb, (state, alpha, maxOffset) => {
        const off = makeRenderer(true, maxOffset); // Reduce_Motion_Mode ON
        const on = makeRenderer(false, maxOffset); // Reduce_Motion_Mode OFF

        // Same state + alpha across many frames; fresh renderers => lockstep frames.
        for (let f = 0; f < FRAMES; f++) {
          off.renderer.draw(state, alpha, null);
          on.renderer.draw(state, alpha, null);
        }

        // (1) DECORATION SUPPRESSED: under reduce-motion, NO texture stamp jitters
        // off dy=0 — every drawImage (paper grain + scan-line) sits at dy === 0.
        const offJittered = off.ctx.calls.filter(
          (c) => c.name === 'drawImage' && (c.args[2] as number) !== 0,
        );
        expect(offJittered.length).toBe(0);

        // (2) DECORATION PRESENT: with motion allowed, the scan-line stamp jitters
        // off dy=0 on at least one frame (per-frame deterministic ±1.5 jitter).
        const onJittered = on.ctx.calls.some(
          (c) => c.name === 'drawImage' && (c.args[2] as number) !== 0,
        );
        expect(onJittered).toBe(true);

        // (3) GAMEPLAY PRESERVED: per-letter translate args, frame-major order.
        // Only `drawLetter` calls `translate`, exactly once per letter.
        const offT = off.ctx.calls.filter((c) => c.name === 'translate');
        const onT = on.ctx.calls.filter((c) => c.name === 'translate');
        const n = state.letters.length;
        expect(offT.length).toBe(FRAMES * n);
        expect(onT.length).toBe(FRAMES * n);

        for (let f = 0; f < FRAMES; f++) {
          for (let i = 0; i < n; i++) {
            const idx = f * n + i;
            const letter = state.letters[i]!;
            const g = gameplayDrawPos(letter, alpha, maxOffset);

            const rx = offT[idx]!.args[0] as number;
            const ry = offT[idx]!.args[1] as number;
            const ox = onT[idx]!.args[0] as number;
            const oy = onT[idx]!.args[1] as number;

            // Under reduce-motion the letter sits at the PURE gameplay position
            // (interpolated centroid + deterministic variation + off-grid), with
            // NO decorative shake added.
            expect(approxEqual(rx, g.x)).toBe(true);
            expect(approxEqual(ry, g.y)).toBe(true);

            // The motion-on letter differs from the gameplay position ONLY by a
            // bounded decorative shake that is uniform across x and y.
            const shakeX = ox - g.x;
            const shakeY = oy - g.y;
            expect(approxEqual(shakeX, shakeY)).toBe(true);
            expect(Math.abs(shakeX)).toBeLessThanOrEqual(DECORATIVE_SHAKE_PX + EPS);

            // KEY INVARIANT: the gameplay centroid component is identical in both
            // modes — removing the shake from motion-on recovers the reduce-motion
            // (pure gameplay) position.
            expect(approxEqual(ox - shakeX, rx)).toBe(true);
            expect(approxEqual(oy - shakeY, ry)).toBe(true);
          }
        }

        off.renderer.dispose();
        on.renderer.dispose();
      }),
    );
  });
});
