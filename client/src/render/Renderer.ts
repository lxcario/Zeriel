/**
 * Renderer (Canvas 2D) — Client subsystem (Task 9.1).
 *
 * Draws the in-round gameplay play area in the handmade zine/VHS/ransom-note
 * aesthetic (Requirement 12). This module lives in the CLIENT package (not
 * `@glitch/core`) because it touches the 2D HTML5 Canvas (DOM); `core` stays
 * pure.
 *
 * Design references (design.md "Renderer (Canvas 2D)"):
 * - Draw each Rope_Letter as a cut-out ransom-note glyph with per-letter
 *   rotation/placement variation (Requirement 12.1) — derived DETERMINISTICALLY
 *   from the letter's `spawnJitterSeed` so the look is stable frame to frame.
 * - Stamp pre-rendered paper-grain + scan-line textures from off-screen buffers
 *   created ONCE at init (Requirements 12.2, 12.4).
 * - Apply bounded off-grid offsets to play/UI elements (Requirement 12.3),
 *   bounded by `opts.offGridMaxOffsetPx` and deterministic per element so they
 *   do not jitter every frame unless motion is allowed.
 * - Render neo-brutalist container borders: thick borders + high contrast
 *   (Requirement 12.5).
 * - Interpolate between the two most recent physics states by `alpha`
 *   (Requirement 14.1) — `draw(state, alpha, audio)` lerps particle positions.
 * - React to amplitude/frequency from the {@link AudioFrame}; handle a `null`
 *   AudioFrame (CORS-unreliable) by disabling audio-reactive effects gracefully
 *   (Requirement 5.3).
 * - Suppress non-essential motion (scan-line jitter, decorative shake) when
 *   Reduce_Motion_Mode is on, while PRESERVING core gameplay motion — letters
 *   still move by their interpolated physics positions (Requirement 13.1).
 * - Sustain 60fps (Requirement 14.1) — reuse pre-allocated buffers, do not
 *   allocate per frame in the hot path; pre-render static textures once at init.
 *
 * ## Testability seam (jsdom, no real GPU canvas)
 * jsdom's `canvas.getContext('2d')` returns `null`, so the Renderer never
 * assumes a real context. Every web dependency is injectable via
 * {@link CanvasRendererConfig}:
 * - `createContext` yields a {@link CanvasContextLike} (a real
 *   `CanvasRenderingContext2D` cast at the boundary, OR a recording fake).
 * - `createBuffer` yields an off-screen {@link RenderBuffer} (real
 *   `OffscreenCanvas`/`<canvas>`, OR a fake) — and may return `null`, in which
 *   case texture stamping is skipped without crashing.
 * - `random` seeds the one-time texture generation only (never per frame).
 *
 * The deterministic per-letter variation and bounded off-grid offset are pure,
 * exported helpers ({@link letterVariation}, {@link offGridOffset}) so the
 * optional property tests (Property 34 bounded off-grid, Property 35
 * reduce-motion suppression) can target pure functions.
 */

import type { RenderOptions, Vec2, Rect, PlayerId } from '@glitch/core';
import type { AudioFrame } from '../audio/AudioPlayer.ts';

// ---------------------------------------------------------------------------
// Canvas context seam — the minimal subset of CanvasRenderingContext2D used.
// ---------------------------------------------------------------------------

/** Subset of `TextMetrics` consumed by the Renderer. */
export interface TextMetricsLike {
  width: number;
}

/**
 * An opaque image source accepted by {@link CanvasContextLike.drawImage}. A real
 * `OffscreenCanvas`/`HTMLCanvasElement` (both valid `CanvasImageSource`) or a
 * test fake satisfies this; it is treated as opaque by the Renderer.
 */
export type CanvasImageSourceLike = unknown;

/**
 * The minimal structural subset of `CanvasRenderingContext2D` the Renderer
 * draws through. A real 2D context is assignable after a single
 * `as unknown as CanvasContextLike` cast at the {@link defaultCreateContext}
 * boundary; tests pass a lightweight recording fake implementing these members.
 */
