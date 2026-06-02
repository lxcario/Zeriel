// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  exportScorecardImage,
  exportWithRetry,
} from './exportScorecard.ts';

/**
 * Task 12.1 — LIGHT smoke coverage for the raster export seam (Requirements
 * 11.2, 11.5). The FULL export-controls + retry unit test is the dedicated
 * optional task 12.3; this only sanity-checks the toBlob → Promise wrapping and
 * the transparent-retry helper with fakes.
 */

/** A fake canvas whose `toBlob` returns a Blob, or null a fixed number of times. */
function fakeCanvas(opts: { nullTimes: number }): HTMLCanvasElement {
  let nullsLeft = opts.nullTimes;
  return {
    toBlob(cb: (blob: Blob | null) => void) {
      if (nullsLeft > 0) {
        nullsLeft -= 1;
        cb(null);
      } else {
        cb(new Blob(['png-bytes'], { type: 'image/png' }));
      }
    },
  } as unknown as HTMLCanvasElement;
}

describe('exportScorecardImage (Req 11.2)', () => {
  it('resolves with a Blob produced by canvas.toBlob', async () => {
    const blob = await exportScorecardImage(fakeCanvas({ nullTimes: 0 }));
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/png');
  });

  it('rejects when toBlob yields null (generation failed)', async () => {
    await expect(exportScorecardImage(fakeCanvas({ nullTimes: 1 }))).rejects.toThrow();
  });
});

describe('exportWithRetry — transparent retry (Req 11.5)', () => {
  it('retries after an initial failure and resolves on the next attempt', async () => {
    const canvas = fakeCanvas({ nullTimes: 1 }); // first toBlob null, then ok.
    const blob = await exportWithRetry(() => exportScorecardImage(canvas), 2);
    expect(blob).toBeInstanceOf(Blob);
  });
});
