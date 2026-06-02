import { describe, it, expect } from 'vitest';
import {
  buildJoinLink,
  parseJoinLink,
  parseJoinLinkResult,
  JOIN_LINK_QUERY_PARAM,
  FALLBACK_BASE_URL,
  type JoinLinkResult,
} from './joinLink.ts';

/**
 * Unit tests for join-link build/parse (task 16.7).
 *
 * These pin the concrete embedding scheme (`?room=CODE`) and the round-trip
 * guarantee from Requirement 1.2 / design Property 2, plus the parse-result
 * type that composes with the Room Manager's `JoinResult` for the "room not
 * found" path (Requirement 1.4 boundary). The exhaustive fast-check round-trip
 * (Property 2 / task 16.8) is intentionally out of scope here.
 */

describe('buildJoinLink', () => {
  it('embeds the room code as the `room` query parameter (Requirement 1.2)', () => {
    const link = buildJoinLink('AB12CD', 'https://glitch.example/');
    expect(link).toContain(`${JOIN_LINK_QUERY_PARAM}=AB12CD`);
    expect(new URL(link).searchParams.get('room')).toBe('AB12CD');
  });

  it('preserves the base path and other query params', () => {
    const link = buildJoinLink('XYZ', 'https://glitch.example/play?ref=twitter');
    const url = new URL(link);
    expect(url.pathname).toBe('/play');
    expect(url.searchParams.get('ref')).toBe('twitter');
    expect(url.searchParams.get('room')).toBe('XYZ');
  });

  it('replaces an existing room parameter rather than appending a second one', () => {
    const link = buildJoinLink('NEW', 'https://glitch.example/?room=OLD');
    const url = new URL(link);
    expect(url.searchParams.getAll('room')).toEqual(['NEW']);
  });

  it('percent-encodes codes so the value stays URL-safe', () => {
    const link = buildJoinLink('a b&c', 'https://glitch.example/');
    // The raw string must be encoded in the emitted URL...
    expect(link).not.toContain('a b&c');
    // ...but decode losslessly.
    expect(new URL(link).searchParams.get('room')).toBe('a b&c');
  });

  it('falls back to a non-resolving placeholder base when none is provided and no location exists', () => {
    // In the node test environment there is no `globalThis.location`.
    const link = buildJoinLink('CODE');
    expect(link.startsWith(FALLBACK_BASE_URL.replace(/\/$/, ''))).toBe(true);
    expect(parseJoinLink(link)).toBe('CODE');
  });
});

describe('parseJoinLink', () => {
  it('extracts the room code from a link built by buildJoinLink', () => {
    expect(parseJoinLink('https://glitch.example/?room=AB12CD')).toBe('AB12CD');
  });

  it('returns null when the room parameter is absent', () => {
    expect(parseJoinLink('https://glitch.example/')).toBeNull();
    expect(parseJoinLink('https://glitch.example/?ref=x')).toBeNull();
  });

  it('returns null when the room parameter is empty', () => {
    expect(parseJoinLink('https://glitch.example/?room=')).toBeNull();
  });

  it('returns null for a non-parseable URL', () => {
    expect(parseJoinLink('not a url at all')).toBeNull();
  });

  it('tolerates a relative URL by resolving against the fallback base', () => {
    expect(parseJoinLink('/?room=REL123')).toBe('REL123');
  });
});

describe('round trip (Requirement 1.2 / Property 2 examples)', () => {
  const codes = ['AB12CD', 'x', 'ZZZZ', 'a-b_c', 'Code With Space', '日本語', '100%off'];

  for (const code of codes) {
    it(`parseJoinLink(buildJoinLink(${JSON.stringify(code)})) === original`, () => {
      expect(parseJoinLink(buildJoinLink(code, 'https://glitch.example/'))).toBe(code);
    });

    it(`round trips with the default base for ${JSON.stringify(code)}`, () => {
      expect(parseJoinLink(buildJoinLink(code))).toBe(code);
    });
  }
});

describe('parseJoinLinkResult (Requirement 1.4 boundary)', () => {
  it('returns ok with the room code when one is present', () => {
    const result: JoinLinkResult = parseJoinLinkResult('https://glitch.example/?room=AB12CD');
    expect(result).toEqual({ ok: true, roomCode: 'AB12CD' });
  });

  it('returns a no_code result when no room code is present', () => {
    expect(parseJoinLinkResult('https://glitch.example/')).toEqual({
      ok: false,
      reason: 'no_code',
    });
  });

  it('returns a no_code result for an unparseable URL', () => {
    expect(parseJoinLinkResult('::::')).toEqual({ ok: false, reason: 'no_code' });
  });

  it('composes with a built link end to end', () => {
    const link = buildJoinLink('ROUNDTRIP', 'https://glitch.example/');
    const result = parseJoinLinkResult(link);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.roomCode).toBe('ROUNDTRIP');
    }
  });
});
