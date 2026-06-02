/**
 * Pure non-owned-letter snapshot interpolation math (task 17.6).
 *
 * design.md "Client-side prediction and reconciliation":
 *
 * > Letters the Client does not own are driven purely by interpolated
 * > authoritative updates (Requirement 14.5).
 *
 * In multiplayer the {@link ../host/RemoteGameHost.RemoteGameHost} renders two
 * classes of letters differently (Requirements 16.1, 16.2):
 *
 * - **Owned letters** (locked by THIS Client's Player) are predicted locally by
 *   the prediction `GameCore` and interpolated between the two most recent
 *   PHYSICS ticks by the fixed-timestep `alpha` — exactly like the
 *   `LocalGameHost` (responsive dragging, Requirement 14.4).
 * - **Non-owned letters** (unlocked or owned by another Player) are driven
 *   PURELY by the authoritative snapshots: the host keeps the two most recent
 *   snapshots and interpolates each non-owned letter's particle positions
 *   between them (Requirement 14.5/16.2). The prediction core's local physics
 *   for those letters is never rendered.
 *
 * This module extracts the two pure, allocation-light pieces of that non-owned
 * path so they are unit-/property-testable without a socket, a `GameCore`, or a
 * render loop:
 *
 * 1. {@link snapshotInterpolationAlpha} — the entity-interpolation factor in
 *    `[0, 1]` derived from the two snapshots' arrival times and the current
 *    wall-clock (a classic "render one snapshot interval in the past" buffer so
 *    motion stays smooth between ≥15Hz updates without extrapolating).
 * 2. {@link interpolateLetterParticles} — linear interpolation of a letter's
 *    particle positions between its `prev`/`curr` {@link ParticleSnapshot}
 *    arrays by that factor, written into a REUSED output array (no per-frame
 *    allocation, Requirement 14.3).
 *
 * Both are total and side-effect-free (apart from writing the caller-owned
 * `out` array), so a contradicted or partially-spawned snapshot can never throw.
 */

import type { ParticleSnapshot, Vec2 } from '@glitch/core';

/** Clamp `v` into the inclusive range `[lo, hi]`. */
function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/** Linear interpolation between `a` and `b` by `t` (no allocation). */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Compute the entity-interpolation factor in `[0, 1]` for rendering a non-owned
 * letter between the PREVIOUS authoritative snapshot (arrived at
 * `prevArrivalMs`) and the CURRENT one (arrived at `currArrivalMs`), evaluated
 * at wall-clock `nowMs`.
 *
 * The factor renders ONE inter-snapshot interval in the past so the position
 * being drawn is always bracketed by two received snapshots (never extrapolated
 * past the latest one):
 *
 * ```
 * interval = currArrivalMs - prevArrivalMs        // last observed snapshot gap
 * alpha    = clamp((nowMs - currArrivalMs) / interval, 0, 1)
 * ```
 *
 * - `alpha = 0` at `nowMs = currArrivalMs` → render exactly at the PREVIOUS
 *   snapshot, then advance toward the current one as wall-clock time passes.
 * - `alpha = 1` at `nowMs = currArrivalMs + interval` → render exactly at the
 *   CURRENT snapshot (by which time the next snapshot has typically arrived,
 *   shifting `curr → prev` and continuing smoothly from the same position).
 * - Monotonic non-decreasing in `nowMs`; clamped so a late next snapshot freezes
 *   at the current state rather than overshooting.
 *
 * Defensive: when the interval is non-positive or either time is non-finite the
 * two snapshots cannot be ordered in time, so it returns `1` (snap to the
 * current/most-recent snapshot) rather than dividing by zero.
 *
 * @param prevArrivalMs Wall-clock (ms) the previous snapshot was received.
 * @param currArrivalMs Wall-clock (ms) the current snapshot was received.
 * @param nowMs         Current wall-clock (ms).
 */
export function snapshotInterpolationAlpha(
  prevArrivalMs: number,
  currArrivalMs: number,
  nowMs: number,
): number {
  if (
    !Number.isFinite(prevArrivalMs) ||
    !Number.isFinite(currArrivalMs) ||
    !Number.isFinite(nowMs)
  ) {
    return 1;
  }
  const interval = currArrivalMs - prevArrivalMs;
  if (interval <= 0) return 1;
  return clamp((nowMs - currArrivalMs) / interval, 0, 1);
}

/**
 * Interpolate a letter's particle positions between two authoritative snapshot
 * states by `alpha`, writing the result into the reused `out` array (grown or
 * shrunk in place to the resolved particle count, so the steady state allocates
 * nothing — Requirement 14.3). Returns `out`.
 *
 * Each {@link ParticleSnapshot}'s authoritative position is its `x` field; the
 * `prev` field (implicit velocity) is not needed for rendering and is ignored.
 *
 * Resolution rules (total — never throws on a partial/mismatched snapshot):
 * - both `prev` and `curr` present → lerp index-by-index over the SHORTER length
 *   (a benign particle-count mismatch cannot read out of bounds);
 * - only `curr` present (the letter is new this snapshot) → copy `curr`;
 * - only `prev` present (the letter just disappeared from `curr`) → copy `prev`;
 * - neither present → `out` is emptied.
 *
 * @param prev  The previous snapshot's particles for this letter, or `undefined`.
 * @param curr  The current snapshot's particles for this letter, or `undefined`.
 * @param alpha Interpolation factor (typically from {@link snapshotInterpolationAlpha}).
 * @param out   Reused destination array of {@link Vec2} (mutated and returned).
 */
export function interpolateLetterParticles(
  prev: readonly ParticleSnapshot[] | undefined,
  curr: readonly ParticleSnapshot[] | undefined,
  alpha: number,
  out: Vec2[],
): Vec2[] {
  const a = clamp(Number.isFinite(alpha) ? alpha : 0, 0, 1);

  // Resolve the source(s) and the particle count to write.
  if (curr && prev) {
    const n = Math.min(curr.length, prev.length);
    resize(out, n);
    for (let i = 0; i < n; i++) {
      const c = curr[i]!.x;
      const p = prev[i]!.x;
      const dst = out[i]!;
      dst.x = lerp(p.x, c.x, a);
      dst.y = lerp(p.y, c.y, a);
    }
    return out;
  }

  const only = curr ?? prev;
  if (!only) {
    out.length = 0;
    return out;
  }
  resize(out, only.length);
  for (let i = 0; i < only.length; i++) {
    const src = only[i]!.x;
    const dst = out[i]!;
    dst.x = src.x;
    dst.y = src.y;
  }
  return out;
}

/** Grow/shrink `arr` to exactly `n` reusable {@link Vec2} entries (in place). */
function resize(arr: Vec2[], n: number): void {
  while (arr.length < n) arr.push({ x: 0, y: 0 });
  if (arr.length > n) arr.length = n;
}