export interface CanvasContextLike {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  globalAlpha: number;
  textAlign: string;
  textBaseline: string;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): TextMetricsLike;
  drawImage(image: CanvasImageSourceLike, dx: number, dy: number): void;
}

/**
 * An off-screen buffer holding a pre-rendered static texture (paper grain or
 * scan-lines). `ctx` is used ONCE at init to paint the texture; `image` is the
 * handle stamped via {@link CanvasContextLike.drawImage} each frame.
 */
export interface RenderBuffer {
  width: number;
  height: number;
  ctx: CanvasContextLike;
  image: CanvasImageSourceLike;
}

// ---------------------------------------------------------------------------
// Render state — what draw() consumes (built by the host from two snapshots).
// ---------------------------------------------------------------------------

/**
 * The view of a single Rope_Letter the Renderer draws. The host (task 14.1)
 * derives it from `GameCore.snapshot()` / `GameCore.letters`, supplying the
 * CURRENT particle positions and (optionally) the PREVIOUS positions so
 * {@link CanvasRenderer.draw} can interpolate between the two most recent
 * physics states by `alpha` (Requirement 14.1).
 */
export interface LetterView {
  /** Stable letter id (used for deterministic per-element off-grid offset). */
  id: string;
  /** The letter or word text drawn as a ransom-note glyph. */
  glyph: string;
  /** Current-state particle positions (this physics tick). */
  current: readonly Vec2[];
  /**
   * Previous-state particle positions (prior physics tick), same length/order
   * as {@link current}. When omitted, no interpolation is applied (the letter is
   * drawn at its current positions).
   */
  previous?: readonly Vec2[];
  /** Deterministic seed for ransom-note rotation/placement variation (12.1). */
  spawnJitterSeed: number;
  /** Ownership_Lock holder, or `null`/omitted when unlocked (decorative only). */
  ownerId?: PlayerId | null;
  /** Solution_Slot index when placed, or `null`/omitted (decorative only). */
  placedSlot?: number | null;
}

/**
 * A neo-brutalist UI container drawn with a thick, high-contrast border
 * (Requirement 12.5) and a bounded deterministic off-grid offset
 * (Requirement 12.3).
 */
export interface RenderContainer {
  /** Stable id; hashed to a deterministic per-container off-grid offset. */
  id: string;
  /** The container rectangle in play-area coordinates. */
  rect: Rect;
}

/**
 * A Solution_Slot target drawn as a faint gray "ghost" word, showing the player
 * WHERE a word should go and WHICH word belongs there (Requirement 9.1 made
 * visible). Purely a render hint derived from the line's solution slots + the
 * correct token order; gameplay/scoring is unaffected.
 */
export interface SlotView {
  /** Center position of the target slot (play-area coordinates). */
  position: Vec2;
  /** The correct word for this slot, drawn faint/gray as a placement guide. */
  glyph: string;
}

/**
 * Everything {@link CanvasRenderer.draw} needs for one frame. Built by the host
 * from the two most recent authoritative/predicted physics snapshots.
 */
export interface RenderState {
  /** Play-area bounds; the background, grain, and scan-lines cover this. */
  bounds: Rect;
  /** Rope_Letters to draw this frame. */
  letters: readonly LetterView[];
  /** Optional neo-brutalist UI containers to outline (Requirement 12.5). */
  containers?: readonly RenderContainer[];
  /** Optional gray ghost target words showing where letters should be placed. */
  slots?: readonly SlotView[];
}

/**
 * The Renderer contract (design.md "Renderer (Canvas 2D)"). Implemented by
 * {@link CanvasRenderer}.
 */
export interface Renderer {
  /** Acquire the context and pre-render static textures once (12.2, 12.4). */
  init(canvas: HTMLCanvasElement, opts: RenderOptions): void;
  /** Draw one interpolated frame, reacting to `audio` when non-null (5.3, 14.1). */
  draw(state: RenderState, alpha: number, audio: AudioFrame | null): void;
  /** Toggle Reduce_Motion_Mode (Requirement 13.1). */
  setReduceMotion(enabled: boolean): void;
  /** Release buffers and references. */
  dispose(): void;
}

