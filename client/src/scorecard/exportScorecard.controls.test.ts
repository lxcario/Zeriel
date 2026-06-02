// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  copyImageToClipboard,
  downloadImage,
  exportScorecardImage,
  exportWithRetry,
  type ClipboardLike,
} from './exportScorecard.ts';

/**
 * Task 12.3 — FULL unit coverage for the Scorecard export CONTROLS and the
 * transparent export-retry path (Requirements 11.4, 11.5).
 *
 * The light smoke test (`exportScorecard.smoke.test.ts`) only sanity-checks the
 * `toBlob → Promise` wrapping and one retry-after-failure case. This file drives
 * the copy/download controls (11.4) and the retry helper (11.5) end-to-end with
 * INJECTED fakes — no real clipboard, no real downloads, no network.
 */

/** A PNG blob reused across cases. */
function pngBlob(): Blob {
  return new Blob(['png-bytes'], { type: 'image/png' });
}

/** A fake canvas whose `toBlob` yields exactly the given value. */
function fakeCanvas(value: Blob | null): HTMLCanvasElement {
  return {
    toBlob(cb: (blob: Blob | null) => void) {
      cb(value);
    },
  } as unknown as HTMLCanvasElement;
}

let restoreClipboard: (() => void) | undefined;

beforeEach(() => {
  // Make the global async Clipboard API explicitly ABSENT and deterministic
  // (jsdom does not implement it). Cases that need a clipboard inject their own
  // via options, so this only governs the "unavailable" fallbacks.
  const nav = globalThis.navigator as Navigator & { clipboard?: unknown };
  const had = Object.prototype.hasOwnProperty.call(nav, 'clipboard');
  const prev = (nav as { clipboard?: unknown }).clipboard;
  Object.defineProperty(nav, 'clipboard', {
    value: undefined,
    configurable: true,
    writable: true,
  });
  restoreClipboard = () => {
    if (had) {
      Object.defineProperty(nav, 'clipboard', {
        value: prev,
        configurable: true,
        writable: true,
      });
    } else {
      delete (nav as { clipboard?: unknown }).clipboard;
    }
  };
  // Ensure the global ClipboardItem constructor is treated as unavailable too.
  vi.stubGlobal('ClipboardItem', undefined);
});

