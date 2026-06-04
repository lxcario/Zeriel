import { defineConfig, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { handleSearch, handleAudio, handleLyrics } from './src/server/musicProxy.ts';
import { readEnvKey } from './src/server/readEnv.ts';

/**
 * Dev/preview middleware exposing the server-side music proxy at
 * `/api/music/search` and `/api/music/audio`. Running resolution on the server
 * (same origin as the app) sidesteps the browser CORS wall that blocks calling
 * Piped/Invidious/YouTube directly. `YOUTUBE_API_KEY` (from `.env`, loaded
 * server-side only) enables the reliable YouTube Data API search path.
 *
 * This middleware never reaches the browser bundle, so the API key stays
 * server-side and `musicProxy.ts` (Node-only) adds nothing to client JS.
 */
function musicProxyPlugin(youtubeApiKey: string | undefined): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url ?? '';
    if (!url.startsWith('/api/music/')) {
      next();
      return;
    }
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
    next();
  };

  return {
    name: 'zeriel-music-proxy',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => {
  // Read YOUTUBE_API_KEY from the workspace-root .env (server-side only). Used
  // in middleware for the reliable YouTube Data API search path; never exposed
  // to the client bundle.
  const youtubeApiKey = readEnvKey('YOUTUBE_API_KEY');

  return {
    plugins: [react(), tailwindcss(), musicProxyPlugin(youtubeApiKey)],
    server: {
      port: 5173,
    },
  };
});
