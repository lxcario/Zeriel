import { describe, it, expect } from 'vitest';
import type { Particle, RopeLetter, Rect } from '../types/index.js';
import { resolveBounds, resolveOverlap } from './index.js';

/** Build a free (movable) particle at (x, y) with the given prev (implicit velocity). */
function particle(x: number, y: number, prevX = x, prevY = y, invMass = 1): Particle {
  return { x: { x, y }, prev: { x: prevX, y: prevY }, pinned: false, invMass };
}

/** Build a pinned (immovable) particle at (x, y). */
function pinned(x: number, y: number): Particle {
  return { x: { x, y }, prev: { x, y }, pinned: true, invMass: 0 };
}

/** Minimal rope-letter wrapper around a node list for overlap tests. */
function letter(id: string, colliderRadius: number, particles: Particle[]): RopeLetter {
  return {
    id,
    glyph: id,
    lineId: 'line',
    particles,
    constraints: [],
    colliderRadius,
    ownerId: null,
    placedSlot: null,
    correctIndex: 0,
    spawnJitterSeed: 0,
  };
}

const BOUNDS: Rect = { x: 0, y: 0, width: 100, height: 100 };

describe('resolveBounds', () => {
  it('clamps a particle that crossed the left wall onto the boundary', () => {
    const p = particle(-5, 50, 2, 50); // moving left (v = -7)
    resolveBounds([p], BOUNDS, 0.5);
    expect(p.x.x).toBe(0); // clamped onto the wall
  });

  it('reverses and scales implicit velocity by restitution (prev adjustment)', () => {
    // v before = x - prev = -5 - 2 = -7 along x.
    const p = particle(-5, 50, 2, 50);
    resolveBounds([p], BOUNDS, 0.5);
    // new prev = left + restitution * vBefore = 0 + 0.5 * (-7) = -3.5
    // new implicit velocity = x - prev = 0 - (-3.5) = +3.5 (reversed, half magnitude).
    expect(p.prev.x).toBeCloseTo(-3.5, 10);
    expect(p.x.x - p.prev.x).toBeCloseTo(3.5, 10);
  });

  it('restitution 0 fully damps the rebound velocity (sticks to the wall)', () => {
    const p = particle(120, 50, 110, 50); // crossed the right wall, v = +10
    resolveBounds([p], BOUNDS, 0);
    expect(p.x.x).toBe(100);
    // new velocity = x - prev = 100 - 100 = 0.
    expect(p.x.x - p.prev.x).toBeCloseTo(0, 10);
  });

  it('restitution 1 produces a fully elastic bounce', () => {
    const p = particle(50, 130, 50, 120); // crossed the bottom wall, v = +10
    resolveBounds([p], BOUNDS, 1);
    expect(p.x.y).toBe(100);
    // new velocity = -vBefore = -10.
    expect(p.x.y - p.prev.y).toBeCloseTo(-10, 10);
  });

  it('reflects on both axes when a particle overshoots a corner', () => {
    const p = particle(-3, -4, 1, 2); // crossed left and top
    resolveBounds([p], BOUNDS, 0.5);
    expect(p.x.x).toBe(0);
    expect(p.x.y).toBe(0);
    expect(Number.isNaN(p.prev.x)).toBe(false);
    expect(Number.isNaN(p.prev.y)).toBe(false);
  });

  it('clamps a fixed particle position but leaves its prev untouched', () => {
    const p = pinned(-10, 50);
    resolveBounds([p], BOUNDS, 0.5);
    expect(p.x.x).toBe(0); // still constrained in-bounds (Req 7.4)
    expect(p.prev).toEqual({ x: -10, y: 50 }); // no velocity reflection for fixed nodes
  });

  it('leaves an in-bounds particle unchanged', () => {
    const p = particle(50, 50, 49, 49);
    resolveBounds([p], BOUNDS, 0.5);
    expect(p.x).toEqual({ x: 50, y: 50 });
    expect(p.prev).toEqual({ x: 49, y: 49 });
  });
});

describe('resolveOverlap', () => {
  it('pushes overlapping nodes of different letters apart so they just touch', () => {
    const a = letter('a', 5, [particle(0, 0)]);
    const b = letter('b', 5, [particle(6, 0)]); // dist 6 < r1+r2 = 10
    resolveOverlap([a, b]);
    const dx = b.particles[0]!.x.x - a.particles[0]!.x.x;
    const dy = b.particles[0]!.x.y - a.particles[0]!.x.y;
    expect(Math.hypot(dx, dy)).toBeCloseTo(10, 10); // separated to exactly r1 + r2
    // Equal masses -> symmetric push around the midpoint (3, 0).
    expect(a.particles[0]!.x.x).toBeCloseTo(-2, 10);
    expect(b.particles[0]!.x.x).toBeCloseTo(8, 10);
  });

  it('does not move non-overlapping letters', () => {
    const a = letter('a', 5, [particle(0, 0)]);
    const b = letter('b', 5, [particle(20, 0)]); // dist 20 > 10
    resolveOverlap([a, b]);
    expect(a.particles[0]!.x).toEqual({ x: 0, y: 0 });
    expect(b.particles[0]!.x).toEqual({ x: 20, y: 0 });
  });

  it('keeps a pinned node fixed and pushes the whole penetration onto the free node', () => {
    const a = letter('a', 5, [pinned(0, 0)]);
    const b = letter('b', 5, [particle(6, 0)]); // penetration = 10 - 6 = 4
    resolveOverlap([a, b]);
    expect(a.particles[0]!.x).toEqual({ x: 0, y: 0 }); // pinned, unmoved
    expect(b.particles[0]!.x.x).toBeCloseTo(10, 10); // moved the full penetration
  });

  it('separates coincident centers deterministically along +x without NaN', () => {
    const a = letter('a', 5, [particle(7, 7)]);
    const b = letter('b', 5, [particle(7, 7)]); // exactly coincident
    resolveOverlap([a, b]);
    expect(Number.isNaN(a.particles[0]!.x.x)).toBe(false);
    expect(Number.isNaN(b.particles[0]!.x.x)).toBe(false);
    // Deterministic +x axis, equal mass split of penetration = 10.
    expect(a.particles[0]!.x.x).toBeCloseTo(2, 10);
    expect(b.particles[0]!.x.x).toBeCloseTo(12, 10);
    expect(a.particles[0]!.x.y).toBeCloseTo(7, 10);
    expect(b.particles[0]!.x.y).toBeCloseTo(7, 10);
  });

  it('does not resolve overlaps between nodes of the same letter', () => {
    // Two nodes in ONE letter sitting on top of each other: left to constraints.
    const a = letter('a', 5, [particle(0, 0), particle(1, 0)]);
    resolveOverlap([a]);
    expect(a.particles[0]!.x).toEqual({ x: 0, y: 0 });
    expect(a.particles[1]!.x).toEqual({ x: 1, y: 0 });
  });
});