/** Injectable web-dependency factories for {@link CanvasRenderer}. */
export interface CanvasRendererConfig {
  /** Acquire a drawing context for the canvas; defaults to a real 2D context. */
  createContext?: (canvas: HTMLCanvasElement) => CanvasContextLike | null;
  /** Create an off-screen texture buffer; defaults to OffscreenCanvas/`<canvas>`. */
  createBuffer?: (width: number, height: number) => RenderBuffer | null;
  /** PRNG used ONLY for one-time texture generation at init (not per frame). */
  random?: () => number;
}

// ---------------------------------------------------------------------------
// Constants (handmade-aesthetic tuning; pure, no per-frame state).
// ---------------------------------------------------------------------------

/** Maximum ransom-note per-letter rotation, in radians (~9 degrees). */
export const MAX_LETTER_ROTATION_RAD = 0.16;
/** Maximum ransom-note per-letter micro placement offset, in px. */
export const MAX_LETTER_VARIATION_PX = 3;
/** Vertical spacing between scan-lines in the pre-rendered scan-line texture. */
const SCANLINE_SPACING_PX = 3;
/** Per-frame vertical scan-line jitter amplitude (suppressed under reduce-motion). */
const SCANLINE_JITTER_PX = 1.5;
/** Per-frame decorative shake amplitude (suppressed under reduce-motion). */
const DECORATIVE_SHAKE_PX = 1.5;
/** Thick neo-brutalist border width, in px (Requirement 12.5). */
const NEO_BORDER_WIDTH_PX = 4;
/** Number of grain specks painted into the paper-grain texture at init. */
const PAPER_GRAIN_SPECKS = 1200;
/** Base glyph font size, in px. */
const BASE_FONT_PX = 28;
/** Padding around a glyph inside its ransom-note cut-out box, in px. */
const GLYPH_BOX_PADDING_PX = 6;
/** Number of low-frequency bins visualized by the audio-reactive accent layer. */
const AUDIO_BAR_COUNT = 8;
/**
 * Maximum extra scale applied to the whole scene on a strong audio beat
 * (Requirement 5.3 audio-reactive). At amplitude 1 the scene zooms to
 * `1 + BEAT_ZOOM_MAX`. Suppressed entirely under Reduce_Motion_Mode (13.1) and
 * when there is no AudioFrame (5.3). Applied as a GLOBAL canvas matrix around
 * the frame — never as a per-letter transform — so per-letter gameplay
 * positions (asserted by the renderer property tests) are unchanged.
 */
const BEAT_ZOOM_MAX = 0.06;
/** Smoothing factor for the beat-zoom envelope (0..1; higher = snappier). */
const BEAT_ZOOM_ATTACK = 0.35;

// High-contrast handmade palette (Requirement 12.5: high-contrast treatment).
const PAPER_BASE_COLOR = '#f4efe1';
const PAPER_SPECK_COLOR = 'rgba(40,34,28,0.16)';
const SCANLINE_COLOR = 'rgba(0,0,0,0.10)';
const INK_COLOR = '#141210';
const CUTOUT_FILL_COLOR = '#ffffff';
const AUDIO_ACCENT_COLOR = '#e23b2e';
/** Faint gray fill for ghost target words (placement guides). */
const SLOT_GHOST_FILL = 'rgba(20,18,16,0.18)';
/** Dashed outline for the ghost target box. */
const SLOT_GHOST_STROKE = 'rgba(20,18,16,0.28)';

// ---------------------------------------------------------------------------
// Pure helpers — deterministic variation + bounded off-grid offset.
// These are the targets of the optional property tests (9.2, 9.3).
// ---------------------------------------------------------------------------

/**
 * Hash a 32-bit `seed` (mixed with `salt`) to a float in `[0, 1)`. Pure and
 * deterministic — identical `(seed, salt)` always yields the same value — so
 * per-letter/per-element variation is stable across frames. Uses an
 * xorshift-style integer scramble kept in unsigned 32-bit space.
 */
