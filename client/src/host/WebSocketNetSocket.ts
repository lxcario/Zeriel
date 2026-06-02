/**
 * `createWebSocketNetSocket` — a thin, injectable browser-`WebSocket` adapter
 * for the {@link NetSocket} transport the {@link NetClient} (task 17.3) consumes.
 *
 * ## Why this adapter exists (task 17.6)
 * The {@link NetClient} deliberately does NOT depend on `WebSocket` directly — it
 * talks to the tiny {@link NetSocket} interface (`send`/`close`/`onMessage`/
 * `onClose`) so ALL of its protocol/prediction/reconciliation logic stays
 * unit-testable with a fake in-memory socket (see `net/NetClient.test.ts`). The
 * {@link RemoteGameHost} (this module's sibling) is the first production consumer
 * that needs a REAL connection, so it needs exactly one thin thing: an adapter
 * that maps a live browser `WebSocket` onto that {@link NetSocket} surface.
 * Keeping it separate and injectable means:
 *
 * - the `RemoteGameHost` can be exercised in tests with a fake {@link NetSocket}
 *   and never touch a real `WebSocket`, and
 * - this adapter can be exercised in isolation with a fake `WebSocket` (via the
 *   {@link WebSocketNetSocketOptions.createWebSocket} seam) with no real network
 *   and no hardcoded endpoint (the URL is passed in).
 *
 * The adapter is intentionally minimal — it owns no protocol, prediction, or
 * reconciliation logic (all of that lives in the pure codec + {@link NetClient}).
 * Its only real jobs are (1) shuttle frames both directions and (2) buffer
 * outbound frames sent before the socket has finished opening, flushing them in
 * order once `open` fires so an early `join` is never dropped.
 */

import type { NetSocket } from '../net/index.ts';

/** `WebSocket.readyState` value meaning the connection is open and writable. */
export const WS_OPEN = 1;

/**
 * The structural subset of the browser `WebSocket` this adapter uses. The real
 * `WebSocket` satisfies it; tests supply a lightweight fake implementing the
 * same members (handler-property style, mirroring the DOM API). Only the four
 * `on*` handler slots, `send`, `close`, and `readyState` are needed.
 */
export interface BrowserWebSocketLike {
  /** Connection state; {@link WS_OPEN} (1) means writable. */
  readyState: number;
  /** Send a text frame to the server. */
  send(data: string): void;
  /** Begin closing the connection. */
  close(): void;
  /** Invoked once when the connection opens (outbound buffer is flushed here). */
  onopen: ((ev?: unknown) => void) | null;
  /** Invoked for each inbound frame; `ev.data` is the frame payload. */
  onmessage: ((ev: { data: unknown }) => void) | null;
  /** Invoked once when the connection closes. */
  onclose: ((ev?: unknown) => void) | null;
  /** Invoked on a transport error; surfaced to the consumer as a close. */
  onerror: ((ev?: unknown) => void) | null;
}

/** Factory producing a {@link BrowserWebSocketLike} for a URL (injectable for tests). */
export type WebSocketFactory = (url: string) => BrowserWebSocketLike;

/** Options for {@link createWebSocketNetSocket}; the only seam is the WS factory. */
export interface WebSocketNetSocketOptions {
  /**
   * Factory for the underlying socket. Defaults to a real `new WebSocket(url)`.
   * A test injects a fake so the adapter can be driven with no real network.
   */
  createWebSocket?: WebSocketFactory;
}

/** Default factory: a real browser `WebSocket`, isolated at this single boundary. */
function defaultWebSocketFactory(url: string): BrowserWebSocketLike {
  // `as unknown as` isolates DOM-lib structural differences at the one creation
  // boundary; the real `WebSocket` satisfies {@link BrowserWebSocketLike}.
  return new WebSocket(url) as unknown as BrowserWebSocketLike;
}

/**
 * Adapt a browser `WebSocket` (at `url`) to the {@link NetSocket} interface the
 * {@link NetClient} consumes. Pure plumbing, no protocol awareness:
 *
 * - **Outbound** — {@link NetSocket.send} writes straight through once the socket
 *   is {@link WS_OPEN}; frames sent earlier (e.g. a `join` issued immediately on
 *   construction) are queued and flushed in order when `open` fires, so no early
 *   frame is lost. After {@link NetSocket.close} no further frames are sent.
 * - **Inbound** — the socket's `message` events are forwarded to the handler
 *   registered via {@link NetSocket.onMessage}, coerced to a string (the v1 wire
 *   format is JSON text; a non-string payload is stringified defensively).
 * - **Close** — both a normal `close` and a transport `error` resolve to the
 *   single {@link NetSocket.onClose} handler, fired AT MOST ONCE. An explicit
 *   {@link NetSocket.close} that throws still fires it so the consumer always
 *   observes exactly one close.
 *
 * The handler slots are late-bound: {@link NetClient} registers `onMessage` /
 * `onClose` in its constructor, which runs synchronously after this returns and
 * before any event can fire, so no early event is missed.
 *
 * @param url     The WebSocket URL to connect to (no endpoint is hardcoded).
 * @param options Optional injection seam ({@link WebSocketNetSocketOptions.createWebSocket}).
 */
export function createWebSocketNetSocket(
  url: string,
  options: WebSocketNetSocketOptions = {},
): NetSocket {
  const factory = options.createWebSocket ?? defaultWebSocketFactory;
  const ws = factory(url);

  /** Frames sent before the socket opened, flushed in order on `open`. */
  const outbox: string[] = [];
  let messageHandler: ((raw: string) => void) | null = null;
  let closeHandler: (() => void) | null = null;
  let closeRequested = false;
  let closeFired = false;

  /** Fire the close handler exactly once (normal close, error, or throw). */
  const fireClose = (): void => {
    if (closeFired) return;
    closeFired = true;
    closeHandler?.();
  };

  ws.onopen = () => {
    // Flush anything queued before the connection finished opening.
    while (outbox.length > 0 && ws.readyState === WS_OPEN) {
      ws.send(outbox.shift()!);
    }
  };

  ws.onmessage = (ev) => {
    const data = ev?.data;
    messageHandler?.(typeof data === 'string' ? data : String(data));
  };

  ws.onclose = () => fireClose();
  // A transport error is terminal for our purposes; surface it as a close so
  // the NetClient resets its volatile per-connection state.
  ws.onerror = () => fireClose();

  return {
    send(data: string): void {
      if (closeRequested) return;
      if (ws.readyState === WS_OPEN) {
        ws.send(data);
      } else {
        outbox.push(data);
      }
    },
    close(): void {
      if (closeRequested) return;
      closeRequested = true;
      try {
        ws.close();
      } catch {
        // If close() throws (already-closing/closed), still notify exactly once.
        fireClose();
      }
    },
    onMessage(handler: (raw: string) => void): void {
      messageHandler = handler;
    },
    onClose(handler: () => void): void {
      closeHandler = handler;
    },
  };
}
