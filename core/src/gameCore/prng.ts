/**
 * Tiny seeded, deterministic pseudo-random number generator.
 *
 * `GameCore` needs reproducible randomness for ransom-note spawn jitter so that
 * a given seed + the same sequence of spawn calls always produces identical
 * rope-letters (design.md "Determinism note: the engine uses a seeded PRNG for
 * any randomized spawn jitter so a given seed + input sequence is fully
 * reproducible"). This module provides exactly that — nothing audio/DOM/network
 * — keeping `@glitch/core` pure.
 *
 * ## Algorithm: mulberry32
 * We use **mulberry32**, a well-known 32-bit single-state PRNG. It is chosen
 * because it is:
 * - tiny and dependency-free (a few integer ops),
 * - fully deterministic from a single 32-bit seed (ideal for reproducible,
 *   shrinkable property-test failures), and
 * - of good enough statistical quality for cosmetic spawn jitter (it is NOT a
 *   cryptographic RNG and is not used for anything security-sensitive).
 *
 * The generator threads a single 32-bit state word; each call advances the
 * state and returns a float in the half-open interval `[0, 1)`. All arithmetic
 * is forced into 32-bit integer space with `| 0`, `>>> 0`, and `Math.imul`, so
 * results are identical across JavaScript engines (no reliance on platform
 * float ordering) — which is what makes client/server agreement hold.
 */

/** A function returning successive deterministic floats in `[0, 1)`. */
export type Prng = () => number;

/** Divisor mapping a 32-bit unsigned integer into the `[0, 1)` float range. */
const UINT32_RANGE = 4294967296; // 2 ** 32

/**
 * Create a {@link Prng} seeded by `seed`. The seed is coerced to a 32-bit
 * unsigned integer, so any finite number is accepted; equal seeds yield
 * identical streams.
 *
 * @param seed Any number; coerced via `>>> 0` to a 32-bit unsigned seed.
 * @returns A stateful function that returns the next float in `[0, 1)` per call.
 */
export function mulberry32(seed: number): Prng {
  // Single 32-bit state word. `>>> 0` coerces the seed into [0, 2^32).
  let state = seed >>> 0;

  return function next(): number {
    // Advance the state by the mulberry32 odd increment, kept in int32 space.
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    // Mix the bits (xorshift + integer multiplies) for avalanche.
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    // Final xorshift, then map the 32-bit unsigned result into [0, 1).
    return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
  };
}
