/**
 * Reduce_Motion_Mode resolution and persistence (task 8.1).
 *
 * Design references:
 * - Requirement 13.2: WHEN the Client detects a browser "prefers-reduced-motion"
 *   setting on first visit, enable Reduce_Motion_Mode by default.
 * - Requirement 13.3: provide a user control to toggle Reduce_Motion_Mode, and
 *   persist and respect an explicit Reduce_Motion_Mode choice on subsequent
 *   visits rather than overriding it from the browser setting.
 *
 * Architecture: the testable core is the PURE {@link resolveReduceMotion}
 * function (no DOM, no storage) — it is the primary target of the optional
 * Property 36 test (task 8.2). All DOM / `localStorage` / `matchMedia` access is
 * isolated in clearly separated, individually injectable adapter functions so
 * the pure core can be unit/property tested without a browser. This mirrors the
 * injectable-`fetchImpl` discipline already used by `services/fetchWithTimeout`.
 */

// ---------------------------------------------------------------------------
// Pure core (no DOM, no storage) — the property-test target
// ---------------------------------------------------------------------------

/**
 * Resolve the effective Reduce_Motion_Mode from a stored explicit choice and
 * the browser `prefers-reduced-motion` setting.
 *
 * The explicit choice takes precedence whenever one exists (Requirement 13.3):
 * a persisted `true`/`false` is returned as-is and is NOT overridden by the
 * browser setting. When there is no explicit choice (`null`, e.g. on first
 * visit), the browser setting is used as the default (Requirement 13.2).
 *
 * This function is pure and deterministic — the same inputs always produce the
 * same output — which is what makes it the target of Property 36 (task 8.2).
 *
 * @param explicitChoice - The persisted explicit toggle, or `null` when unset.
 * @param prefersReducedMotion - The browser `prefers-reduced-motion` setting.
 * @returns The effective Reduce_Motion_Mode.
 */
export function resolveReduceMotion(
  explicitChoice: boolean | null,
  prefersReducedMotion: boolean,
): boolean {
  return explicitChoice !== null ? explicitChoice : prefersReducedMotion;
}

// ---------------------------------------------------------------------------
// Adapters: persistence (localStorage), guarded
// ---------------------------------------------------------------------------

/**
 * Stable, documented storage key for the persisted explicit Reduce_Motion_Mode
 * choice (Requirement 13.3). Namespaced under `glitch:` to avoid collisions.
 * The persisted value is the string `"true"` or `"false"`.
 */
export const REDUCE_MOTION_STORAGE_KEY = 'glitch:reduce-motion' as const;

/**
 * Minimal subset of the Web Storage API used by the persistence helpers. The
 * global `localStorage` (`Storage`) is assignable to this; tests can supply a
 * compatible fake without a DOM.
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Safely obtain the global `localStorage`, or `null` when it is unavailable.
 *
 * Accessing `localStorage` can throw (sandboxed iframes, disabled storage) or
 * be entirely absent (Node/SSR). Both cases are guarded so callers degrade to
 * "no explicit choice" rather than crashing.
 */
function getLocalStorage(): StorageLike | null {
  try {
    if (typeof localStorage !== 'undefined' && localStorage !== null) {
      return localStorage;
    }
  } catch {
    // Accessing the property itself threw (e.g. security error) — treat as none.
  }
  return null;
}

/**
 * Read the persisted explicit Reduce_Motion_Mode choice.
 *
 * @param storage - Storage adapter; defaults to the guarded global `localStorage`.
 * @returns `true`/`false` for a stored explicit choice, or `null` when there is
 *   no stored choice, the value is unrecognized, or storage is unavailable/throws.
 */
export function loadExplicitChoice(
  storage: StorageLike | null = getLocalStorage(),
): boolean | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(REDUCE_MOTION_STORAGE_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return null;
  } catch {
    // Reading threw — treat as "no explicit choice".
    return null;
  }
}

/**
 * Persist an explicit Reduce_Motion_Mode choice so it is respected on
 * subsequent visits (Requirement 13.3). Failures are swallowed: persistence is
 * best-effort and must never break the toggle interaction.
 *
 * @param value - The explicit choice to persist.
 * @param storage - Storage adapter; defaults to the guarded global `localStorage`.
 */
export function saveExplicitChoice(
  value: boolean,
  storage: StorageLike | null = getLocalStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(REDUCE_MOTION_STORAGE_KEY, value ? 'true' : 'false');
  } catch {
    // Storage unavailable/quota/security error — best-effort, ignore.
  }
}

// ---------------------------------------------------------------------------
// Adapter: browser prefers-reduced-motion (matchMedia), guarded
// ---------------------------------------------------------------------------

/** The media query used to detect the browser reduce-motion preference. */
export const PREFERS_REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)' as const;

/**
 * Minimal shape of `window.matchMedia` used by {@link readPrefersReducedMotion}.
 * Tests can supply a compatible fake without a DOM.
 */
export type MatchMediaFn = (query: string) => { matches: boolean };

/**
 * Safely obtain `window.matchMedia`, or `null` when it is unavailable
 * (Node/SSR, or very old browsers without the API).
 */
function getMatchMedia(): MatchMediaFn | null {
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return (query: string) => window.matchMedia(query);
    }
  } catch {
    // Accessing `window` threw — treat as unavailable.
  }
  return null;
}

/**
 * Read the browser `prefers-reduced-motion` setting (Requirement 13.2).
 *
 * @param matchMediaImpl - matchMedia adapter; defaults to the guarded
 *   `window.matchMedia`.
 * @returns `true` when the browser requests reduced motion; `false` when it does
 *   not, or when `matchMedia` is unavailable or throws.
 */
export function readPrefersReducedMotion(
  matchMediaImpl: MatchMediaFn | null = getMatchMedia(),
): boolean {
  if (matchMediaImpl === null) return false;
  try {
    return matchMediaImpl(PREFERS_REDUCED_MOTION_QUERY).matches;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Top-level composition
// ---------------------------------------------------------------------------

/**
 * Compute the effective Reduce_Motion_Mode for the current environment by
 * composing the persistence and `matchMedia` adapters through the pure
 * {@link resolveReduceMotion} core (Requirements 13.2, 13.3).
 *
 * Reads the persisted explicit choice (if any) and the browser setting, then
 * lets the explicit choice win when present, otherwise falls back to the
 * browser setting. Safe to call in non-browser environments — it returns
 * `false` when neither storage nor `matchMedia` is available.
 */
export function getEffectiveReduceMotion(): boolean {
  return resolveReduceMotion(loadExplicitChoice(), readPrefersReducedMotion());
}
