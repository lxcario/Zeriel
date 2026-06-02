import { describe, it, expect } from 'vitest';
import {
  serializeClientMessage,
  parseServerMessage,
  parseSnapshot,
  type ClientMessage,
} from './protocol.ts';
import type { Snapshot } from '@glitch/core';

/**
 * Unit tests for the CLIENT-side message protocol (de)serialization (task 17.3).
 *
 * The Client SENDS the C→S set ({@link serializeClientMessage}) and RECEIVES the
 * S→C set ({@link parseServerMessage}). The decoder is the Client's untrusted-
 * input boundary, so these cover well-formed messages, malformed/partial frames,
 * the nested {@link Snapshot} validation, and the encode round trip against the
 * server's documented wire shapes. The optional Property tests (17.4/17.5) are
 * separate; these are the example/edge-case coverage.
 */

/** A representative authoritative snapshot for round-trip checks. */
function makeSnapshot(): Snapshot {
  return {
    tick: 42,
    letters: [
      {
        id: 'L:0',
        particles: [
          { x: { x: 1, y: 2 }, prev: { x: 0.5, y: 1.5 } },
          { x: { x: 3, y: 4 }, prev: { x: 2.5, y: 3.5 } },
        ],
        placedSlot: 1,
      },
      { id: 'L:1', particles: [{ x: { x: 9, y: 9 }, prev: { x: 9, y: 9 } }], placedSlot: null },
    ],
    locks: [{ letterId: 'L:0', ownerId: 'p1' }],
    cursors: [{ playerId: 'p1', cursor: { x: 100, y: 200 } }],
    provisionalScore: 3,
  };
}

describe('serializeClientMessage (task 17.3)', () => {
  it('round-trips every C→S message through serialize → JSON.parse', () => {
    const messages: ClientMessage[] = [
      { type: 'join', roomCode: 'ABCDEF' },
      { type: 'join', roomCode: 'ABCDEF', displayName: 'Ada', reconnectToken: 'tok1' },
      { type: 'cursor', x: 1.5, y: -2 },
      { type: 'grab', letterId: 'L:0', clientTick: 7 },
      { type: 'release', letterId: 'L:1' },
      { type: 'startRound', trackRef: 'vid123' },
    ];
    for (const m of messages) {
      expect(JSON.parse(serializeClientMessage(m))).toEqual(m);
    }
  });

  it('produces a string the server parser would accept (shape compatibility)', () => {
    // The exact wire text the server's parseClientMessage consumes.
    expect(serializeClientMessage({ type: 'grab', letterId: 'L:0', clientTick: 3 })).toBe(
      '{"type":"grab","letterId":"L:0","clientTick":3}',
    );
  });
});

