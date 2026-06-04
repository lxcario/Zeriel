/**
 * Tiny `.env` reader (server-side only).
 *
 * Reads a single key from the workspace-root `.env` (one level up from
 * `client/`), resolved relative to THIS module so it works regardless of the
 * process CWD. Falls back to `process.env`. Used by both the Vite dev/preview
 * middleware (`vite.config.ts`) and the production server (`prodServer.ts`) so
 * the lookup logic lives in one place.
 *
 * Node-only (uses `node:fs`/`node:url`); never imported by the browser bundle.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * Read `key` from the workspace-root `.env`, then `process.env`. Returns
 * `undefined` when the key is absent in both. Surrounding quotes are stripped.
 */
export function readEnvKey(key: string): string | undefined {
  try {
    const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env');
    const content = readFileSync(envPath, 'utf8');
    for (const raw of content.split(/\r?\n/)) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      if (line.slice(0, eq).trim() === key) {
        return line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* no .env present — fall through to process.env */
  }
  return process.env[key];
}