export function hashUnit(seed: number, salt: number): number {
  let h = (Math.trunc(seed) ^ Math.imul(Math.trunc(salt) | 1, 0x9e3779b9)) >>> 0;
  h ^= h << 13;
  h >>>= 0;
  h ^= h >> 17;
  h ^= h << 5;
  h >>>= 0;
  return (h >>> 0) / 4294967296;
}

/**
 * Hash a string id to a 32-bit unsigned integer (FNV-1a). Used to derive a
 * deterministic seed for a {@link RenderContainer}'s off-grid offset from its id.
 */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Clamp `v` into the inclusive range `[lo, hi]`. */
function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * Deterministic ransom-note variation for one letter, derived from its
 * `spawnJitterSeed` (Requirement 12.1). Returns a small rotation (bounded by
 * {@link MAX_LETTER_ROTATION_RAD}) and a micro placement offset (each component
 * bounded by {@link MAX_LETTER_VARIATION_PX}). Pure and frame-stable.
 */
export function letterVariation(seed: number): { rotation: number; dx: number; dy: number } {
  const ur = hashUnit(seed, 3);
  const ux = hashUnit(seed, 4);
  const uy = hashUnit(seed, 5);
  return {
    rotation: (ur * 2 - 1) * MAX_LETTER_ROTATION_RAD,
    dx: (ux * 2 - 1) * MAX_LETTER_VARIATION_PX,
    dy: (uy * 2 - 1) * MAX_LETTER_VARIATION_PX,
  };
}

/**
 * Bounded, deterministic off-grid offset for a play/UI element (Requirement
 * 12.3) — the target of Property 34. Guarantees `|dx| <= |maxPx|` and
 * `|dy| <= |maxPx|` for ANY `seed`, and degrades to `{0,0}` when `maxPx` is not
 * a finite number. Deterministic in `seed` so elements do not jitter every
 * frame; per-frame decorative shake (added separately) is what reduce-motion
 * suppresses.
 *
 * @param seed - Stable per-element seed (e.g. `spawnJitterSeed` or a hashed id).
 * @param maxPx - Maximum absolute offset per axis (`opts.offGridMaxOffsetPx`).
 */
export function offGridOffset(seed: number, maxPx: number): { dx: number; dy: number } {
  const m = Number.isFinite(maxPx) ? Math.abs(maxPx) : 0;
  const ux = hashUnit(seed, 1);
  const uy = hashUnit(seed, 2);
  // (u*2 - 1) in [-1, 1); clamp defends against any floating-point drift so the
  // |offset| <= m guarantee holds for every seed (Property 34). `+ 0` normalizes
  // a possible negative zero (e.g. when m === 0) to positive zero.
  const dx = clamp((ux * 2 - 1) * m, -m, m) + 0;
  const dy = clamp((uy * 2 - 1) * m, -m, m) + 0;
  return { dx, dy };
}

/** Linear interpolation between `a` and `b` by `t` (no allocation). */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ---------------------------------------------------------------------------
// Default web-dependency factories (browser only; isolated at the boundary).
// All guarded so the module is import-safe under jsdom (getContext -> null,
// OffscreenCanvas absent) without crashing.
// ---------------------------------------------------------------------------

/** Acquire a real 2D context, or `null` (e.g. under jsdom). */
function defaultCreateContext(canvas: HTMLCanvasElement): CanvasContextLike | null {
  try {
    const ctx = canvas.getContext('2d');
    return ctx ? (ctx as unknown as CanvasContextLike) : null;
  } catch {
    return null;
  }
}

/**
 * Create a real off-screen buffer, preferring `OffscreenCanvas` and falling back
 * to a detached `<canvas>`. Returns `null` when neither is available or no 2D
 * context can be obtained (e.g. under jsdom) so texture stamping degrades to a
 * no-op rather than throwing.
 */
