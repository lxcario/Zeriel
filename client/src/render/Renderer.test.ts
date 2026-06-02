// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  CanvasRenderer,
  letterVariation,
  offGridOffset,
  MAX_LETTER_ROTATION_RAD,
  MAX_LETTER_VARIATION_PX,
  type CanvasContextLike,
  type CanvasImageSourceLike,
  type RenderBuffer,
  type RenderState,
  type TextMetricsLike,
} from './Renderer.ts';
import type { RenderOptions } from '@glitch/core';
import type { AudioFrame } from '../audio/AudioPlayer.ts';

/**
 * Smoke tests for the Renderer (task 9.1) using a RECORDING fake context — no
 * real GPU canvas (jsdom's `getContext('2d')` returns null). The optional
 * property tests (9.2 bounded off-grid, 9.3 reduce-motion suppression) and the
 * static-audit test (9.4) are separate tasks.
 */

// ---- Recording fake context ----------------------------------------------

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
  count(name: string): number {
    return this.calls.filter((c) => c.name === name).length;
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

function makeRenderer(ctx: RecordingContext, opts?: Partial<RenderOptions>) {
  const renderer = new CanvasRenderer({
    createContext: () => ctx,
    createBuffer: (w, h) => makeBuffer(w, h),
    random: () => 0.5, // deterministic texture generation
  });
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  const renderOpts: RenderOptions = {
    reduceMotion: opts?.reduceMotion ?? false,
    offGridMaxOffsetPx: opts?.offGridMaxOffsetPx ?? 6,
  };
  renderer.init(canvas, renderOpts);
  return { renderer, canvas };
}

const BOUNDS = { x: 0, y: 0, width: 800, height: 600 };

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

function makeAudioFrame(): AudioFrame {
  const bins = new Float32Array(16);
  bins.fill(0.5);
  return { amplitude: 0.7, frequencyBins: bins };
}

// ---- Pure helpers ---------------------------------------------------------

describe('offGridOffset (pure, bounded)', () => {
  it('keeps both axes within +/- maxPx for assorted seeds', () => {
    const max = 7;
    for (const seed of [0, 1, 42, 999, 2 ** 31, 4294967295]) {
      const { dx, dy } = offGridOffset(seed, max);
      expect(Math.abs(dx)).toBeLessThanOrEqual(max);
      expect(Math.abs(dy)).toBeLessThanOrEqual(max);
    }
  });

  it('is deterministic in the seed (stable across calls)', () => {
    expect(offGridOffset(123, 10)).toEqual(offGridOffset(123, 10));
  });

  it('degrades to {0,0} for non-finite maxPx', () => {
    expect(offGridOffset(123, Number.NaN)).toEqual({ dx: 0, dy: 0 });
    expect(offGridOffset(123, Number.POSITIVE_INFINITY)).toEqual({ dx: 0, dy: 0 });
  });
});

describe('letterVariation (pure, bounded + deterministic)', () => {
  it('bounds rotation and placement variation', () => {
    for (const seed of [0, 7, 555, 4294967295]) {
      const v = letterVariation(seed);
      expect(Math.abs(v.rotation)).toBeLessThanOrEqual(MAX_LETTER_ROTATION_RAD);
      expect(Math.abs(v.dx)).toBeLessThanOrEqual(MAX_LETTER_VARIATION_PX);
      expect(Math.abs(v.dy)).toBeLessThanOrEqual(MAX_LETTER_VARIATION_PX);
    }
  });

  it('is deterministic in the seed', () => {
    expect(letterVariation(42)).toEqual(letterVariation(42));
  });
});

// ---- CanvasRenderer --------------------------------------------------------

describe('CanvasRenderer', () => {
  it('init + draw does not throw and stamps both pre-rendered textures', () => {
    const ctx = new RecordingContext();
    const { renderer } = makeRenderer(ctx);
    expect(() => renderer.draw(stateWithLetters(), 0.5, null)).not.toThrow();
    // Two drawImage stamps: paper grain + scan-lines (Requirements 12.2, 12.4).
    expect(ctx.count('drawImage')).toBe(2);
    renderer.dispose();
  });

  it('clears the canvas once per frame', () => {
    const ctx = new RecordingContext();
    const { renderer } = makeRenderer(ctx);
    renderer.draw(stateWithLetters(), 0.5, null);
    expect(ctx.count('clearRect')).toBe(1);
    renderer.dispose();
  });

  it('draws one ransom-note glyph (rotate + fillText) per letter', () => {
    const ctx = new RecordingContext();
    const { renderer } = makeRenderer(ctx);
    renderer.draw(stateWithLetters(), 0.5, null);
    expect(ctx.count('fillText')).toBe(2);
    expect(ctx.count('rotate')).toBe(2);
    const texts = ctx.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]);
    expect(texts).toEqual(['hello', 'world']);
    renderer.dispose();
  });

  it('outlines neo-brutalist containers with a thick border (Requirement 12.5)', () => {
    const ctx = new RecordingContext();
    const { renderer } = makeRenderer(ctx);
    renderer.draw(stateWithLetters(), 0.5, null);
    // Container strokeRect uses a thick line width; capture the lineWidth set.
    const hasThickStroke = ctx.calls.some((c) => c.name === 'strokeRect');
    expect(hasThickStroke).toBe(true);
    renderer.dispose();
  });

  it('skips audio-reactive draw calls when the AudioFrame is null (Requirement 5.3)', () => {
    const ctxNull = new RecordingContext();
    const { renderer: rNull } = makeRenderer(ctxNull);
    rNull.draw(stateWithLetters(), 0.5, null);
    const fillRectNull = ctxNull.count('fillRect');
    rNull.dispose();

    const ctxAudio = new RecordingContext();
    const { renderer: rAudio } = makeRenderer(ctxAudio);
    rAudio.draw(stateWithLetters(), 0.5, makeAudioFrame());
    const fillRectAudio = ctxAudio.count('fillRect');
    rAudio.dispose();

    // The audio frame adds the reactive accent bars (extra fillRects).
    expect(fillRectAudio).toBeGreaterThan(fillRectNull);
  });

  it('reduce-motion suppresses scan-line jitter: scan-line stamp sits at y=0', () => {
    const ctx = new RecordingContext();
    const { renderer } = makeRenderer(ctx, { reduceMotion: true });
    // Draw several frames; under reduce-motion the scan-line drawImage dy is 0.
    for (let i = 0; i < 5; i++) renderer.draw(stateWithLetters(), 0.5, null);
    const scanStamps = ctx.calls.filter(
      (c) => c.name === 'drawImage' && (c.args[2] as number) !== 0,
    );
    // No jittered scan-line stamp (all stamps at dy === 0).
    expect(scanStamps.length).toBe(0);
    renderer.dispose();
  });

  it('without reduce-motion the scan-line stamp jitters off y=0 on some frame', () => {
    const ctx = new RecordingContext();
    const { renderer } = makeRenderer(ctx, { reduceMotion: false });
    for (let i = 0; i < 20; i++) renderer.draw(stateWithLetters(), 0.5, null);
    const jittered = ctx.calls.some(
      (c) => c.name === 'drawImage' && (c.args[2] as number) !== 0,
    );
    expect(jittered).toBe(true);
    renderer.dispose();
  });

  it('preserves gameplay motion under reduce-motion (letters still drawn at physics positions)', () => {
    const ctx = new RecordingContext();
    const { renderer } = makeRenderer(ctx, { reduceMotion: true });
    renderer.draw(stateWithLetters(), 0.5, null);
    // Letters are still translated to their interpolated centroids and drawn.
    expect(ctx.count('translate')).toBe(2);
    expect(ctx.count('fillText')).toBe(2);
    renderer.dispose();
  });

  it('is import/draw-safe when no context is available (jsdom default null ctx)', () => {
    const renderer = new CanvasRenderer({
      createContext: () => null,
      createBuffer: () => null,
    });
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    expect(() => renderer.init(canvas, { reduceMotion: false, offGridMaxOffsetPx: 4 })).not.toThrow();
    expect(() => renderer.draw(stateWithLetters(), 0.5, null)).not.toThrow();
    renderer.dispose();
  });

  it('throws when drawn after dispose', () => {
    const ctx = new RecordingContext();
    const { renderer } = makeRenderer(ctx);
    renderer.dispose();
    expect(() => renderer.draw(stateWithLetters(), 0.5, null)).toThrow(/after dispose/);
  });
});
