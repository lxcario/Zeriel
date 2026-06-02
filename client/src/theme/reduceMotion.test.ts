import { describe, it, expect } from 'vitest';
import {
  resolveReduceMotion,
  loadExplicitChoice,
  saveExplicitChoice,
  readPrefersReducedMotion,
  REDUCE_MOTION_STORAGE_KEY,
  PREFERS_REDUCED_MOTION_QUERY,
  type StorageLike,
  type MatchMediaFn,
} from './reduceMotion.ts';

/** In-memory StorageLike for deterministic, browser-free tests. */
function fakeStorage(initial: Record<string, string> = {}): StorageLike & {
  throwOnGet?: boolean;
  throwOnSet?: boolean;
} {
  const map = new Map<string, string>(Object.entries(initial));
  const store = {
    throwOnGet: false,
    throwOnSet: false,
    getItem(key: string): string | null {
      if (store.throwOnGet) throw new Error('blocked');
      return map.has(key) ? (map.get(key) as string) : null;
    },
    setItem(key: string, value: string): void {
      if (store.throwOnSet) throw new Error('blocked');
      map.set(key, value);
    },
  };
  return store;
}

describe('resolveReduceMotion (pure core)', () => {
  it('returns the explicit choice when it is true, ignoring the browser setting (13.3)', () => {
    expect(resolveReduceMotion(true, false)).toBe(true);
    expect(resolveReduceMotion(true, true)).toBe(true);
  });

  it('returns the explicit choice when it is false, ignoring the browser setting (13.3)', () => {
    expect(resolveReduceMotion(false, true)).toBe(false);
    expect(resolveReduceMotion(false, false)).toBe(false);
  });

  it('falls back to the browser setting when there is no explicit choice (13.2)', () => {
    expect(resolveReduceMotion(null, true)).toBe(true);
    expect(resolveReduceMotion(null, false)).toBe(false);
  });
});

describe('loadExplicitChoice', () => {
  it('reads a persisted true', () => {
    const storage = fakeStorage({ [REDUCE_MOTION_STORAGE_KEY]: 'true' });
    expect(loadExplicitChoice(storage)).toBe(true);
  });

  it('reads a persisted false', () => {
    const storage = fakeStorage({ [REDUCE_MOTION_STORAGE_KEY]: 'false' });
    expect(loadExplicitChoice(storage)).toBe(false);
  });

  it('returns null when no choice is stored', () => {
    expect(loadExplicitChoice(fakeStorage())).toBeNull();
  });

  it('returns null for an unrecognized stored value', () => {
    const storage = fakeStorage({ [REDUCE_MOTION_STORAGE_KEY]: 'maybe' });
    expect(loadExplicitChoice(storage)).toBeNull();
  });

  it('returns null when storage is unavailable', () => {
    expect(loadExplicitChoice(null)).toBeNull();
  });

  it('returns null when reading from storage throws', () => {
    const storage = fakeStorage({ [REDUCE_MOTION_STORAGE_KEY]: 'true' });
    storage.throwOnGet = true;
    expect(loadExplicitChoice(storage)).toBeNull();
  });
});

describe('saveExplicitChoice', () => {
  it('persists true as the string "true"', () => {
    const storage = fakeStorage();
    saveExplicitChoice(true, storage);
    expect(storage.getItem(REDUCE_MOTION_STORAGE_KEY)).toBe('true');
  });

  it('persists false as the string "false"', () => {
    const storage = fakeStorage();
    saveExplicitChoice(false, storage);
    expect(storage.getItem(REDUCE_MOTION_STORAGE_KEY)).toBe('false');
  });

  it('round-trips through loadExplicitChoice (persisted choice is respected on later reads, 13.3)', () => {
    const storage = fakeStorage();
    saveExplicitChoice(true, storage);
    expect(loadExplicitChoice(storage)).toBe(true);
    saveExplicitChoice(false, storage);
    expect(loadExplicitChoice(storage)).toBe(false);
  });

  it('does not throw when storage is unavailable', () => {
    expect(() => saveExplicitChoice(true, null)).not.toThrow();
  });

  it('swallows errors when writing to storage throws', () => {
    const storage = fakeStorage();
    storage.throwOnSet = true;
    expect(() => saveExplicitChoice(true, storage)).not.toThrow();
  });
});

describe('readPrefersReducedMotion', () => {
  it('uses the prefers-reduced-motion query and returns matches=true', () => {
    let queried = '';
    const matchMedia: MatchMediaFn = (query) => {
      queried = query;
      return { matches: true };
    };
    expect(readPrefersReducedMotion(matchMedia)).toBe(true);
    expect(queried).toBe(PREFERS_REDUCED_MOTION_QUERY);
  });

  it('returns false when the browser does not request reduced motion', () => {
    const matchMedia: MatchMediaFn = () => ({ matches: false });
    expect(readPrefersReducedMotion(matchMedia)).toBe(false);
  });

  it('returns false when matchMedia is unavailable', () => {
    expect(readPrefersReducedMotion(null)).toBe(false);
  });

  it('returns false when matchMedia throws', () => {
    const matchMedia: MatchMediaFn = () => {
      throw new Error('no matchMedia');
    };
    expect(readPrefersReducedMotion(matchMedia)).toBe(false);
  });
});
