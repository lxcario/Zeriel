import { describe, it, expect } from 'vitest';
import {
  createWebSocketNetSocket,
  WS_OPEN,
  type BrowserWebSocketLike,
} from './WebSocketNetSocket.ts';

/**
 * Unit tests for the browser `WebSocket` → `NetSocket` adapter factory
 * (task 17.6) using a fake `WebSocket`. They verify pre-OPEN buffering,
 * straight-through sends after OPEN, inbound message coercion, and close
 * handling — with no real connection and no hardcoded endpoint (the URL is
 * passed in).
 */

/** A controllable fake `BrowserWebSocketLike` (handler-property style). */
class FakeWebSocket implements BrowserWebSocketLike {
  readyState = 0; // CONNECTING
  readonly sent: string[] = [];
  closeCalls = 0;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closeCalls++;
  }

  // --- test drivers ---
  fireOpen(): void {
    this.readyState = WS_OPEN;
    this.onopen?.();
  }
  fireMessage(data: unknown): void {
    this.onmessage?.({ data });
  }
  fireClose(): void {
    this.onclose?.();
  }
  fireError(): void {
    this.onerror?.();
  }
}

function makeAdapter(): { socket: ReturnType<typeof createWebSocketNetSocket>; ws: FakeWebSocket } {
  const ws = new FakeWebSocket();
  const socket = createWebSocketNetSocket('wss://example.test/room/ROOM7', {
    createWebSocket: () => ws,
  });
  return { socket, ws };
}

describe('createWebSocketNetSocket (task 17.6)', () => {
  it('opens the injected socket against the supplied URL (no hardcoded endpoint)', () => {
    const ws = new FakeWebSocket();
    let seen = '';
    createWebSocketNetSocket('wss://host.example/abc', {
      createWebSocket: (u: string) => {
        seen = u;
        return ws;
      },
    });
    expect(seen).toBe('wss://host.example/abc');
  });

  it('buffers frames sent before OPEN and flushes them in order on open', () => {
    const { socket, ws } = makeAdapter();
    socket.send('first');
    socket.send('second');
    // Still connecting → nothing written yet.
    expect(ws.sent).toEqual([]);

    ws.fireOpen();
    expect(ws.sent).toEqual(['first', 'second']);
  });

  it('writes straight through once the socket is OPEN', () => {
    const { socket, ws } = makeAdapter();
    ws.fireOpen();
    socket.send('live');
    expect(ws.sent).toEqual(['live']);
  });

  it('delivers inbound messages as strings to the handler', () => {
    const { socket, ws } = makeAdapter();
    const received: string[] = [];
    socket.onMessage((raw) => received.push(raw));

    ws.fireMessage('{"type":"roster"}');
    ws.fireMessage(42); // non-string payloads are coerced to a string.

    expect(received).toEqual(['{"type":"roster"}', '42']);
  });

  it('fires the close handler on a normal close and closes the underlying socket', () => {
    const { socket, ws } = makeAdapter();
    let closed = 0;
    socket.onClose(() => { closed++; });

    socket.close();
    expect(ws.closeCalls).toBe(1);

    ws.fireClose();
    expect(closed).toBe(1);
  });

  it('surfaces a transport error as a single close', () => {
    const { socket, ws } = makeAdapter();
    let closed = 0;
    socket.onClose(() => { closed++; });

    ws.fireError();
    // A subsequent normal close must not double-fire the close handler.
    ws.fireClose();
    expect(closed).toBe(1);
  });
});
