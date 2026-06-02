/**
 * Barrel for the pure lyric scheduler (task 6.1).
 *
 * Exports the playback-time-driven {@link LyricScheduler} that feeds dropped
 * Lyric_Lines to a sink (the host wires this to `GameCore.spawnLine`). Pure
 * module: no DOM/network/audio/React imports.
 */

export { LyricScheduler, type LyricDropSink } from './LyricScheduler.js';
