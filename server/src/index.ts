/**
 * @glitch/server — authoritative Node WebSocket Game_Server entry point.
 *
 * Scaffolding only. The Room Manager, authoritative GameCore tick loop, and
 * State Broadcaster are implemented in later tasks. This file exists to anchor
 * the package, prove the `ws` dependency and the shared `@glitch/core` import
 * resolve, and provide a runnable entry point.
 */
import { CORE_PACKAGE } from '@glitch/core';

export function describeServer(): string {
  return `Zeriel Game_Server (scaffold) using ${CORE_PACKAGE}`;
}

// Only log when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  // eslint-disable-next-line no-console
  console.log(describeServer());
}
