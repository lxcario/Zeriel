/**
 * Scorecard raster export, copy, and download (task 12.1).
 *
 * Design references:
 * - Requirement 11.2: generate a downloadable raster image of the Scorecard.
 * - Requirement 11.4: provide a control to COPY or DOWNLOAD the exported image.
 * - Requirement 11.5: IF image generation fails, allow the Player to RETRY the
 *   export, and MAY retry WITHOUT requiring an error message.
 * - design.md "Scorecard export uses Canvas `toBlob`".
 *
 * These helpers touch the DOM / clipboard, so they are kept THIN and the
 * effectful collaborators are injectable where reasonable so tests can drive
 * them with fakes (no real network, no real downloads).
 */

/**
 * Convert a canvas to a PNG {@link Blob} via `HTMLCanvasElement.toBlob`
 * (Requirement 11.2). The callback API is wrapped in a Promise; the promise
 * REJECTS when `toBlob` yields `null` (generation failed), which is the seam
 * the UI uses to RETRY (Requirement 11.5) — the caller simply calls this again.
 *
 * @param canvas The (off-screen or on-screen) canvas already painted via
 *   `drawScorecard`, guaranteeing export/on-screen parity (Requirement 11.3).
 * @param type   The image MIME type (defaults to `image/png`).
 * @param quality Optional quality hint for lossy types.
 */
export function exportScorecardImage(
  canvas: HTMLCanvasElement,
  type = 'image/png',
  quality?: number,
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    // Guard: a canvas without toBlob (or a malformed element) is a generation
    // failure the caller can retry against a freshly-rendered canvas.
    if (typeof canvas.toBlob !== 'function') {
      reject(new Error('canvas.toBlob is not available'));
      return;
    }
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Scorecard image generation failed'));
      },
      type,
      quality,
    );
  });
}

/**
 * Retry an async export operation up to `attempts` times, returning the first
 * success (Requirement 11.5). Transparent retry: this does NOT surface or
 * require an error message between attempts — it simply tries again. If every
 * attempt rejects, the final rejection propagates so the caller may decide what
 * (if anything) to show.
 *
 * @param produce A thunk that performs one export attempt (e.g. re-render +
 *   {@link exportScorecardImage}).
 * @param attempts Total attempts to make (default 2: one initial + one retry).
 */
export async function exportWithRetry(
  produce: () => Promise<Blob>,
  attempts = 2,
): Promise<Blob> {
  const total = Math.max(1, Math.floor(attempts));
  let lastError: unknown;
  for (let i = 0; i < total; i += 1) {
    try {
      return await produce();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Scorecard export failed after retries');
}

/** Minimal clipboard surface used by {@link copyImageToClipboard} (injectable). */
export interface ClipboardLike {
  write(items: ClipboardItem[]): Promise<void>;
}

/** Options for {@link copyImageToClipboard}, allowing injected fakes in tests. */
export interface CopyImageOptions {
  /** Clipboard to write to; defaults to `navigator.clipboard`. */
  clipboard?: ClipboardLike;
  /** `ClipboardItem` constructor; defaults to the global. */
  clipboardItemCtor?: typeof ClipboardItem;
}

/**
 * Copy an image {@link Blob} to the system clipboard (Requirement 11.4).
 *
 * Guarded: resolves to `false` (rather than throwing) when the Clipboard API or
 * `ClipboardItem` is unavailable, so the UI can fall back to download without a
 * hard error. Resolves to `true` on a successful write.
 */
export async function copyImageToClipboard(
  blob: Blob,
  options: CopyImageOptions = {},
): Promise<boolean> {
  const clipboard =
    options.clipboard ??
    (typeof navigator !== 'undefined'
      ? (navigator as Navigator & { clipboard?: ClipboardLike }).clipboard
      : undefined);
  const ItemCtor =
    options.clipboardItemCtor ??
    (typeof ClipboardItem !== 'undefined' ? ClipboardItem : undefined);

  if (!clipboard || typeof clipboard.write !== 'function' || !ItemCtor) {
    return false;
  }

  await clipboard.write([new ItemCtor({ [blob.type || 'image/png']: blob })]);
  return true;
}

/** Minimal DOM surface used by {@link downloadImage} (injectable for tests). */
export interface DownloadEnv {
  /** Creates an object URL for a blob; defaults to `URL.createObjectURL`. */
  createObjectURL?: (blob: Blob) => string;
  /** Revokes an object URL; defaults to `URL.revokeObjectURL`. */
  revokeObjectURL?: (url: string) => void;
  /** Document used to create the anchor; defaults to the global `document`. */
  doc?: Document;
}

/**
 * Trigger a browser download of an image {@link Blob} via a transient anchor
 * (Requirement 11.4). Guarded: returns `false` when no DOM/URL APIs are
 * available (e.g. SSR/node) instead of throwing; returns `true` once the
 * download click has been dispatched.
 */
export function downloadImage(
  blob: Blob,
  filename: string,
  env: DownloadEnv = {},
): boolean {
  const doc = env.doc ?? (typeof document !== 'undefined' ? document : undefined);
  const createObjectURL =
    env.createObjectURL ??
    (typeof URL !== 'undefined' ? URL.createObjectURL?.bind(URL) : undefined);
  const revokeObjectURL =
    env.revokeObjectURL ??
    (typeof URL !== 'undefined' ? URL.revokeObjectURL?.bind(URL) : undefined);

  if (!doc || !createObjectURL) return false;

  const url = createObjectURL(blob);
  const anchor = doc.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  doc.body.appendChild(anchor);
  anchor.click();
  doc.body.removeChild(anchor);
  revokeObjectURL?.(url);
  return true;
}