function defaultCreateBuffer(width: number, height: number): RenderBuffer | null {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const off = new OffscreenCanvas(w, h);
      const ctx = off.getContext('2d');
      if (!ctx) return null;
      return { width: w, height: h, ctx: ctx as unknown as CanvasContextLike, image: off };
    }
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      const el = document.createElement('canvas');
      el.width = w;
      el.height = h;
      const ctx = el.getContext('2d');
      if (!ctx) return null;
      return { width: w, height: h, ctx: ctx as unknown as CanvasContextLike, image: el };
    }
  } catch {
    // Any DOM/Offscreen access failure -> no texture buffer (degraded, no crash).
  }
  return null;
}

// ---------------------------------------------------------------------------
// CanvasRenderer
// ---------------------------------------------------------------------------

/**
 * Default 2D-Canvas implementation of {@link Renderer} in the handmade
 * aesthetic.
 *
 * Buffer reuse (Requirement 14.1/14.3): the paper-grain and scan-line textures
 * are painted ONCE into off-screen buffers at {@link init} and only STAMPED via
 * `drawImage` each frame. A single reusable scratch {@link Vec2} is mutated in
 * place during interpolation so {@link draw} performs no per-frame allocation in
 * the hot path.
 */
export class CanvasRenderer implements Renderer {
  private readonly createContext: (c: HTMLCanvasElement) => CanvasContextLike | null;
  private readonly createBuffer: (w: number, h: number) => RenderBuffer | null;
  private readonly random: () => number;

  private ctx: CanvasContextLike | null = null;
  private width = 0;
  private height = 0;
  private reduceMotion = false;
  private offGridMaxOffsetPx = 0;

  /** Pre-rendered static textures (created once at init; null under jsdom/fake). */
  private grainBuffer: RenderBuffer | null = null;
  private scanlineBuffer: RenderBuffer | null = null;

  /** Reusable scratch vector for interpolation — avoids per-frame allocation. */
  private readonly scratch: Vec2 = { x: 0, y: 0 };
  /** Monotonic frame counter driving per-frame jitter phase (decoration only). */
  private frame = 0;
  /**
   * Smoothed beat-zoom envelope in `[0, BEAT_ZOOM_MAX]`. Eased toward the
   * current audio amplitude each frame so the scene "breathes" with the beat
   * (Requirement 5.3). Reset to 0 and never advanced under reduce-motion or a
   * null AudioFrame, so the zoom is fully suppressed in those cases (13.1/5.3).
   */
  private beatZoom = 0;
  private disposed = false;

  constructor(config: CanvasRendererConfig = {}) {
    this.createContext = config.createContext ?? defaultCreateContext;
    this.createBuffer = config.createBuffer ?? defaultCreateBuffer;
    this.random = config.random ?? Math.random;
  }

  /**
   * Acquire the drawing context and PRE-RENDER the paper-grain + scan-line
   * textures to off-screen buffers ONCE (Requirements 12.2, 12.4). Safe under
   * jsdom: a `null` context or `null` buffer simply disables drawing/stamping.
   */
  init(canvas: HTMLCanvasElement, opts: RenderOptions): void {
    this.assertNotDisposed();
    this.reduceMotion = opts.reduceMotion;
    this.offGridMaxOffsetPx = Number.isFinite(opts.offGridMaxOffsetPx)
      ? Math.abs(opts.offGridMaxOffsetPx)
      : 0;
    this.width = canvas.width;
    this.height = canvas.height;
    this.ctx = this.createContext(canvas);

    // Pre-render static textures once; reused (stamped) every frame thereafter.
    this.grainBuffer = this.createBuffer(this.width, this.height);
    if (this.grainBuffer) this.paintPaperGrain(this.grainBuffer);
    this.scanlineBuffer = this.createBuffer(this.width, this.height);
    if (this.scanlineBuffer) this.paintScanlines(this.scanlineBuffer);
  }

  /** Toggle Reduce_Motion_Mode (Requirement 13.1). */
  setReduceMotion(enabled: boolean): void {
    this.reduceMotion = enabled;
  }