afterEach(() => {
  restoreClipboard?.();
  restoreClipboard = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('copyImageToClipboard — copy control (Req 11.4)', () => {
  it('writes a ClipboardItem built from the blob and resolves true', async () => {
    const blob = pngBlob();
    const ctorArgs: Array<Record<string, Blob>> = [];
    class FakeClipboardItem {
      readonly data: Record<string, Blob>;
      constructor(items: Record<string, Blob>) {
        this.data = items;
        ctorArgs.push(items);
      }
    }
    const write = vi.fn().mockResolvedValue(undefined);
    const clipboard: ClipboardLike = { write };

    const ok = await copyImageToClipboard(blob, {
      clipboard,
      clipboardItemCtor: FakeClipboardItem as unknown as typeof ClipboardItem,
    });

    expect(ok).toBe(true);
    // write called exactly once, with an array holding our single ClipboardItem.
    expect(write).toHaveBeenCalledTimes(1);
    const items = write.mock.calls[0][0] as unknown[];
    expect(Array.isArray(items)).toBe(true);
    expect(items).toHaveLength(1);
    expect(items[0]).toBeInstanceOf(FakeClipboardItem);
    // The ctor received an object keyed by the blob's MIME type → the blob.
    expect(ctorArgs).toHaveLength(1);
    expect(Object.keys(ctorArgs[0])).toEqual(['image/png']);
    expect(ctorArgs[0]['image/png']).toBe(blob);
  });

  it('resolves false (no throw) when the clipboard is unavailable', async () => {
    const blob = pngBlob();
    // No injected clipboard; the global fallback is absent → graceful false.
    const ok = await copyImageToClipboard(blob, {
      clipboard: undefined,
      clipboardItemCtor: class {
        constructor(_items: Record<string, Blob>) {}
      } as unknown as typeof ClipboardItem,
    });
    expect(ok).toBe(false);
  });

  it('resolves false when the ClipboardItem constructor is unavailable', async () => {
    const blob = pngBlob();
    const write = vi.fn().mockResolvedValue(undefined);
    // Clipboard present, but no ClipboardItem ctor (injected undefined, global
    // stubbed absent) → graceful false without attempting a write.
    const ok = await copyImageToClipboard(blob, {
      clipboard: { write },
      clipboardItemCtor: undefined,
    });
    expect(ok).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('downloadImage — download control (Req 11.4)', () => {
  it('creates a transient anchor, clicks it, cleans up, and revokes the URL', () => {
    const blob = pngBlob();
    const objectUrl = 'blob:fake-object-url';
    const createObjectURL = vi.fn(() => objectUrl);
    const revokeObjectURL = vi.fn();

    // Spy on the real jsdom document so anchor.click() is a no-op and we can
    // observe append/remove of the transient anchor.
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    const appendSpy = vi.spyOn(document.body, 'appendChild');
    const removeSpy = vi.spyOn(document.body, 'removeChild');

    const result = downloadImage(blob, 'scorecard.png', {
      createObjectURL,
      revokeObjectURL,
      doc: document,
    });

    expect(result).toBe(true);
    expect(createObjectURL).toHaveBeenCalledWith(blob);

    // The appended node is our anchor, carrying the filename + object URL.
    const appended = appendSpy.mock.calls[0][0] as HTMLAnchorElement;
    expect(appended).toBeInstanceOf(HTMLAnchorElement);
    expect(appended.download).toBe('scorecard.png');
    expect(appended.getAttribute('href')).toBe(objectUrl);

    // The anchor was clicked once to trigger the download.
    expect(clickSpy).toHaveBeenCalledTimes(1);

    // Cleanup: the same anchor is removed and the object URL is revoked.
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy.mock.calls[0][0]).toBe(appended);
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl);
    expect(document.body.contains(appended)).toBe(false);
  });

  it('returns false (no throw) in a non-DOM environment', () => {
    const blob = pngBlob();
    // Simulate SSR/node: no document and no object-URL factory at all.
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('URL', undefined);
    try {
      const result = downloadImage(blob, 'scorecard.png', {
        doc: undefined,
        createObjectURL: undefined,
      });
      expect(result).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('exportWithRetry — transparent export retry (Req 11.5)', () => {
  it('retries after the first failure and resolves with the produced Blob', async () => {
    const blob = pngBlob();
    const produce = vi.fn(() => Promise.resolve(blob));
    produce.mockRejectedValueOnce(new Error('first attempt failed'));

    const result = await exportWithRetry(produce, 2);

    // No error surfaced between attempts (transparent retry), just a success.
    expect(result).toBe(blob);
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it('rejects with the LAST error after exhausting all attempts', async () => {
    const blob = pngBlob();
    const lastError = new Error('attempt-3 failed');
    const produce = vi.fn(() => Promise.resolve(blob));
    produce
      .mockRejectedValueOnce(new Error('attempt-1 failed'))
      .mockRejectedValueOnce(new Error('attempt-2 failed'))
      .mockRejectedValueOnce(lastError);

    await expect(exportWithRetry(produce, 3)).rejects.toBe(lastError);
    expect(produce).toHaveBeenCalledTimes(3);
  });
});

describe('exportScorecardImage — the rejection seam used for retry (Req 11.5)', () => {
  it('rejects when toBlob yields null, then resolves on a freshly rendered canvas', async () => {
    // Generation failure: toBlob → null is the seam the UI retries against.
    await expect(exportScorecardImage(fakeCanvas(null))).rejects.toThrow();

    // Re-rendering and exporting again succeeds (the caller simply tries again).
    const blob = pngBlob();
    await expect(exportScorecardImage(fakeCanvas(blob))).resolves.toBe(blob);
  });
});
