import { describe, it, expect } from 'vitest';
import type { Particle, Constraint, Vec2 } from '../types/index.js';
import {
  integrateParticles,
  solveConstraints,
  createVec2,
  Vec2Pool,
  add,
  sub,
  scale,
  addScaled,
  length,
  lengthSq,
} from './index.js';

/** Build a free (movable) particle at (x, y) with matching prev (zero velocity). */
function freeParticle(x: number, y: number): Particle {
  return { x: { x, y }, prev: { x, y }, pinned: false, invMass: 1 };
}

/** Build a pinned (immovable) particle at (x, y). */
function pinnedParticle(x: number, y: number): Particle {
  return { x: { x, y }, prev: { x, y }, pinned: true, invMass: 0 };
}

const NO_GRAVITY: Vec2 = { x: 0, y: 0 };

describe('Vec2 allocation-free helpers', () => {
  it('write results into the provided out target', () => {
    const out = createVec2();
    expect(add(out, { x: 1, y: 2 }, { x: 3, y: 4 })).toBe(out);
    expect(out).toEqual({ x: 4, y: 6 });

    sub(out, { x: 5, y: 5 }, { x: 1, y: 2 });
    expect(out).toEqual({ x: 4, y: 3 });

    scale(out, { x: 2, y: -3 }, 2);
    expect(out).toEqual({ x: 4, y: -6 });

    addScaled(out, { x: 1, y: 1 }, { x: 2, y: 4 }, 0.5);
    expect(out).toEqual({ x: 2, y: 3 });

    expect(length({ x: 3, y: 4 })).toBe(5);
    expect(lengthSq({ x: 3, y: 4 })).toBe(25);
  });

  it('Vec2Pool reuses a fixed ring of vectors without allocating new ones', () => {
    const pool = new Vec2Pool(2);
    expect(pool.capacity).toBe(2);
    const a = pool.acquire();
    const b = pool.acquire();
    const c = pool.acquire(); // wraps back to the first vector
    expect(c).toBe(a);
    expect(b).not.toBe(a);
    pool.reset();
    expect(pool.acquire()).toBe(a);
  });

  it('rejects a non-positive pool capacity', () => {
    expect(() => new Vec2Pool(0)).toThrow(RangeError);
  });
});

describe('integrateParticles', () => {
  it('carries implicit velocity forward (x - prev) with damping 1 and no gravity', () => {
    // prev (0,0) -> x (1,0) means velocity (1,0); next step should reach (2,0).
    const p: Particle = { x: { x: 1, y: 0 }, prev: { x: 0, y: 0 }, pinned: false, invMass: 1 };
    integrateParticles([p], 16, NO_GRAVITY, 1);
    expect(p.x).toEqual({ x: 2, y: 0 });
    expect(p.prev).toEqual({ x: 1, y: 0 });
  });

  it('applies gravity as a*dt^2 with dt converted from ms to seconds', () => {
    const p = freeParticle(0, 0); // zero implicit velocity
    const gravity: Vec2 = { x: 0, y: 100 }; // units / second^2
    const dtMs = 100; // 0.1s -> dt^2 = 0.01
    integrateParticles([p], dtMs, gravity, 1);
    // displacement = 100 * 0.01 = 1
    expect(p.x.x).toBeCloseTo(0, 10);
    expect(p.x.y).toBeCloseTo(1, 10);
  });

  it('damping < 1 reduces retained velocity', () => {
    const p: Particle = { x: { x: 1, y: 0 }, prev: { x: 0, y: 0 }, pinned: false, invMass: 1 };
    integrateParticles([p], 16, NO_GRAVITY, 0.5);
    // velocity (1,0) * 0.5 -> x advances by 0.5
    expect(p.x.x).toBeCloseTo(1.5, 10);
  });

  it('does not move pinned or infinite-mass particles', () => {
    const pinned = pinnedParticle(5, 5);
    const infinite: Particle = { x: { x: 7, y: 7 }, prev: { x: 6, y: 6 }, pinned: false, invMass: 0 };
    integrateParticles([pinned, infinite], 16, { x: 0, y: 100 }, 1);
    expect(pinned.x).toEqual({ x: 5, y: 5 });
    expect(infinite.x).toEqual({ x: 7, y: 7 });
  });
});

