import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  estimateOffsetSample,
  estimateClockOffset,
  toServerTime,
  toClientTime,
  type HandshakeSample,
} from './clockOffset.ts';

/**
 * Property-based test for clock-offset estimation (task 17.2).
 *
 * Property 38: Clock-offset estimation aligns timelines.
 * Validates: Requirements 16.5.
 *
 * Design ("Correctness Properties" / Property 38): *For any* send, receive, and
 * server timestamps, the estimated offset equals
 * `(server_time + (receive - send)/2) - client_time`, and applying it aligns the
 * Client's local tick timeline with the server's within the measured latency
 * bound. Requirement 16.5: the Client estimates its clock offset during
 * connection init so local physics ticks align with the Game_Server timeline.
 *
 * ---------------------------------------------------------------------------
 * Why a synthetic-world model (instead of re-deriving the formula in the test)
 * ---------------------------------------------------------------------------
 * Asserting `offset === server_time + (receive - send)/2 - client_time` would
 * just restate the implementation and prove nothing about whether the estimator
 * recovers reality. Instead we GENERATE a ground-truth world and check that the
 * estimator inverts it:
 *
 *   - O  — the true offset, defined as `serverClock - clientClock` (ms).
 *   - L  — the true one-way latency (ms, >= 0). The base model is a SYMMETRIC
 *          round trip, so up-leg = down-leg = L.
 *   - tSend — the client clock when the handshake request is sent.
 *
 * From those we construct a handshake sample that is physically consistent with
 * that world (all client-clock instants, plus the server's single stamp):
 *
 *   - tReceive = tSend + 2*L            (symmetric round trip: out L + back L)
 *   - the server stamps its reply when it RECEIVES the request, which on the
 *     symmetric trip happens at the client-clock midpoint tSend + L; the server
 *     clock reads that instant plus the offset, so
 *   - tServer  = (tSend + L) + O
 *
 * Feeding that sample to `estimateOffsetSample` must recover the ground truth:
 *     latency = (tReceive - tSend)/2 = (2L)/2          = L
 *     offset  = tServer - (tSend + tReceive)/2
 *             = (tSend + L + O) - (tSend + L)           = O
 * so the recovered offset/latency equal O/L up to floating-point rounding.
 *
 * ---------------------------------------------------------------------------
 * Bounds and epsilon (avoid float catastrophic cancellation)
 * ---------------------------------------------------------------------------
 * `offset` subtracts two values of similar magnitude (~tSend), so we keep all
 * generated magnitudes finite and bounded to a few-million ms. For magnitudes
 * up to ~1e7, a double's ULP is ~2e-9, and the estimator performs only a
 * handful of additions/subtractions, so the accumulated error is a few ULP. We
 * accept it with a combined absolute+relative tolerance:
 *     |a - b| <= ABS_EPS + REL_EPS * max(|a|, |b|)
 * with ABS_EPS = 1e-6 (covers values near zero) and REL_EPS = 1e-9 (far looser
 * than the true ~1e-15 relative error, but a safe, justified float epsilon — it
 * does NOT weaken the recovery claim to anything physically meaningful).
 *
 * numRuns is left at the global default (100, from vitest.setup.ts). The
 * companion `clockOffset.test.ts` pins concrete examples and edge cases.
 */

// --- Tolerance --------------------------------------------------------------

const ABS_EPS = 1e-6;
const REL_EPS = 1e-9;

/** Combined absolute+relative float tolerance (see file header). */
function approxEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= ABS_EPS + REL_EPS * Math.max(Math.abs(a), Math.abs(b));
}

// --- Generators (bounded, finite magnitudes) --------------------------------

/** True offset O = serverClock - clientClock, bounded to +/- a few million ms. */
const offsetArb = fc.double({
  min: -5_000_000,
  max: 5_000_000,
  noNaN: true,
  noDefaultInfinity: true,
});

/** Client-clock send instant, a bounded non-negative monotonic-clock reading. */
const tSendArb = fc.double({
  min: 0,
  max: 5_000_000,
  noNaN: true,
  noDefaultInfinity: true,
});

/** One-way latency L >= 0, bounded to a few thousand ms. */
const latencyArb = fc.double({
  min: 0,
  max: 5_000,
  noNaN: true,
  noDefaultInfinity: true,
});

/** Arbitrary client timestamp used to exercise the timeline-mapping helpers. */
const clientTimeArb = fc.double({
  min: -5_000_000,
  max: 5_000_000,
  noNaN: true,
  noDefaultInfinity: true,
});

// --- Synthetic-world sample builders ----------------------------------------

/**
 * Build a handshake sample for a SYMMETRIC round trip in a world with true
 * offset `o` and one-way latency `l`, sent at client time `tSend`.
 */
function symmetricSample(o: number, l: number, tSend: number): HandshakeSample {
  return {
    tSend,
    tReceive: tSend + 2 * l, // out-leg l + back-leg l
    tServer: tSend + l + o, // server stamps at the client-midpoint (tSend + l), + offset
  };
}

