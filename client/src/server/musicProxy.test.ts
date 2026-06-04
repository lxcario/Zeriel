// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  isValidVideoId,
  handleAudio,
  handleSearch,
  cleanTrackMeta,
  rankMusicCandidates,
  type MusicCandidate,
} from './musicProxy.ts';

/**
 * Minimal fake {@link ServerResponse} capturing status, headers, and body so the
 * proxy handlers can be exercised without a real socket. Only the members the
 * handlers touch are implemented.
 */
function fakeRes(): ServerResponse & {
  _status: number;
  _headers: Record<string, string>;
  _body: string;
} {
  const res = {
    statusCode: 200,
    _status: 0,
    _headers: {} as Record<string, string>,
    _body: '',
    setHeader(name: string, value: string) {
      this._headers[name.toLowerCase()] = value;
    },
    end(payload?: string) {
      this._status = this.statusCode;
      if (typeof payload === 'string') this._body = payload;
    },
    on() {
      return this;
    },
  };
  return res as unknown as ServerResponse & {
    _status: number;
    _headers: Record<string, string>;
    _body: string;
  };
}

describe('isValidVideoId', () => {
  it('accepts canonical 11-char YouTube ids', () => {
    expect(isValidVideoId('dQw4w9WgXcQ')).toBe(true);
    expect(isValidVideoId('_-aBcD12345')).toBe(true);
  });

  it('rejects wrong length, empty, and non-string input', () => {
    expect(isValidVideoId('')).toBe(false);
    expect(isValidVideoId('short')).toBe(false);
    expect(isValidVideoId('waytoolongvideoid')).toBe(false);
    expect(isValidVideoId(undefined as unknown as string)).toBe(false);
  });

  it('rejects ids carrying injection / traversal / URL characters', () => {
    // These would be dangerous if interpolated into a subprocess arg or URL.
    expect(isValidVideoId('a b c d e f g')).toBe(false);
    expect(isValidVideoId('../../etc/pw')).toBe(false);
    expect(isValidVideoId('id&rm=-rf;x')).toBe(false);
    expect(isValidVideoId('id?x=1&y=2z')).toBe(false);
  });
});

describe('handleAudio guards', () => {
  it('returns 400 when no video id is provided', async () => {
    const res = fakeRes();
    await handleAudio(null, {} as IncomingMessage, res);
    expect(res._status).toBe(400);
    expect(res._body).toContain('Video id required');
  });

  it('returns 400 for a syntactically invalid id (before any resolution)', async () => {
    const res = fakeRes();
    // An invalid id must be rejected up front (never reaches yt-dlp / network).
    await handleAudio('../../secret', {} as IncomingMessage, res);
    expect(res._status).toBe(400);
    expect(res._body).toContain('Invalid video id');
    // Error responses must not be cached.
    expect(res._headers['cache-control']).toBe('no-store');
  });
});

describe('handleSearch guards', () => {
  it('returns 400 for an empty query without calling any backend', async () => {
    const res = fakeRes();
    await handleSearch('   ', undefined, res);
    expect(res._status).toBe(400);
    expect(res._body).toContain('Query required');
    expect(res._headers['cache-control']).toBe('no-store');
  });
});

describe('cleanTrackMeta (YouTube title/channel -> LRCLIB metadata)', () => {
  it('strips "Artist - Title (Official Video)" and VEVO channel noise', () => {
    expect(cleanTrackMeta('The Weeknd - Blinding Lights (Official Video)', 'TheWeekndVEVO')).toEqual({
      track: 'Blinding Lights',
      artist: 'The Weeknd',
    });
  });

  it('handles nested trademark + multi-parenthetical noise', () => {
    const { track, artist } = cleanTrackMeta(
      'Shakira - Waka Waka (This Time for Africa) (The Official 2010 FIFA World Cup(TM) Song)',
      'shakiraVEVO',
    );
    expect(artist).toBe('Shakira');
    // The song-proper survives; the "Official ... Song" noise group is removed.
    expect(track.toLowerCase()).toContain('waka waka');
    expect(track.toLowerCase()).not.toContain('official');
    expect(track).not.toMatch(/\(tm\)|™/i);
  });

  it('drops a feat. clause and "- Topic" channel suffix', () => {
    expect(cleanTrackMeta('Some Song (feat. Other Artist)', 'Main Artist - Topic')).toEqual({
      track: 'Some Song',
      artist: 'Main Artist',
    });
  });

  it('keeps a plain "Artist - Title" with no noise', () => {
    expect(cleanTrackMeta('Coldplay - Viva La Vida', 'Coldplay')).toEqual({
      track: 'Viva La Vida',
      artist: 'Coldplay',
    });
  });

  it('falls back to raw values rather than returning empty fields', () => {
    const { track, artist } = cleanTrackMeta('(Official Video)', 'ChannelVEVO');
    expect(track.length).toBeGreaterThan(0);
    expect(artist).toBe('Channel');
  });
});

describe('rankMusicCandidates (music-relevance filter + ranking)', () => {
  const mk = (videoId: string, title: string, artist: string, durationSec = 200): MusicCandidate => ({
    videoId,
    title,
    artist,
    durationSec,
  });

  it('excludes reactions, interviews, tutorials, and hour-long loops', () => {
    const list = [
      mk('a', 'Artist - Song (Official Video)', 'ArtistVEVO'),
      mk('b', 'Song REACTION!! omg', 'Some Reactor'),
      mk('c', 'Artist Interview about Song', 'TalkShow'),
      mk('d', 'How to play Song on guitar (tutorial)', 'GuitarGuy'),
      mk('e', 'Song - 1 hour loop', 'Loops', 3600),
    ];
    const out = rankMusicCandidates(list, 'Artist Song');
    const ids = out.map((c) => c.videoId);
    expect(ids).toContain('a');
    expect(ids).not.toContain('b');
    expect(ids).not.toContain('c');
    expect(ids).not.toContain('d');
    expect(ids).not.toContain('e');
  });

  it('ranks the official/VEVO track above a cover/remix', () => {
    const list = [
      mk('cover', 'Song (Acoustic Cover)', 'Coverband'),
      mk('official', 'Artist - Song (Official Music Video)', 'ArtistVEVO'),
      mk('remix', 'Song (DJ Remix)', 'RemixChannel'),
    ];
    const out = rankMusicCandidates(list, 'Artist Song');
    expect(out[0]!.videoId).toBe('official');
  });

  it('drops too-short clips and too-long videos when duration is known', () => {
    const list = [
      mk('short', 'Artist - Song teaser', 'ArtistVEVO', 20),
      mk('ok', 'Artist - Song (Official Audio)', 'ArtistVEVO', 210),
      mk('long', 'Artist - Song extended', 'ArtistVEVO', 60 * 60),
    ];
    const out = rankMusicCandidates(list, 'Artist Song');
    const ids = out.map((c) => c.videoId);
    expect(ids).toEqual(['ok']); // 'short' (teaser) + 'long' both excluded
  });

  it('never returns empty: if everything is filtered, ranks the raw list', () => {
    const list = [
      mk('r1', 'Song REACTION', 'A'),
      mk('r2', 'Song reaction part 2', 'B'),
    ];
    const out = rankMusicCandidates(list, 'Song');
    expect(out.length).toBe(2); // filter would empty it → fall back to ranking all
  });

  it('keeps unknown-duration candidates (duration 0 is not filtered)', () => {
    const list = [mk('x', 'Artist - Song (Official Video)', 'ArtistVEVO', 0)];
    const out = rankMusicCandidates(list, 'Artist Song');
    expect(out.map((c) => c.videoId)).toEqual(['x']);
  });
});
