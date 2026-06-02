import { describe, it, expect } from 'vitest';
import {
  estimateOffsetSample,
  estimateClockOffset,
  median,
  toServerTime,
  toClientTime,
  type HandshakeSample,
} from './clockOffset.ts';

/**
 * Unit tests for clock-offset estimation (task 17.1).
 *
 * These pin the concrete behavior of the chosen formula and the median
 * aggregation. The optional Property 38 (task 17.2) will cover the
 * timeline-alignment invariant exhaustively with fast-check; here we cover the
 * specific examples, edge cases, and documented contracts.
 *
 * Chosen interpretation (see clockOffset.ts header):
 *   latency = (tReceive - tSend) / 2
 *   offset  = tServer - (tSend + tReceive) / 2   (T_client := tReceive)
 *   sign convention: offset ≈ serverClock - clientClock
 */

describe('estimateOffsetSample', () => {
  it('computes latency as half the round trip', () => {
    // round trip = 100ms => one-way latency = 50ms
    const { latency } = estimateOffsetSample({ tSend: 1000, tServer: 0, tReceive: 1100 });
    expect(latency).toBe(50);
  });

  it('matches the design two-line form (tServer + latency) - tReceive', () => {
    const sample: HandshakeSample = { tSend: 1000, tServer: 5000, tReceive: 1100 };
    const { offset, latency } = estimateOffsetSample(sample);
    // Design form with T_client = tReceive.
    expect(offset).toBe(sample.tServer + latency - sample.tReceive);
    // Collapsed form tServer - midpoint(tSend, tReceive).
    expect(offset).toBe(5000 - (1000 + 1100) / 2);
    expect(offset).toBe(3950);
  });

  it('reports a near-zero offset when the clocks already agree (symmetric trip)', () => {
    // Server clock ticks alongside the client; server stamps at the true midpoint.
    const tSend = 2000;
    const tReceive = 2200; // 200ms round trip
    const trueMidpoint = (tSend + tReceive) / 2; // 2100
    const { offset } = estimateOffsetSample({ tSend, tServer: trueMidpoint, tReceive });
    expect(offset).toBe(0);
  });

  it('is positive when the server clock leads the client clock', () => {
    const { offset } = estimateOffsetSample({ tSend: 0, tServer: 10_000, tReceive: 100 });
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBe(10_000 - 50);
  });

  it('throws on non-finite timestamps', () => {
    expect(() => estimateOffsetSample({ tSend: NaN, tServer: 0, tReceive: 1 })).toThrow(RangeError);
    expect(() => estimateOffsetSample({ tSend: 0, tServer: Infinity, tReceive: 1 })).toThrow(
      RangeError,
    );
  });
});

describe('median', () => {
  it('returns the middle value for an odd-length list', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('averages the two middle values for an even-length list', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([10, 20])).toBe(15);
  });

  it('does not mutate the input array', () => {
    const input = [5, 1, 4, 2, 3];
    const copy = [...input];
    median(input);
    expect(input).toEqual(copy);
  });

  it('handles a single element', () => {
    expect(median([42])).toBe(42);
  });

  it('throws on an empty list', () => {
    expect(() => median([])).toThrow(RangeError);
  });
});

describe('estimateClockOffset', () => {
  it('keeps the median offset across samples to reduce jitter', () => {
    // Three samples with offsets 100, 105, 5000 (last is a latency-spike outlier).
    const samples: HandshakeSample[] = [
      { tSend: 0, tServer: 100, tReceive: 0 }, // offset 100
      { tSend: 0, tServer: 105, tReceive: 0 }, // offset 105
      { tSend: 0, tServer: 5000, tReceive: 0 }, // offset 5000 (outlier)
    ];
    const result = estimateClockOffset(samples);
    expect(result.offset).toBe(105); // median ignores the 5000 outlier
    expect(result.samples).toBe(3);
  });

  it('averages the two middle offsets for an even sample count', () => {
    const samples: HandshakeSample[] = [
      { tSend: 0, tServer: 10, tReceive: 0 }, // offset 10
      { tSend: 0, tServer: 20, tReceive: 0 }, // offset 20
      { tSend: 0, tServer: 30, tReceive: 0 }, // offset 30
      { tSend: 0, tServer: 40, tReceive: 0 }, // offset 40
    ];
    const result = estimateClockOffset(samples);
    expect(result.offset).toBe(25); // (20 + 30) / 2
    expect(result.samples).toBe(4);
  });

  it('returns the median latency independently of the median offset', () => {
    const samples: HandshakeSample[] = [
      { tSend: 0, tServer: 1000, tReceive: 20 }, // latency 10
      { tSend: 0, tServer: 1000, tReceive: 100 }, // latency 50
      { tSend: 0, tServer: 1000, tReceive: 600 }, // latency 300
    ];
    const result = estimateClockOffset(samples);
    expect(result.latency).toBe(50);
  });

  it('agrees with the single-sample estimator for one sample', () => {
    const sample: HandshakeSample = { tSend: 1000, tServer: 5000, tReceive: 1100 };
    const single = estimateOffsetSample(sample);
    const agg = estimateClockOffset([sample]);
    expect(agg.offset).toBe(single.offset);
    expect(agg.latency).toBe(single.latency);
    expect(agg.samples).toBe(1);
  });

  it('throws when given no samples', () => {
    expect(() => estimateClockOffset([])).toThrow(RangeError);
  });
});

describe('toServerTime / toClientTime', () => {
  it('adds the offset to map client time onto the server timeline', () => {
    expect(toServerTime(1000, 250)).toBe(1250);
    expect(toServerTime(1000, -250)).toBe(750);
  });

  it('subtracts the offset to map server time back to the client clock', () => {
    expect(toClientTime(1250, 250)).toBe(1000);
  });

  it('round trips: toClientTime inverts toServerTime', () => {
    const offset = 137.5;
    const clientTime = 9876.5;
    expect(toClientTime(toServerTime(clientTime, offset), offset)).toBe(clientTime);
  });

  it('aligns a client tick to the server timeline using the estimated offset', () => {
    // A handshake where the server clock leads by ~1000ms.
    const sample: HandshakeSample = { tSend: 0, tServer: 1000, tReceive: 0 };
    const { offset } = estimateOffsetSample(sample);
    expect(offset).toBe(1000);
    // A local tick at client-time 500 maps to server-time 1500.
    expect(toServerTime(500, offset)).toBe(1500);
  });

  it('throws on non-finite arguments', () => {
    expect(() => toServerTime(NaN, 0)).toThrow(RangeError);
    expect(() => toClientTime(0, Infinity)).toThrow(RangeError);
  });
});
