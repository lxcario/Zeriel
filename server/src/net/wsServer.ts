/**
 * `ws` transport adapter (task 16.9) — the ONLY module that imports `ws`.
 *
 * The authoritative {@link GameServer} is transport-agnostic: it routes over the
 * tiny {@link ClientSocket} abstraction and an injected clock/timer. This module
 * is the thin bridge that:
 * 1. adapts a real `ws` `WebSocket` to {@link ClientSocket} ({@link wsClientSocket}), and
 * 2. opens a listening `WebSocketServer` and feeds each accepted connection into
 *    a {@link GameServer} ({@link startWsGameServer}).
 *
 * Keeping `ws` isolated here means all the protocol/routing/broadcast DECISIONS
 * stay unit-testable with fakes (no port is opened in tests). Nothing in this
 * file runs unless {@link startWsGameServer} is explicitly called.
 *
 * ## SECURITY / NETWORK BINDING (flagged per task requirement)
 * This is a network-exposed WebSocket server. Access control is by Room_Code
 * only — there are NO accounts and no auth (Requirement 1.6), which is the
 * design's intended model for a link-joined party game, NOT an oversight.
 *
 * The listener binds to **`127.0.0.1` (loopback) by default**, so out of the box
 * it is reachable only from the local machine and is NOT exposed to the network.
 * Binding to all interfaces (`0.0.0.0`) is possible ONLY by explicitly passing
 * `host: '0.0.0.0'`; doing so publishes an UNAUTHENTICATED service to the
 * network and should be done only behind a trusted proxy / on a trusted network.
 * The chosen `host`/`port` are logged on listen so the operator can see exactly
 * what was bound.
 */

import { WebSocketServer, type WebSocket } from 'ws';
import { GameServer, type GameServerOptions } from './GameServer.js';
import type { ClientSocket } from './ClientSocket.js';

/**
 * Adapt a `ws` `WebSocket` to the server's {@link ClientSocket} abstraction.
 * Inbound frames are coerced to a string (the protocol is JSON text); binary
 * frames are decoded defensively.
 */
export function wsClientSocket(ws: WebSocket): ClientSocket {
  return {
    send: (data: string) => ws.send(data),
    close: () => ws.close(),
    onMessage: (handler: (raw: string) => void) => {
      ws.on('message', (data: unknown) => handler(wsDataToString(data)));
    },
    onClose: (handler: () => void) => {
      ws.on('close', () => handler());
    },
  };
}

/** Coerce a `ws` message payload (string | Buffer | ArrayBuffer | Buffer[]) to text. */
function wsDataToString(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  try {
    return String(data);
  } catch {
    return '';
  }
}

/** Options for {@link startWsGameServer} beyond the core {@link GameServerOptions}. */
export interface WsServerOptions extends GameServerOptions {
  /** TCP port to listen on. */
  port: number;
  /**
   * Host/interface to bind. Defaults to `127.0.0.1` (loopback only). Pass
   * `'0.0.0.0'` to expose to the network — see the security note above; this
   * publishes an UNAUTHENTICATED, Room_Code-gated service.
   */
  host?: string;
}

/** Loopback-only default bind address (NOT exposed to the network). */
export const DEFAULT_BIND_HOST = '127.0.0.1';

/**
 * Result of {@link startWsGameServer}: the constructed authoritative
 * {@link GameServer}, the underlying `ws` server, and the bound host/port (so
 * callers/operators can see exactly what was exposed).
 */
export interface WsGameServerHandle {
  gameServer: GameServer;
  wss: WebSocketServer;
  host: string;
  port: number;
  /** Stop the loop and close the listening socket. */
  close(): Promise<void>;
}

/**
 * Open a listening `ws` WebSocketServer and route every accepted connection into
 * a {@link GameServer}, starting the authoritative ~30Hz loop. This is the only
 * function that actually binds a port; it is never invoked by tests.
 */
export function startWsGameServer(options: WsServerOptions): WsGameServerHandle {
  const host = options.host ?? DEFAULT_BIND_HOST;
  const { port } = options;

  const gameServer = new GameServer(options);
  const wss = new WebSocketServer({ port, host });
  wss.on('connection', (ws: WebSocket) => {
    gameServer.handleConnection(wsClientSocket(ws));
  });
  gameServer.start();

  // eslint-disable-next-line no-console
  console.log(
    `Zeriel Game_Server listening on ws://${host}:${port}` +
      (host === '0.0.0.0'
        ? ' (BOUND TO ALL INTERFACES — unauthenticated, Room_Code-gated)'
        : ' (loopback only)'),
  );

  return {
    gameServer,
    wss,
    host,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        gameServer.stop();
        wss.close(() => resolve());
      }),
  };
}
