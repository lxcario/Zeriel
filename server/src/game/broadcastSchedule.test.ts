import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  shouldBroadcast,
  broadcastIntervalForHz,
  meetsMinBroadcastRate,
  MAX_BROADCAST_INTERVAL_MS,
} from './broadcastSchedule.js';

/**
 * Unit + property tests for the pure ≥15Hz broadcast-rate decision (task 16.9,
 * Requirements 16.1, 2.4, 9.3). These pin the broadcast cadence guarantees
 * WITHOUT a real timer or socket.
 */
describe('broadcastSchedule (task 16.9)', () => {
  it('always broadcasts the first time (no prior broadcast)', () => {
    expect(shouldBroadcast(null, 0, MAX_BROADCAST_INTERVAL_MS)).toBe(true);
    expect(shouldBroadcast(null, 123456, 1000)).toBe(true);
  });

  it('broadcasts once the interval has elapsed and not before', () => {
    const interval = MAX_BROADCAST_INTERVAL_MS; // ~66.67ms
    expect(shouldBroadcast(1000, 1000 + interval - 1, interval)).toBe(false);
    expect(shouldBroadcast(1000, 1000 + interval, interval)).toBe(true);
    expect(shouldBroadcast(1000, 1000 + interval + 5, interval)).toBe(true);
  });

  it('treats a non-finite now as not-due', () => {
    expect(shouldBroadcast(0, Number.NaN, 10)).toBe(false);
  });

  it('converts a target Hz into the right interval and never exceeds the 15Hz cap', () => {
    expect(broadcastIntervalForHz(30)).toBeCloseTo(1000 / 30, 9);
    expect(broadcastIntervalForHz(15)).toBeCloseTo(MAX_BROADCAST_INTERVAL_MS, 9);
    // Non-positive falls back to the floor.
    expect(broadcastIntervalForHz(0)).toBeCloseTo(MAX_BROADCAST_INTERVAL_MS, 9);
    expect(broadcastIntervalForHz(-5)).toBeCloseTo(MAX_BROADCAST_INTERVAL_MS, 9);
  });

  it('classifies whether a cadence meets the ≥15Hz floor', () => {
    expect(meetsMinBroadcastRate(1000 / 30)).toBe(true); // 30Hz: fine
    expect(meetsMinBroadcastRate(MAX_BROADCAST_INTERVAL_MS)).toBe(true); // exactly 15Hz
    expect(meetsMinBroadcastRate(MAX_BROADCAST_INTERVAL_MS + 1)).toBe(false); // slower than 15Hz
    expect(meetsMinBroadcastRate(0)).toBe(false);
    expect(meetsMinBroadcastRate(Number.NaN)).toBe(false);
  });

  /**
   * Property: a loop that wakes every 1ms and broadcasts whenever
   * {@link shouldBroadcast} says it is due sustains an effective rate of at
   * least 15Hz when the configured interval honors the floor — i.e. consecutive
   * emitted broadcasts are spaced no more than `MAX_BROADCAST_INTERVAL_MS`
   * apart. Integer-millisecond timing keeps the simulation exact (no float
   * drift) so the bound is precise.
   *
   * **Validates: Requirements 16.1, 2.4, 9.3**
   */
  it('sustains ≥15Hz across a simulated run when the interval honors the floor', () => {
    fc.assert(
      fc.property(
        // Integer interval in [1, 66] ms — all at or below the 15Hz ceiling.
        fc.integer({ min: 1, max: 66 }),
        fc.integer({ min: 100, max: 1000 }),
        (intervalMs, durationMs) => {
          expect(meetsMinBroadcastRate(intervalMs)).toBe(true);

          let last: number | null = null;
          let prevEmit: number | null = null;
          for (let now = 0; now <= durationMs; now++) {
            if (shouldBroadcast(last, now, intervalMs)) {
              if (prevEmit !== null) {
                const gap = now - prevEmit;
                // Realized spacing never exceeds the configured interval, which
                // honors the 15Hz ceiling.
                expect(gap).toBeLessThanOrEqual(intervalMs);
                expect(gap).toBeLessThanOrEqual(MAX_BROADCAST_INTERVAL_MS);
              }
              prevEmit = now;
              last = now;
            }
          }
          // At least one broadcast must have been emitted over the run.
          expect(prevEmit).not.toBeNull();
        },
      ),
    );
  });
});