describe('solveConstraints', () => {
  it('relaxes two free particles halfway toward rest length per iteration, split by equal mass', () => {
    const a = freeParticle(0, 0);
    const b = freeParticle(10, 0);
    const constraints: Constraint[] = [{ a: 0, b: 1, restLength: 6, stiffness: 1 }];
    solveConstraints([a, b], constraints, 1);
    // Per design, shift = d*diff*0.5*stiffness, then split by inverse-mass share.
    // dist 10, rest 6 => gap 4 closes by half per iteration: a +1, b -1, dist 8.
    expect(a.x.x).toBeCloseTo(1, 10);
    expect(b.x.x).toBeCloseTo(9, 10);
    expect(length(sub(createVec2(), b.x, a.x))).toBeCloseTo(8, 10);
  });

  it('keeps a pinned endpoint fixed and applies the whole iteration share to the free one', () => {
    const pinned = pinnedParticle(0, 0);
    const free = freeParticle(10, 0);
    const constraints: Constraint[] = [{ a: 0, b: 1, restLength: 4, stiffness: 1 }];
    solveConstraints([pinned, free], constraints, 1);
    // dist 10, rest 4 => shift = 10*((4-10)/10)*0.5 = -3; free takes the full share.
    expect(pinned.x).toEqual({ x: 0, y: 0 });
    expect(free.x.x).toBeCloseTo(7, 10);
  });

  it('converges to rest length within tolerance over the configured relaxation iterations', () => {
    const a = freeParticle(0, 0);
    const b = freeParticle(20, 0);
    const rest = 10;
    // error multiplies by (1 - 0.5*stiffness) per iteration => 0.75 at stiffness 0.5.
    const constraints: Constraint[] = [{ a: 0, b: 1, restLength: rest, stiffness: 0.5 }];
    solveConstraints([a, b], constraints, 30);
    const dist = length(sub(createVec2(), b.x, a.x));
    expect(Math.abs(dist - rest)).toBeLessThan(0.05);
  });

  it('fully rigid (stiffness 1) reaches rest length within tolerance after 5 iterations', () => {
    const a = freeParticle(0, 0);
    const b = freeParticle(30, 0);
    const rest = 12;
    const constraints: Constraint[] = [{ a: 0, b: 1, restLength: rest, stiffness: 1 }];
    solveConstraints([a, b], constraints, 5);
    const dist = length(sub(createVec2(), b.x, a.x));
    // 5 iterations halve the gap each time: |error| = 18 * 0.5^5 ≈ 0.5625.
    expect(Math.abs(dist - rest)).toBeLessThan(1);
  });

  it('skips coincident particles without producing NaN (divide-by-zero guard)', () => {
    const a = freeParticle(3, 3);
    const b = freeParticle(3, 3);
    const constraints: Constraint[] = [{ a: 0, b: 1, restLength: 5, stiffness: 1 }];
    solveConstraints([a, b], constraints, 3);
    expect(Number.isNaN(a.x.x)).toBe(false);
    expect(Number.isNaN(b.x.x)).toBe(false);
    expect(a.x).toEqual({ x: 3, y: 3 });
    expect(b.x).toEqual({ x: 3, y: 3 });
  });

  it('skips constraints whose endpoints are both fixed', () => {
    const a = pinnedParticle(0, 0);
    const b = pinnedParticle(10, 0);
    const constraints: Constraint[] = [{ a: 0, b: 1, restLength: 4, stiffness: 1 }];
    solveConstraints([a, b], constraints, 5);
    expect(a.x).toEqual({ x: 0, y: 0 });
    expect(b.x).toEqual({ x: 10, y: 0 });
  });
});