describe('parseServerMessage (task 17.3)', () => {
  it('parses a well-formed welcome (string payload)', () => {
    expect(
      parseServerMessage(
        '{"type":"welcome","playerId":"p1","serverClock":1000,"roomState":"lobby","reconnectToken":"rt1"}',
      ),
    ).toEqual({
      type: 'welcome',
      playerId: 'p1',
      serverClock: 1000,
      roomState: 'lobby',
      reconnectToken: 'rt1',
    });
  });

  it('parses roster / grabResult / roundState', () => {
    expect(
      parseServerMessage({
        type: 'roster',
        players: [{ playerId: 'p1', displayName: 'Ada', isHost: true, connected: true }],
      }),
    ).toEqual({
      type: 'roster',
      players: [{ playerId: 'p1', displayName: 'Ada', isHost: true, connected: true }],
    });

    expect(parseServerMessage({ type: 'grabResult', letterId: 'L:0', granted: false, ownerId: 'p2' })).toEqual({
      type: 'grabResult',
      letterId: 'L:0',
      granted: false,
      ownerId: 'p2',
    });

    expect(parseServerMessage({ type: 'grabResult', letterId: 'L:0', granted: true, ownerId: null })).toEqual({
      type: 'grabResult',
      letterId: 'L:0',
      granted: true,
      ownerId: null,
    });

    expect(parseServerMessage({ type: 'roundState', state: 'playing' })).toEqual({
      type: 'roundState',
      state: 'playing',
    });

    expect(
      parseServerMessage({
        type: 'roundState',
        state: 'scoring',
        result: { trackTitle: 'T', totalScore: 3, contributions: { p1: 3 } },
      }),
    ).toEqual({
      type: 'roundState',
      state: 'scoring',
      result: { trackTitle: 'T', totalScore: 3, contributions: { p1: 3 } },
    });
  });

  it('parses and deep-copies a snapshot message (no aliasing into the payload)', () => {
    const snapshot = makeSnapshot();
    const wire = { type: 'snapshot', snapshot };
    const parsed = parseServerMessage(wire);
    expect(parsed).toEqual({ type: 'snapshot', snapshot });

    // Mutating the parsed result must not touch the source payload (deep copy).
    if (parsed && parsed.type === 'snapshot') {
      parsed.snapshot.letters[0]!.particles[0]!.x.x = 999;
      expect(snapshot.letters[0]!.particles[0]!.x.x).toBe(1);
    }
  });

  it('rejects malformed and partial frames with null (never throws)', () => {
    expect(parseServerMessage('not json{')).toBeNull();
    expect(parseServerMessage(null)).toBeNull();
    expect(parseServerMessage(42)).toBeNull();
    expect(parseServerMessage({})).toBeNull();
    expect(parseServerMessage({ type: 'unknown' })).toBeNull();
    // welcome missing fields / bad roomState / non-finite clock.
    expect(parseServerMessage({ type: 'welcome', playerId: 'p1', serverClock: 1, roomState: 'lobby' })).toBeNull();
    expect(
      parseServerMessage({ type: 'welcome', playerId: 'p1', serverClock: 1, roomState: 'nope', reconnectToken: 'r' }),
    ).toBeNull();
    expect(
      parseServerMessage({ type: 'welcome', playerId: 'p1', serverClock: NaN, roomState: 'lobby', reconnectToken: 'r' }),
    ).toBeNull();
    // roster with a bad entry.
    expect(parseServerMessage({ type: 'roster', players: [{ playerId: 'p1' }] })).toBeNull();
    // grabResult with bad fields.
    expect(parseServerMessage({ type: 'grabResult', letterId: 'L:0', granted: 'yes', ownerId: null })).toBeNull();
    // roundState with a malformed result.
    expect(parseServerMessage({ type: 'roundState', state: 'scoring', result: { totalScore: 1 } })).toBeNull();
  });
});

describe('parseSnapshot (task 17.3)', () => {
  it('accepts a valid snapshot and rejects malformed nested fields', () => {
    expect(parseSnapshot(makeSnapshot())).toEqual(makeSnapshot());

    // Non-finite tick / score.
    expect(parseSnapshot({ ...makeSnapshot(), tick: Infinity })).toBeNull();
    expect(parseSnapshot({ ...makeSnapshot(), provisionalScore: NaN })).toBeNull();
    // letters not an array.
    expect(parseSnapshot({ ...makeSnapshot(), letters: 'x' })).toBeNull();
    // a particle missing prev.
    expect(
      parseSnapshot({
        ...makeSnapshot(),
        letters: [{ id: 'L:0', particles: [{ x: { x: 1, y: 2 } }], placedSlot: null }],
      }),
    ).toBeNull();
    // a lock missing ownerId.
    expect(parseSnapshot({ ...makeSnapshot(), locks: [{ letterId: 'L:0' }] })).toBeNull();
    // a cursor with a non-finite coordinate.
    expect(
      parseSnapshot({ ...makeSnapshot(), cursors: [{ playerId: 'p1', cursor: { x: 1, y: NaN } }] }),
    ).toBeNull();
  });
});
