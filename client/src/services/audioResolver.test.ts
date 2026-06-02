import { describe, it, expect, vi } from 'vitest';
import {
  resolveAudio,
  selectAudioStream,
  isProxiedUrl,
  createAudioResolver,
  type PipedAudioStream,
  type PipedStreamsResponse,
} from './audioResolver.ts';
import type { FetchFn } from './fetchWithTimeout.ts';

/** Build a fake `Response` good enough for fetchWithTimeout (.ok/.status/.json). */
function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** A fetch that returns a 200 `/streams` body for any URL. */
function okFetch(body: PipedStreamsResponse): FetchFn {
  return vi.fn(async () => fakeResponse(200, body));
}

const INSTANCE = 'https://pipedapi.kavin.rocks';
const PROXIED_URL = 'https://pipedproxy.kavin.rocks/videoplayback?itag=140';
const PROXIED_URL_2 = 'https://pipedproxy-fra.kavin.rocks/videoplayback?itag=251';
const DIRECT_URL = 'https://rr3---sn-abc.googlevideo.com/videoplayback?itag=140';

function audio(
  url: string,
  bitrate: number,
  videoOnly = false,
): PipedAudioStream {
  return { url, bitrate, videoOnly };
}

describe('isProxiedUrl', () => {
  it('matches an exact host', () => {
    expect(isProxiedUrl('https://pipedapi.kavin.rocks/x', INSTANCE)).toBe(true);
  });

  it('matches a sibling subdomain sharing the registrable domain', () => {
    expect(isProxiedUrl(PROXIED_URL, INSTANCE)).toBe(true);
    expect(isProxiedUrl(PROXIED_URL_2, INSTANCE)).toBe(true);
  });

  it('treats googlevideo direct URLs as not proxied', () => {
    expect(isProxiedUrl(DIRECT_URL, INSTANCE)).toBe(false);
  });

  it('treats unparseable URLs as not proxied', () => {
    expect(isProxiedUrl('not a url', INSTANCE)).toBe(false);
    expect(isProxiedUrl(PROXIED_URL, 'not a url')).toBe(false);
  });
});

describe('selectAudioStream (CORS-preference layered rule)', () => {
  it('filters out videoOnly === true entries', () => {
    const streams = [audio(PROXIED_URL, 128_000, true)];
    expect(selectAudioStream(streams, INSTANCE)).toBeNull();
  });

  it('prefers a proxied URL over a higher-bitrate direct URL (bitrate cost)', () => {
    const streams = [
      audio(DIRECT_URL, 320_000), // higher bitrate, but direct
      audio(PROXIED_URL, 128_000), // lower bitrate, but proxied
    ];
    expect(selectAudioStream(streams, INSTANCE)).toEqual({
      url: PROXIED_URL,
      corsReliable: true,
    });
  });

  it('picks the highest-bitrate proxied URL among proxied candidates', () => {
    const streams = [
      audio(PROXIED_URL, 128_000),
      audio(PROXIED_URL_2, 256_000),
    ];
    expect(selectAudioStream(streams, INSTANCE)).toEqual({
      url: PROXIED_URL_2,
      corsReliable: true,
    });
  });

  it('falls back to the highest-bitrate direct URL when no proxied exists', () => {
    const lowDirect = 'https://rr1---sn-x.googlevideo.com/v?itag=139';
    const streams = [audio(lowDirect, 64_000), audio(DIRECT_URL, 160_000)];
    expect(selectAudioStream(streams, INSTANCE)).toEqual({
      url: DIRECT_URL,
      corsReliable: false,
    });
  });

  it('ignores unparseable stream URLs', () => {
    const streams = [audio('::::bad', 320_000), audio(PROXIED_URL, 96_000)];
    expect(selectAudioStream(streams, INSTANCE)).toEqual({
      url: PROXIED_URL,
      corsReliable: true,
    });
  });

  it('returns null for an empty list', () => {
    expect(selectAudioStream([], INSTANCE)).toBeNull();
  });
});

describe('resolveAudio (multi-instance fallback)', () => {
  it('returns the first usable stream and forwards duration, stopping early', async () => {
    const fetchImpl = okFetch({
      audioStreams: [audio(PROXIED_URL, 128_000)],
      duration: 215,
    });

    const result = await resolveAudio('vid123', [INSTANCE, 'https://second.example'], {
      fetchImpl,
    });

    expect(result).toEqual({
      ok: true,
      streamUrl: PROXIED_URL,
      instanceUsed: INSTANCE,
      corsReliable: true,
      durationSec: 215,
    });
    // Stopped after the first usable instance (Requirement 4.4) — one call only.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('requests the correct {instance}/streams/{videoId} URL without doubling slashes', async () => {
    const fetchImpl = okFetch({ audioStreams: [audio(PROXIED_URL, 96_000)], duration: 10 });

    await resolveAudio('abc', ['https://pipedapi.kavin.rocks/'], { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://pipedapi.kavin.rocks/streams/abc',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('advances past an instance with no usable audioStreams (no_streams)', async () => {
    const fetchImpl: FetchFn = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(200, { audioStreams: [], duration: 5 }))
      .mockResolvedValueOnce(
        fakeResponse(200, { audioStreams: [audio(PROXIED_URL, 128_000)], duration: 99 }),
      );

    const result = await resolveAudio('v', ['https://first.example', INSTANCE], { fetchImpl });

    expect(result).toEqual({
      ok: true,
      streamUrl: PROXIED_URL,
      instanceUsed: INSTANCE,
      corsReliable: true,
      durationSec: 99,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('maps a non-2xx (http) failure to outcome "error" and advances', async () => {
    const fetchImpl: FetchFn = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(503, null))
      .mockResolvedValueOnce(
        fakeResponse(200, { audioStreams: [audio(DIRECT_URL, 160_000)], duration: 7 }),
      );

    const result = await resolveAudio('v', ['https://a.example', 'https://b.example'], {
      fetchImpl,
    });

    expect(result).toEqual({
      ok: true,
      streamUrl: DIRECT_URL,
      instanceUsed: 'https://b.example',
      corsReliable: false,
      durationSec: 7,
    });
  });

  it('reports all_instances_failed with one attempt per instance in order', async () => {
    // a -> network error, b -> 404 (http), c -> 200 but empty streams.
    const fetchImpl: FetchFn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('connection refused'))
      .mockResolvedValueOnce(fakeResponse(404, null))
      .mockResolvedValueOnce(fakeResponse(200, { audioStreams: [], duration: 0 }));

    const result = await resolveAudio(
      'v',
      ['https://a.example', 'https://b.example', 'https://c.example'],
      { fetchImpl },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'all_instances_failed',
      attempts: [
        { instance: 'https://a.example', outcome: 'error' },
        { instance: 'https://b.example', outcome: 'error' },
        { instance: 'https://c.example', outcome: 'no_streams' },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('returns all_instances_failed with no attempts for an empty instance list', async () => {
    const fetchImpl = okFetch({ audioStreams: [], duration: 0 });
    const result = await resolveAudio('v', [], { fetchImpl });
    expect(result).toEqual({ ok: false, reason: 'all_instances_failed', attempts: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('createAudioResolver exposes the design resolve(videoId, instances) signature', async () => {
    const fetchImpl = okFetch({ audioStreams: [audio(PROXIED_URL, 100_000)], duration: 42 });
    const resolver = createAudioResolver({ fetchImpl });

    const result = await resolver.resolve('v', [INSTANCE]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.instanceUsed).toBe(INSTANCE);
      expect(result.durationSec).toBe(42);
    }
  });
});
