import { describe, it, expect } from 'vitest';
import {
  parseClientMessage,
  serializeServerMessage,
  type ServerMessage,
} from './protocol.js';

/**
 * Unit tests for the SERVER-side message protocol (de)serialization (task 16.9).
 * The parser is the authoritative server's untrusted-input boundary, so these
 * cover well-formed messages, malformed/hostile input, and the round trip.
 */
describe('parseClientMessage (task 16.9)', () => {
  it('parses a well-formed join (string payload)', () => {
    expect(parseClientMessage('{"type":"join","roomCode":"ABCDEF"}')).toEqual({
      type: 'join',
      roomCode: 'ABCDEF',
    });
  });

  it('carries optional displayName and reconnectToken on join', () => {
    expect(
      parseClientMessage({
        type: 'join',
        roomCode: 'ABCDEF',
        displayName: 'Ada',
        reconnectToken: 'tok1',
      }),
    ).toEqual({ type: 'join', roomCode: 'ABCDEF', displayName: 'Ada', reconnectToken: 'tok1' });
  });

  it('parses cursor / grab / release / startRound', () => {
    expect(parseClientMessage({ type: 'cursor', x: 1.5, y: -2 })).toEqual({
      type: 'cursor',
      x: 1.5,
      y: -2,
    });
    expect(parseClientMessage({ type: 'grab', letterId: 'L:0', clientTick: 7 })).toEqual({
      type: 'grab',
      letterId: 'L:0',
      clientTick: 7,
    });
    expect(parseClientMessage({ type: 'release', letterId: 'L:1' })).toEqual({
      type: 'release',
      letterId: 'L:1',
    });
    expect(parseClientMessage({ type: 'startRound', trackRef: 'vid123' })).toEqual({
      type: 'startRound',
      trackRef: 'vid123',
    });
  });

  it('defaults a missing/invalid grab clientTick to 0', () => {
    expect(parseClientMessage({ type: 'grab', letterId: 'L:0' })).toEqual({
      type: 'grab',
      letterId: 'L:0',
      clientTick: 0,
    });
  });

  it('rejects malformed and hostile payloads with null (never throws)', () => {
    expect(parseClientMessage('not json{')).toBeNull();
    expect(parseClientMessage(null)).toBeNull();
    expect(parseClientMessage(42)).toBeNull();
    expect(parseClientMessage({})).toBeNull();
    expect(parseClientMessage({ type: 'unknown' })).toBeNull();
    expect(parseClientMessage({ type: 'join' })).toBeNull(); // missing roomCode
    expect(parseClientMessage({ type: 'join', roomCode: '' })).toBeNull(); // empty roomCode
    expect(parseClientMessage({ type: 'cursor', x: 'a', y: 1 })).toBeNull();
    expect(parseClientMessage({ type: 'cursor', x: Number.NaN, y: 1 })).toBeNull();
    expect(parseClientMessage({ type: 'grab' })).toBeNull(); // missing letterId
    expect(parseClientMessage({ type: 'release', letterId: 123 })).toBeNull();
    expect(parseClientMessage({ type: 'startRound' })).toBeNull();
  });

  it('round-trips a server message through serialize → JSON.parse', () => {
    const messages: ServerMessage[] = [
      {
        type: 'welcome',
        playerId: 'p1',
        serverClock: 1000,
        roomState: 'lobby',
        reconnectToken: 'rt1',
      },
      {
        type: 'roster',
        players: [{ playerId: 'p1', displayName: 'Ada', isHost: true, connected: true }],
      },
      { type: 'grabResult', letterId: 'L:0', granted: true, ownerId: 'p1' },
      { type: 'roundState', state: 'scoring', result: { trackTitle: 'T', totalScore: 3, contributions: { p1: 3 } } },
    ];
    for (const m of messages) {
      expect(JSON.parse(serializeServerMessage(m))).toEqual(m);
    }
  });
});