  /**
   * Draw one frame (Requirements 5.3, 12.1–12.5, 13.1, 14.1).
   *
   * Order: clear → paper grain → background fill → rope-letters (alpha-lerped,
   * ransom-note variation + bounded off-grid) → neo-brutalist containers →
   * audio-reactive accents (only when `audio !== null`) → scan-lines (jittered
   * only when motion is allowed). Gameplay motion (letter positions) is always
   * applied; only DECORATIVE motion (scan-line jitter, decorative shake) is
   * gated by `reduceMotion`.
   */
  draw(state: RenderState, alpha: number, audio: AudioFrame | null): void {
    this.assertNotDisposed();
    this.frame++;
    const ctx = this.ctx;
    if (!ctx) return; // Degraded (jsdom/no GPU): nothing to paint, never throws.

    const a = clamp(Number.isFinite(alpha) ? alpha : 0, 0, 1);

    ctx.clearRect(0, 0, this.width, this.height);

    // Beat-zoom envelope (Requirement 5.3 audio-reactive). Only advances when an
    // AudioFrame is present AND motion is allowed; otherwise it decays to 0 so
    // the scene is never scaled under reduce-motion or a null frame (13.1/5.3).
    const beatScale = this.updateBeatZoom(audio);
    const zoomed = beatScale !== 1;
    if (zoomed) {
      // GLOBAL matrix: scale the whole scene about the canvas center. This is a
      // canvas-transform effect only — it does NOT alter the per-letter
      // `translate` positions the renderer property tests assert on.
      const cx = this.width / 2;
      const cy = this.height / 2;
      ctx.save();
      ctx.setTransform(beatScale, 0, 0, beatScale, cx - cx * beatScale, cy - cy * beatScale);
    }

    // Paper-grain texture stamp (Requirement 12.2/12.4). Falls back to a flat
    // paper fill when no off-screen buffer is available (jsdom/fake).
    if (this.grainBuffer) {
      ctx.drawImage(this.grainBuffer.image, 0, 0);
    } else {
      ctx.fillStyle = PAPER_BASE_COLOR;
      ctx.fillRect(state.bounds.x, state.bounds.y, state.bounds.width, state.bounds.height);
    }

    // Decorative shake: a per-frame whole-scene nudge, suppressed under
    // reduce-motion (Requirement 13.1). Gameplay motion is unaffected.
    const shake = this.reduceMotion ? 0 : (hashUnit(this.frame, 7) * 2 - 1) * DECORATIVE_SHAKE_PX;

    // Gray ghost target words FIRST (under the letters) so players see where
    // each word should be placed.
    if (state.slots) {
      for (const slot of state.slots) {
        this.drawSlotGhost(ctx, slot);
      }
    }

    for (const letter of state.letters) {
      this.drawLetter(ctx, letter, a, shake);
    }

    if (state.containers) {
      for (const container of state.containers) {
        this.drawContainer(ctx, container);
      }
    }

    // Audio-reactive accents ONLY when an AudioFrame is present. A null frame
    // (CORS-unreliable) disables reactive effects gracefully (Requirement 5.3).
    if (audio !== null) {
      this.drawAudioReactive(ctx, state.bounds, audio);
    }

    // Restore the identity transform before stamping scan-lines so the CRT
    // overlay always covers the full canvas regardless of the beat-zoom.
    if (zoomed) ctx.restore();

    // Scan-line texture stamp (Requirement 12.2). The vertical jitter is the
    // non-essential motion suppressed under reduce-motion (Requirement 13.1).
    if (this.scanlineBuffer) {
      const jitterY = this.reduceMotion
        ? 0
        : (hashUnit(this.frame, 9) * 2 - 1) * SCANLINE_JITTER_PX;
      ctx.drawImage(this.scanlineBuffer.image, 0, jitterY);
    }
  }

