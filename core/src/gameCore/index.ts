/**
 * Barrel for the concrete gameplay engine.
 *
 * Exports the runtime {@link GameCore} class (which `implements GameCoreContract`)
 * and the deterministic PRNG used for spawn jitter. Pure module: no
 * DOM/network/audio/React imports.
 */

export { GameCore } from './GameCore.js';
export { mulberry32, type Prng } from './prng.js';
