// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  CanvasRenderer,
  MAX_LETTER_ROTATION_RAD,
  type CanvasContextLike,
  type CanvasImageSourceLike,
  type RenderBuffer,
  type RenderState,
  type TextMetricsLike,
} from './Renderer.ts';
import type { RenderOptions } from '@glitch/core';

/**
 * Static-audit tests for the Renderer's handmade art direction (task 9.4).
 *
 * These are 1-3 representative-case audits (NOT property tests) of the four
 * art-direction rendering paths:
 *   - paper-grain + scan-line textures pre-rendered ONCE and stamped per frame
 *     (Requirements 12.2, 12.4),
 *   - ransom-note cut-out glyphs with bounded per-letter rotation/placement
 *     variation (Requirement 12.1),
 *   - neo-brutalist container borders with a thick, high-contrast stroke
 *     (Requirement 12.5).
 *
 * They drive the Renderer through a RECORDING fake `CanvasContextLike` (jsdom's
 * real `getContext('2d')` returns null), replicating the approach in
 * `Renderer.test.ts`. The fake is extended to snapshot the relevant style props
 * (lineWidth/strokeStyle/fillStyle/...) AT CALL TIME so the neo-brutalist border
 * audit can capture the lineWidth/strokeStyle that were set just before each
 * `strokeRect`.
 */

// ---- Recording fake context (with per-call style snapshot) ----------------

/** Snapshot of the mutable style props at the moment a draw call is recorded. */
interface StyleSnapshot {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  globalAlpha: number;
}

