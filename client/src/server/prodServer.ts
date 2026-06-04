/**
 * Production HTTP server for a VPS deployment.
 *
 * In dev/preview the music proxy runs as Vite middleware (`vite.config.ts`).
 * That middleware does NOT exist in a plain `vite build` output, so a static
 * host would 404 on `/api/music/*`. This module is the missing piece: a tiny
 * Node `http` server that, on the VPS,
 *   1. serves the built client from `client/dist`, and
 *   2. handles `GET /api/music/search` and `GET /api/music/audio` via the SAME
 *      `handleSearch` / `handleAudio` logic the dev middleware uses.
 *
 * Run it after `npm run build`:
 *   node --import tsx client/src/server/prodServer.ts
 * (or compile to JS). Configure with env: `PORT` (default 8080), `HOST`
 * (default 0.0.0.0 so the VPS is reachable), `YOUTUBE_API_KEY`, `YTDLP_PATH`.
 *
 * Node-only; never part of the browser bundle.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, normalize, resolve, extname } from 'node:path';
import { handleSearch, handleAudio, handleLyrics } from './musicProxy.ts';
import { readEnvKey } from './readEnv.ts';

/** Absolute path to the built client (`client/dist`). */
const DIST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');

/** Minimal content-type table for the static assets a Vite build emits. */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Resolve a request path to a file inside `DIST_DIR`, guarding against path
 * traversal (`..`): the resolved absolute path MUST stay within `DIST_DIR`.
 * Returns `null` for an out-of-root or non-existent file.
 */
function resolveStaticFile(urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const abs = join(DIST_DIR, rel);
  if (abs !== DIST_DIR && !abs.startsWith(DIST_DIR)) return null; // traversal guard
  if (!existsSync(abs)) return null;
  try {
    if (statSync(abs).isDirectory()) return null;
  } catch {
    return null;
  }
  return abs;
}

/** Stream a static file with its content-type, or `false` if it does not exist. */
function serveStatic(urlPath: string, res: ServerResponse): boolean {
  const abs = resolveStaticFile(urlPath);
  if (!abs) return false;
  const type = MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream';
  res.statusCode = 200;
  res.setHeader('Content-Type', type);
  // Vite emits content-hashed asset filenames, so they are safe to cache hard;
  // index.html must stay fresh so a new deploy is picked up.
  if (abs.endsWith('index.html')) {
    res.setHeader('Cache-Control', 'no-cache');
  } else {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
  createReadStream(abs).pipe(res);
  return true;
}

/** Serve `dist/index.html` (SPA fallback for client-side routing). */
function serveIndexHtml(res: ServerResponse): void {
  const indexPath = join(DIST_DIR, 'index.html');
  if (!existsSync(indexPath)) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Build output not found. Run `npm run build` first.');
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  createReadStream(indexPath).pipe(res);
}

/** The request handler: `/api/music/*` → proxy; everything else → static/SPA. */
function createHandler(youtubeApiKey: string | undefined) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url ?? '/';
    const parsed = new URL(url, 'http://localhost');

    if (parsed.pathname === '/api/music/search') {
      void handleSearch(parsed.searchParams.get('q'), youtubeApiKey, res);
      return;
    }
    if (parsed.pathname === '/api/music/audio') {
      void handleAudio(parsed.searchParams.get('id'), req, res);
      return;
    }
    if (parsed.pathname === '/api/music/lyrics') {
      void handleLyrics(parsed.searchParams, res);
      return;
    }
    if (parsed.pathname.startsWith('/api/')) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    // Static asset, else SPA fallback to index.html.
    if (!serveStatic(parsed.pathname, res)) {
      serveIndexHtml(res);
    }
  };
}

/** Start the production server. Reads PORT/HOST/YOUTUBE_API_KEY from env/.env. */
export function startProdServer(): void {
  const port = Number.parseInt(process.env.PORT ?? '8080', 10);
  const host = process.env.HOST ?? '0.0.0.0';
  const youtubeApiKey = readEnvKey('YOUTUBE_API_KEY');

  const server = createServer(createHandler(youtubeApiKey));
  server.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(
      `Zeriel server listening on http://${host}:${port} ` +
        `(serving ${DIST_DIR}; /api/music/* proxy active)`,
    );
  });
}

// Start only when executed directly (not when imported by tests). Compare via
// pathToFileURL so the check is correct on Windows (where argv[1] is a drive
// path, not a file:// URL).
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  startProdServer();
}
