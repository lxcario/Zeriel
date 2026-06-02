/**
 * Single-player shell configuration (task 14.1).
 *
 * Central, documented defaults the React UI shell uses to construct a
 * single-player Round: the `GameCore` physics/spawn/placement config, the
 * play-area / canvas size, the ordered Piped instances the Audio_Resolver tries
 * (Requirement 4), and the LRCLIB base the Lyrics_Service queries (Requirement
 * 6). These mirror the authoritative server defaults (`server/src/index.ts`) so
 * single-player and multiplayer share identical gameplay parameters — the
 * design's "single shared `GameCore`" decision applied to configuration.
 *
 * Everything here is plain data so it stays trivially testable and is injectable
 * into {@link buildRoundPlan} for deterministic, network-free tests.
 */

import type { GameConfig, RenderOptions } from '@glitch/core';

/** Play-area / canvas dimensions in pixels. `GameConfig.bounds` matches this. */
export const PLAY_AREA = { width: 800, height: 600 } as const;

/** The single local player's id. Single-player has no lock contention (15.2). */
export const LOCAL_PLAYER_ID = 'local-player';

/** Maximum bounded off-grid offset for the handmade aesthetic (Requirement 12.3). */
export const DEFAULT_OFF_GRID_OFFSET_PX = 6;

/**
 * Ordered Piped instances the Audio_Resolver attempts, each at most once per
 * resolution (Requirement 4.2/4.3). Public privacy-friendly YouTube frontends.
 */
export const DEFAULT_PIPED_INSTANCES: readonly string[] = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.yt',
];

/** LRCLIB base origin queried by the Lyrics_Service (Requirement 6.1). */
export const DEFAULT_LRCLIB_BASE_URL = 'https://lrclib.net';

/**
 * Default authoritative physics/spawn/placement/session config for a
 * single-player Round. Mirrors the server's `defaultGameConfig()` so scoring
 * and ordering are mode-invariant (Requirement 9.7 / 15.3).
 */
export function defaultGameConfig(): GameConfig {
  return {
    gravity: { x: 0, y: 980 },
    damping: 0.98,
    constraintIterations: 8,
    subSteps: 1,
    defaultStiffness: 0.8,
    constraintTolerance: 0.5,
    bounds: { x: 0, y: 0, width: PLAY_AREA.width, height: PLAY_AREA.height },
    restitution: 0.3,
    colliderRadius: 10,
    spawnBand: { x: 0, y: 0, width: PLAY_AREA.width, height: 120 },
    placementTolerance: 24,
    maxPlayers: 8,
    stepMs: 1000 / 30,
  };
}

/** Build the {@link RenderOptions} for the gameplay Renderer from the effective settings. */
export function defaultRenderOptions(reduceMotion: boolean): RenderOptions {
  return { reduceMotion, offGridMaxOffsetPx: DEFAULT_OFF_GRID_OFFSET_PX };
}