  /**
   * Advance the smoothed {@link beatZoom} envelope toward the current audio
   * amplitude and return the resulting whole-scene scale factor (>= 1).
   *
   * Returns exactly `1` (no zoom) when Reduce_Motion_Mode is on OR there is no
   * AudioFrame, decaying the envelope back to 0 so the effect is fully
   * suppressed (Requirements 13.1, 5.3). Otherwise eases the envelope toward
   * `amplitude * BEAT_ZOOM_MAX` by {@link BEAT_ZOOM_ATTACK} and returns
   * `1 + beatZoom`.
   */
  private updateBeatZoom(audio: AudioFrame | null): number {
    if (this.reduceMotion || audio === null) {
      // Decay to rest; never scale.
      this.beatZoom += (0 - this.beatZoom) * BEAT_ZOOM_ATTACK;
      if (this.beatZoom < 1e-4) this.beatZoom = 0;
      return 1;
    }
    const target = clamp(audio.amplitude, 0, 1) * BEAT_ZOOM_MAX;
    this.beatZoom += (target - this.beatZoom) * BEAT_ZOOM_ATTACK;
    return 1 + this.beatZoom;
  }

  /** Release buffers/references; idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ctx = null;
    this.grainBuffer = null;
    this.scanlineBuffer = null;
  }

  // -------------------------------------------------------------------------
  // Frame drawing internals
  // -------------------------------------------------------------------------

  /**
   * Draw a faint gray "ghost" target word at a Solution_Slot, showing the player
   * where (and which) word to place. Drawn UNDER the live letters so a placed
   * letter visually covers its target. Purely decorative — no gameplay impact.
   */
  private drawSlotGhost(ctx: CanvasContextLike, slot: SlotView): void {
    ctx.save();
    ctx.translate(slot.position.x, slot.position.y);
    ctx.font = `${BASE_FONT_PX}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const textWidth = ctx.measureText(slot.glyph).width;
    const boxW = textWidth + GLYPH_BOX_PADDING_PX * 2;
    const boxH = BASE_FONT_PX + GLYPH_BOX_PADDING_PX * 2;
    // Faint outlined slot box (the empty "cut-out" the word belongs in).
    ctx.strokeStyle = SLOT_GHOST_STROKE;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-boxW / 2, -boxH / 2, boxW, boxH);
    // The faint gray word itself.
    ctx.fillStyle = SLOT_GHOST_FILL;
    ctx.fillText(slot.glyph, 0, 0);
    ctx.restore();
  }

  /**
   * Draw one Rope_Letter as a ransom-note cut-out glyph at its alpha-interpolated
   * centroid (Requirements 12.1, 14.1). Always applies the physics-driven
   * position (gameplay motion is preserved under reduce-motion); applies the
   * deterministic ransom-note rotation/variation and the bounded off-grid offset.
   */
  private drawLetter(
    ctx: CanvasContextLike,
    letter: LetterView,
    alpha: number,
    shake: number,
  ): void {
    const center = this.interpolatedCentroid(letter, alpha);
    const variation = letterVariation(letter.spawnJitterSeed);
    const offGrid = offGridOffset(letter.spawnJitterSeed, this.offGridMaxOffsetPx);

    const cx = center.x + variation.dx + offGrid.dx + shake;
    const cy = center.y + variation.dy + offGrid.dy + shake;

    const glyph = letter.glyph;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(variation.rotation);

    // Cut-out box behind the glyph (the "ransom note" paper scrap).
    ctx.font = `${BASE_FONT_PX}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const textWidth = ctx.measureText(glyph).width;
    const boxW = textWidth + GLYPH_BOX_PADDING_PX * 2;
    const boxH = BASE_FONT_PX + GLYPH_BOX_PADDING_PX * 2;
    ctx.fillStyle = CUTOUT_FILL_COLOR;
    ctx.fillRect(-boxW / 2, -boxH / 2, boxW, boxH);
    // Thin ink border around the scrap (high-contrast handmade edge).
    ctx.strokeStyle = INK_COLOR;
    ctx.lineWidth = 2;
    ctx.strokeRect(-boxW / 2, -boxH / 2, boxW, boxH);
    // The glyph itself.
    ctx.fillStyle = INK_COLOR;
    ctx.fillText(glyph, 0, 0);
    ctx.restore();
  }