interface Call {
  name: string;
  args: unknown[];
  /** Style props captured at the instant this call was made. */
  style: StyleSnapshot;
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
    this.calls.push({
      name,
      args,
      style: {
        fillStyle: this.fillStyle,
        strokeStyle: this.strokeStyle,
        lineWidth: this.lineWidth,
        font: this.font,
        globalAlpha: this.globalAlpha,
      },
    });
  }
  count(name: string): number {
    return this.calls.filter((c) => c.name === name).length;
  }
  callsNamed(name: string): Call[] {
    return this.calls.filter((c) => c.name === name);
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

/** A fake off-screen buffer whose ctx is its own recording context. */
function makeBuffer(width: number, height: number): RenderBuffer {
  const ctx = new RecordingContext();
  return { width, height, ctx, image: { tag: 'buffer', width, height } };
}

const CANVAS_W = 800;
const CANVAS_H = 600;

/**
 * Build a renderer wired to recording fakes and expose:
 *  - `ctx`        : the MAIN drawing context (where stamps/glyphs/borders land),
 *  - `grainCtx`   : the paper-grain off-screen buffer's own recording context,
 *  - `scanlineCtx`: the scan-line off-screen buffer's own recording context.
 *
 * `init()` creates the grain buffer first, then the scan-line buffer (see
 * `CanvasRenderer.init`), so the captured `buffers` array is ordered
 * [grain, scanline].
 */
function makeRenderer(opts?: Partial<RenderOptions>) {
  const ctx = new RecordingContext();
  const buffers: RenderBuffer[] = [];
  const renderer = new CanvasRenderer({
    createContext: () => ctx,
    createBuffer: (w, h) => {
      const b = makeBuffer(w, h);
      buffers.push(b);
      return b;
    },
    random: () => 0.5, // deterministic one-time texture generation
  });
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const renderOpts: RenderOptions = {
    reduceMotion: opts?.reduceMotion ?? false,
    offGridMaxOffsetPx: opts?.offGridMaxOffsetPx ?? 6,
  };
  renderer.init(canvas, renderOpts);
  return {
    renderer,
    ctx,
    grainCtx: buffers[0]!.ctx as RecordingContext,
    scanlineCtx: buffers[1]!.ctx as RecordingContext,
    buffers,
  };
}

const BOUNDS = { x: 0, y: 0, width: CANVAS_W, height: CANVAS_H };

function stateWithLetters(): RenderState {
  return {
    bounds: BOUNDS,
    letters: [
      {
        id: 'L0',
        glyph: 'hello',
        current: [
          { x: 100, y: 100 },
          { x: 140, y: 100 },
        ],
        previous: [
          { x: 90, y: 80 },
          { x: 130, y: 80 },
        ],
        spawnJitterSeed: 12345,
      },
      {
        id: 'L1',
        glyph: 'world',
        current: [
          { x: 300, y: 200 },
          { x: 340, y: 200 },
        ],
        spawnJitterSeed: 67890,
      },
    ],
    containers: [{ id: 'answer-row', rect: { x: 50, y: 500, width: 700, height: 60 } }],
  };
}

// Renderer palette literals (NOT exported from Renderer.ts; referenced here for
// representative high-contrast audits only).
const RENDERER_PAPER_BASE_COLOR = '#f4efe1';
const RENDERER_INK_COLOR = '#141210';
// NEO_BORDER_WIDTH_PX in Renderer.ts is 4 and is NOT exported; we assert against
// this thick threshold to avoid coupling the test to the source constant.
const THICK_BORDER_THRESHOLD_PX = 4;

// ---- 12.2 / 12.4: paper-grain + scan-lines pre-rendered once, stamped -------

describe('art direction: paper-grain + scan-lines (Requirements 12.2, 12.4)', () => {
  it('pre-renders both textures into off-screen buffers at init (base fill + specks; evenly-spaced lines)', () => {
    const { grainCtx, scanlineCtx } = makeRenderer();

    // Paper grain = a full-buffer base paper fill plus many ink specks.
    const grainFills = grainCtx.callsNamed('fillRect');
    expect(grainFills.length).toBeGreaterThan(100); // base + many specks
    expect(grainFills[0]!.args).toEqual([0, 0, CANVAS_W, CANVAS_H]); // base fill covers the buffer

    // Scan-lines = one clear plus evenly-spaced horizontal lines.
    expect(scanlineCtx.count('clearRect')).toBe(1);
    const scanFills = scanlineCtx.callsNamed('fillRect');
    expect(scanFills.length).toBeGreaterThan(1);
    const ys = scanFills.map((c) => c.args[1] as number);
    const spacing = ys[1]! - ys[0]!;
    expect(spacing).toBeGreaterThan(0);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]! - ys[i - 1]!).toBe(spacing); // uniform vertical spacing
    }
  });

  it('stamps both pre-rendered textures via exactly two drawImage calls per frame on the main context', () => {
    const { renderer, ctx } = makeRenderer();
    renderer.draw(stateWithLetters(), 0.5, null);
    // Two stamps: paper grain + scan-lines (Requirements 12.2, 12.4).
    expect(ctx.count('drawImage')).toBe(2);
    renderer.dispose();
  });

  it('pre-renders textures ONCE: drawing N frames repaints no buffer, only the main stamp count grows (12.4)', () => {
    const { renderer, ctx, grainCtx, scanlineCtx } = makeRenderer();

    // Buffer-painting counts captured right after the one-time init paint.
    const grainFillsAtInit = grainCtx.count('fillRect');
    const scanFillsAtInit = scanlineCtx.count('fillRect');
    const scanClearsAtInit = scanlineCtx.count('clearRect');

    const N = 5;
    for (let i = 0; i < N; i++) renderer.draw(stateWithLetters(), 0.5, null);

    // The buffers were NOT repainted across draw frames (pre-render once).
    expect(grainCtx.count('fillRect')).toBe(grainFillsAtInit);
    expect(scanlineCtx.count('fillRect')).toBe(scanFillsAtInit);
    expect(scanlineCtx.count('clearRect')).toBe(scanClearsAtInit);

    // Only the MAIN context's stamp count grew: 2 drawImage per frame (stamp per frame).
    expect(ctx.count('drawImage')).toBe(2 * N);
    renderer.dispose();
  });
});

// ---- 12.1: ransom-note cut-out glyphs ---------------------------------------