/**
 * Build a handshake sample for an ASYMMETRIC trip (up-leg `lUp`, down-leg
 * `lDown`). The server still stamps when it RECEIVES the request, i.e. at
 * client time `tSend + lUp`. Such a sample yields a per-sample offset error of
 * `(lUp - lDown)/2` (the classic NTP path-asymmetry error), so it is only used
 * as a minority outlier in the aggregator property below.
 */
function asymmetricSample(
  o: number,
  lUp: number,
  lDown: number,
  tSend: number,
): HandshakeSample {
  return {
    tSend,
    tReceive: tSend + lUp + lDown,
    tServer: tSend + lUp + o,
  };
}

// --- Property 38 ------------------------------------------------------------

describe('Property 38: Clock-offset estimation aligns timelines', () => {
  it('recovers the ground-truth offset and latency from a single symmetric sample', () => {
    fc.assert(
      fc.property(offsetArb, latencyArb, tSendArb, (o, l, tSend) => {
        const sample = symmetricSample(o, l, tSend);
        const { offset, latency } = estimateOffsetSample(sample);

        // The estimator inverts the synthetic world: offset -> O, latency -> L.
        expect(approxEqual(offset, o)).toBe(true);
        expect(approxEqual(latency, l)).toBe(true);
      }),
    );
  });

  it('uses the recovered offset to align a client timestamp onto the server timeline', () => {
    fc.assert(
      fc.property(offsetArb, clientTimeArb, (o, clientTimeMs) => {
        // Timeline mapping: client -> server adds the offset, exactly.
        expect(toServerTime(clientTimeMs, o)).toBe(clientTimeMs + o);

        // toClientTime is the exact inverse of toServerTime (within float eps).
        const roundTrip = toClientTime(toServerTime(clientTimeMs, o), o);
        expect(approxEqual(roundTrip, clientTimeMs)).toBe(true);
      }),
    );
  });

  it('aligns a local tick to the server timeline using the offset recovered from a handshake', () => {
    fc.assert(
      fc.property(offsetArb, latencyArb, tSendArb, clientTimeArb, (o, l, tSend, tick) => {
        // Recover the offset from a handshake, then apply it to an arbitrary
        // local tick time: the aligned time must equal tick + O (the server's
        // view of that instant) up to float epsilon.
        const { offset } = estimateOffsetSample(symmetricSample(o, l, tSend));
        expect(approxEqual(toServerTime(tick, offset), tick + o)).toBe(true);
      }),
    );
  });

  it('recovers the shared offset from many symmetric samples (median is robust to varied latencies)', () => {
    // K samples that all share the SAME ground-truth offset O but have their own
    // send time and (symmetric) latency. Every per-sample offset equals O, so the
    // median offset equals O regardless of sample count or parity.
    const sampleSpecsArb = fc.array(fc.tuple(latencyArb, tSendArb), {
      minLength: 1,
      maxLength: 9,
    });

    fc.assert(
      fc.property(offsetArb, sampleSpecsArb, (o, specs) => {
        const samples = specs.map(([l, tSend]) => symmetricSample(o, l, tSend));
        const { offset, samples: count } = estimateClockOffset(samples);

        expect(count).toBe(samples.length);
        expect(approxEqual(offset, o)).toBe(true);
      }),
    );
  });

  it('keeps the median offset within epsilon of O when a MINORITY of asymmetric outliers are present', () => {
    // Modeling note: clean (symmetric) samples each recover O exactly (mod float);
    // asymmetric samples carry an offset error of (lUp - lDown)/2. We force the
    // clean samples to be a STRICT MAJORITY (asym count <= clean count - 1). With a
    // strict majority of values all ~ O, the median (middle element for odd N, or
    // the average of the two middle elements for even N) is necessarily drawn from
    // the clean block, so the median offset stays within epsilon of O regardless of
    // how extreme the minority outliers are. That is the only guarantee the median
    // provides here, and the only thing we assert.
    const cleanArb = fc.array(fc.tuple(latencyArb, tSendArb), {
      minLength: 1,
      maxLength: 7,
    });
    const asymArb = fc.array(fc.tuple(latencyArb, latencyArb, tSendArb), {
      minLength: 0,
      maxLength: 7,
    });

    fc.assert(
      fc.property(offsetArb, cleanArb, asymArb, (o, cleanSpecs, asymSpecsRaw) => {
        // Enforce a strict majority of clean samples: keep at most (clean - 1) outliers.
        const asymSpecs = asymSpecsRaw.slice(0, Math.max(0, cleanSpecs.length - 1));

        const cleanSamples = cleanSpecs.map(([l, tSend]) => symmetricSample(o, l, tSend));
        const asymSamples = asymSpecs.map(([lUp, lDown, tSend]) =>
          asymmetricSample(o, lUp, lDown, tSend),
        );
        const samples = [...cleanSamples, ...asymSamples];

        const { offset } = estimateClockOffset(samples);
        expect(approxEqual(offset, o)).toBe(true);
      }),
    );
  });
});