  /**
   * Draw a neo-brutalist container: a thick, high-contrast border at a bounded
   * deterministic off-grid offset (Requirements 12.5, 12.3). The offset is
   * derived from the container id so it is stable frame to frame.
   */
  private drawContainer(ctx: CanvasContextLike, container: RenderContainer): void {
    const offset = offGridOffset(hashString(container.id), this.offGridMaxOffsetPx);
    const { x, y, width, height } = container.rect;
    ctx.save();
    ctx.lineWidth = NEO_BORDER_WIDTH_PX;
    ctx.strokeStyle = INK_COLOR;
    ctx.strokeRect(x + offset.dx, y + offset.dy, width, height);
    ctx.restore();
  }

  /**
   * Draw an audio-reactive accent strip from the low-frequency bins
   * (Requirement 5.3). Only ever called with a non-null {@link AudioFrame}, so a
   * degraded (CORS-unreliable) frame never reaches here.
   */
  private drawAudioReactive(ctx: CanvasContextLike, bounds: Rect, audio: AudioFrame): void {
    const bins = audio.frequencyBins;
    const barCount = Math.min(AUDIO_BAR_COUNT, bins.length);
    if (barCount <= 0) return;
    const barWidth = bounds.width / barCount;
    const maxBarHeight = bounds.height * 0.18 * (0.4 + 0.6 * clamp(audio.amplitude, 0, 1));
    ctx.save();
    ctx.fillStyle = AUDIO_ACCENT_COLOR;
    ctx.globalAlpha = 0.55;
    for (let i = 0; i < barCount; i++) {
      const mag = clamp(bins[i] ?? 0, 0, 1);
      const h = maxBarHeight * mag;
      ctx.fillRect(bounds.x + i * barWidth, bounds.y + bounds.height - h, barWidth - 1, h);
    }
    ctx.restore();
  }

  /**
   * Compute the alpha-interpolated centroid of a letter's particles into the
   * reused {@link scratch} vector (no per-frame allocation, Requirement 14.3).
   * When `previous` is present and aligned with `current`, each particle is
   * lerped by `alpha` before averaging (Requirement 14.1); otherwise the current
   * positions are averaged directly.
   */
  private interpolatedCentroid(letter: LetterView, alpha: number): Vec2 {
    const cur = letter.current;
    const prev = letter.previous;
    const n = cur.length;
    this.scratch.x = 0;
    this.scratch.y = 0;
    if (n === 0) return this.scratch;

    const canInterpolate = prev !== undefined && prev.length === n;
    let sumX = 0;
    let sumY = 0;
    for (let i = 0; i < n; i++) {
      const c = cur[i]!;
      if (canInterpolate) {
        const p = prev![i]!;
        sumX += lerp(p.x, c.x, alpha);
        sumY += lerp(p.y, c.y, alpha);
      } else {
        sumX += c.x;
        sumY += c.y;
      }
    }
    this.scratch.x = sumX / n;
    this.scratch.y = sumY / n;
    return this.scratch;
  }

  // -------------------------------------------------------------------------
  // One-time texture painting (init only — never per frame).
  // -------------------------------------------------------------------------

  /** Paint the paper-grain texture: a flat paper fill plus seeded ink specks. */
  private paintPaperGrain(buffer: RenderBuffer): void {
    const c = buffer.ctx;
    c.fillStyle = PAPER_BASE_COLOR;
    c.fillRect(0, 0, buffer.width, buffer.height);
    c.fillStyle = PAPER_SPECK_COLOR;
    for (let i = 0; i < PAPER_GRAIN_SPECKS; i++) {
      const x = this.random() * buffer.width;
      const y = this.random() * buffer.height;
      const s = 1 + this.random() * 1.5;
      c.fillRect(x, y, s, s);
    }
  }

  /** Paint the scan-line texture: evenly spaced horizontal translucent lines. */
  private paintScanlines(buffer: RenderBuffer): void {
    const c = buffer.ctx;
    c.clearRect(0, 0, buffer.width, buffer.height);
    c.fillStyle = SCANLINE_COLOR;
    for (let y = 0; y < buffer.height; y += SCANLINE_SPACING_PX) {
      c.fillRect(0, y, buffer.width, 1);
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('Renderer: used after dispose()');
    }
  }
}