describe('art direction: ransom-note cut-out glyphs (Requirement 12.1)', () => {
  it('draws each letter as a cut-out: K glyphs wrapped by save/translate/rotate/restore, plus a box + border each', () => {
    const { renderer, ctx } = makeRenderer();
    const state = stateWithLetters();
    const K = state.letters.length;
    renderer.draw(state, 0.5, null);

    // One glyph + one rotate (the per-letter variation) per letter.
    expect(ctx.count('fillText')).toBe(K);
    expect(ctx.count('rotate')).toBe(K);
    // Each glyph is wrapped in save/translate/.../restore.
    expect(ctx.count('save')).toBeGreaterThanOrEqual(K);
    expect(ctx.count('translate')).toBeGreaterThanOrEqual(K);
    expect(ctx.count('restore')).toBeGreaterThanOrEqual(K);

    // Cut-out box (fillRect) per letter. Background grain is stamped via
    // drawImage (not fillRect) and audio is null, so the only main-context
    // fillRects are the K cut-out boxes.
    expect(ctx.count('fillRect')).toBe(K);
    // Border (strokeRect) per letter, plus one per neo-brutalist container.
    expect(ctx.count('strokeRect')).toBe(K + state.containers!.length);

    // The drawn glyph texts equal the letters' glyphs in order.
    const texts = ctx.callsNamed('fillText').map((c) => c.args[0]);
    expect(texts).toEqual(state.letters.map((l) => l.glyph));
    renderer.dispose();
  });

  it('applies bounded per-letter rotation variation (|rotation| <= MAX_LETTER_ROTATION_RAD), distinct per letter', () => {
    const { renderer, ctx } = makeRenderer();
    const state = stateWithLetters();
    renderer.draw(state, 0.5, null);

    const rotations = ctx.callsNamed('rotate').map((c) => c.args[0] as number);
    expect(rotations.length).toBe(state.letters.length);
    for (const r of rotations) {
      expect(Math.abs(r)).toBeLessThanOrEqual(MAX_LETTER_ROTATION_RAD); // bounded ransom-note tilt
    }
    // Distinct seeds -> distinct rotations: the per-letter variation is applied.
    expect(rotations[0]).not.toBe(rotations[1]);
    renderer.dispose();
  });
});

// ---- 12.5: neo-brutalist container borders ----------------------------------

describe('art direction: neo-brutalist container borders (Requirement 12.5)', () => {
  it('outlines each container with a THICK, high-contrast ink stroke distinct from the paper base', () => {
    const { renderer, ctx } = makeRenderer();
    const state = stateWithLetters();
    renderer.draw(state, 0.5, null);

    // Capture the lineWidth/strokeStyle that were set at each strokeRect call.
    const thickStrokes = ctx
      .callsNamed('strokeRect')
      .filter((c) => c.style.lineWidth >= THICK_BORDER_THRESHOLD_PX);
    // One thick border per container (NEO_BORDER_WIDTH_PX = 4 in Renderer.ts).
    expect(thickStrokes.length).toBe(state.containers!.length);

    const border = thickStrokes[0]!;
    expect(border.style.lineWidth).toBeGreaterThanOrEqual(THICK_BORDER_THRESHOLD_PX);
    // High-contrast treatment: a non-empty ink color string, distinct from the paper base.
    expect(typeof border.style.strokeStyle).toBe('string');
    expect(border.style.strokeStyle.length).toBeGreaterThan(0);
    expect(border.style.strokeStyle).not.toBe(RENDERER_PAPER_BASE_COLOR);
    // Representative: it is the renderer's dark ink color (captured at stroke time).
    expect(border.style.strokeStyle).toBe(RENDERER_INK_COLOR);
    renderer.dispose();
  });

  it('letter cut-out borders use a thinner lineWidth than the container border', () => {
    const { renderer, ctx } = makeRenderer();
    const state = stateWithLetters();
    renderer.draw(state, 0.5, null);

    const thinStrokes = ctx
      .callsNamed('strokeRect')
      .filter((c) => c.style.lineWidth < THICK_BORDER_THRESHOLD_PX);
    // One thin cut-out border per letter; the thick border is reserved for containers.
    expect(thinStrokes.length).toBe(state.letters.length);
    renderer.dispose();
  });
});
