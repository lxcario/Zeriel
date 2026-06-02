import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { ParticleSnapshot, Vec2 } from '@glitch/core';
import {
  snapshotInterpolationAlpha,
  interpolateLetterParticles,
} from './snapshotInterpolation.ts';

/**
 * Unit + property tests for the pure non-owned-letter snapshot interpolation
 * math (task 17.6). These cover the two helpers the {@link RemoteGameHost} uses
 * to drive non-owned letters purely from authoritative snapshots
 * (Requirement 14.5/16.2), with no socket, GameCore, or render loop.
 */

function particle(x: number, y: number): ParticleSnapshot {
  return { x: { x, y }, prev: { x, y } };
}

describe('snapshotInterpolationAlpha (task 17.6)', () => {
  it('is 0 at the current snapshot arrival and 1 one interval later', () => {
    // prev arrived at 100, curr at 200 → interval 100ms.
    expect(snapshotInterpolationAlpha(100, 200, 200)).toBe(0);
    expect(snapshotInterpolationAlpha(100, 200, 250)).toBeCloseTo(0.5, 10);
    expect(snapshotInterpolationAlpha(100, 200, 300)).toBe(1);
  });

  it('clamps to 1 when the next snapshot is late (no extrapolation past current)', () => {
    expect(snapshotInterpolationAlpha(100, 200, 999)).toBe(1);
  });

  it('clamps to 0 before the current snapshot arrival', () => {
    expect(snapshotInterpolationAlpha(100, 200, 150)).toBe(0);
  });

  it('returns 1 for a non-positive interval or non-finite times (snap to current)', () => {
    expect(snapshotInterpolationAlpha(200, 200, 200)).toBe(1); // zero interval
    expect(snapshotInterpolationAlpha(300, 200, 250)).toBe(1); // negative interval
    expect(snapshotInterpolationAlpha(Number.NaN, 200, 250)).toBe(1);
    expect(snapshotInterpolationAlpha(100, 200, Number.NaN)).toBe(1);
  });

  it('property: result is always in [0, 1] and monotonic non-decreasing in now', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1e6, noNaN: true }),
        fc.double({ min: 1, max: 1e6, noNaN: true }),
        fc.double({ min: 0, max: 2e6, noNaN: true }),
        fc.double({ min: 0, max: 2e6, noNaN: true }),
        (prevArrival, gap, dNow1, dNow2) => {
          const currArrival = prevArrival + gap;
          const now1 = currArrival + Math.min(dNow1, dNow2);
          const now2 = currArrival + Math.max(dNow1, dNow2);
          const a1 = snapshotInterpolationAlpha(prevArrival, currArrival, now1);
          const a2 = snapshotInterpolationAlpha(prevArrival, currArrival, now2);
          expect(a1).toBeGreaterThanOrEqual(0);
          expect(a1).toBeLessThanOrEqual(1);
          expect(a2).toBeGreaterThanOrEqual(0);
          expect(a2).toBeLessThanOrEqual(1);
          // Later wall-clock never moves the interpolation factor backward.
          expect(a2).toBeGreaterThanOrEqual(a1 - 1e-9);
        },
      ),
    );
  });
});

describe('interpolateLetterParticles (task 17.6)', () => {
  it('lerps each particle between prev and curr by alpha', () => {
    const prev = [particle(0, 0), particle(10, 20)];
    const curr = [particle(10, 0), particle(30, 60)];
    const out: Vec2[] = [];
    interpolateLetterParticles(prev, curr, 0.5, out);
    expect(out).toEqual([
      { x: 5, y: 0 },
      { x: 20, y: 40 },
    ]);
  });

  it('copies curr when there is no prev (a freshly-appeared letter)', () => {
    const curr = [particle(7, 8)];
    const out: Vec2[] = [];
    interpolateLetterParticles(undefined, curr, 0.3, out);
    expect(out).toEqual([{ x: 7, y: 8 }]);
  });

  it('copies prev when curr is missing (a just-removed letter)', () => {
    const prev = [particle(7, 8)];
    const out: Vec2[] = [];
    interpolateLetterParticles(prev, undefined, 0.3, out);
    expect(out).toEqual([{ x: 7, y: 8 }]);
  });

  it('empties out when neither prev nor curr is present', () => {
    const out: Vec2[] = [{ x: 1, y: 2 }];
    interpolateLetterParticles(undefined, undefined, 0.5, out);
    expect(out).toEqual([]);
  });

  it('reuses the same out array instance across calls (no per-frame allocation)', () => {
    const out: Vec2[] = [];
    const first = interpolateLetterParticles([particle(0, 0)], [particle(4, 4)], 0.25, out);
    const second = interpolateLetterParticles([particle(0, 0)], [particle(8, 8)], 0.5, out);
    expect(first).toBe(out);
    expect(second).toBe(out);
    expect(out).toEqual([{ x: 4, y: 4 }]);
  });

  it('handles a benign particle-count mismatch by using the shorter length', () => {
    const prev = [particle(0, 0)];
    const curr = [particle(10, 10), particle(99, 99)];
    const out: Vec2[] = [];
    expect(() => interpolateLetterParticles(prev, curr, 1, out)).not.toThrow();
    expect(out).toEqual([{ x: 10, y: 10 }]);
  });

  it('property: at alpha 0 it equals prev and at alpha 1 it equals curr', () => {
    const pt = (): fc.Arbitrary<ParticleSnapshot> =>
      fc
        .record({
          x: fc.double({ min: -1e4, max: 1e4, noNaN: true }),
          y: fc.double({ min: -1e4, max: 1e4, noNaN: true }),
        })
        .map(({ x, y }) => particle(x, y));

    fc.assert(
      fc.property(fc.array(pt(), { minLength: 1, maxLength: 4 }), fc.array(pt(), { minLength: 1, maxLength: 4 }), (prev, curr) => {
        const n = Math.min(prev.length, curr.length);
        const out: Vec2[] = [];

        interpolateLetterParticles(prev, curr, 0, out);
        for (let i = 0; i < n; i++) {
          expect(out[i]!.x).toBeCloseTo(prev[i]!.x.x, 9);
          expect(out[i]!.y).toBeCloseTo(prev[i]!.x.y, 9);
        }

        interpolateLetterParticles(prev, curr, 1, out);
        for (let i = 0; i < n; i++) {
          expect(out[i]!.x).toBeCloseTo(curr[i]!.x.x, 9);
          expect(out[i]!.y).toBeCloseTo(curr[i]!.x.y, 9);
        }
      }),
    );
  });
});
