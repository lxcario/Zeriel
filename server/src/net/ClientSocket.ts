/**
 * `ClientSocket` — the minimal transport abstraction the {@link GameServer}
 * routes over (task 16.9).
 *
 * The authoritative server's connection/routing logic depends only on this tiny
 * interface — NOT on `ws` directly — so it can be unit-tested with a fake socket
 * (capture `send`, simulate inbound messages and close) without opening a real
 * WebSocket. The real `ws` adapter ({@link wsClientSocket}) lives alongside and
 * is the only place that imports `ws`, keeping the pure routing decisions
 * separable from the network library (mirrors the dependency-injection pattern
 * of the pure {@link RoomManager} and the client `LocalGameHost`).
 */

/** A monotonically increasing per-connection id assigned by the server. */
export type ConnectionId = number;

/**
 * The transport surface the server needs from one client connection. A real
 * `ws` socket is adapted to this; tests provide a fake implementation.
 */
export interface ClientSocket {
  /** Send a serialized server message frame to this client. */
  send(data: string): void;
  /** Close the connection (e.g. on a fatal protocol violation). */
  close(): void;
  /** Register the inbound-message handler; `raw` is the frame payload. */
  onMessage(handler: (raw: string) => void): void;
  /** Register the close handler, invoked once when the connection ends. */
  onClose(handler: () => void): void;
}
