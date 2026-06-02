/**
 * Allocation-free {@link Vec2} math helpers and a tiny reuse pool.
 *
 * Every operation writes its result into an existing `out` target rather than
 * allocating a new object, so the physics inner loops can reuse a small set of
 * pre-allocated scratch vectors instead of creating garbage per step/iteration
 * (Requirement 14.3). The {@link Vec2Pool} provides a fixed ring of reusable
 * vectors for callers that need several scratch values at once.
 *
 * Pure module: no DOM/network/audio/React imports, keeping `@glitch/core` pure.
 */

import type { Vec2 } from '../types/index.js';

/** Create a new {@link Vec2}. Allocate these once and reuse via the helpers. */
export function createVec2(x = 0, y = 0): Vec2 {
  return { x, y };
}

/** Write `(x, y)` into `out` and return it. */
export function set(out: Vec2, x: number, y: number): Vec2 {
  out.x = x;
  out.y = y;
  return out;
}

/** Copy `a` into `out` and return `out`. */
export function copy(out: Vec2, a: Vec2): Vec2 {
  out.x = a.x;
  out.y = a.y;
  return out;
}

/** `out = a + b`. Returns `out`. */
export function add(out: Vec2, a: Vec2, b: Vec2): Vec2 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  return out;
}

/** `out = a - b`. Returns `out`. */
export function sub(out: Vec2, a: Vec2, b: Vec2): Vec2 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  return out;
}

/** `out = a * s` (scalar multiply). Returns `out`. */
export function scale(out: Vec2, a: Vec2, s: number): Vec2 {
  out.x = a.x * s;
  out.y = a.y * s;
  return out;
}

/** `out = a + b * s` (fused multiply-add). Returns `out`. */
export function addScaled(out: Vec2, a: Vec2, b: Vec2, s: number): Vec2 {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  return out;
}

/** Squared length of `a` (avoids a `sqrt` when only comparing magnitudes). */
export function lengthSq(a: Vec2): number {
  return a.x * a.x + a.y * a.y;
}

/** Euclidean length of `a`. */
export function length(a: Vec2): number {
  return Math.sqrt(a.x * a.x + a.y * a.y);
}

/**
 * A fixed-size ring of pre-allocated {@link Vec2} scratch objects.
 *
 * `acquire()` cycles through the buffer so a loop can borrow temporaries
 * without allocating; the caller must consume each borrowed vector before the
 * ring wraps back around to it. Use {@link reset} at a known boundary (e.g. the
 * start of a tick) to make borrowing deterministic.
 */
export class Vec2Pool {
  private readonly buffer: Vec2[];
  private cursor = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError('Vec2Pool capacity must be a positive integer');
    }
    this.buffer = new Array<Vec2>(capacity);
    for (let i = 0; i < capacity; i++) {
      this.buffer[i] = createVec2();
    }
  }

  /** Number of pre-allocated vectors in the ring. */
  get capacity(): number {
    return this.buffer.length;
  }

  /** Borrow the next pre-allocated vector, cycling through the fixed ring. */
  acquire(): Vec2 {
    const v = this.buffer[this.cursor]!;
    this.cursor = (this.cursor + 1) % this.buffer.length;
    return v;
  }

  /** Reset the ring cursor back to the first vector. */
  reset(): void {
    this.cursor = 0;
  }
}
