/**
 * Clock-offset estimation (task 17.1).
 *
 * Design references:
 * - design.md "Networking and Synchronization" → "Clock offset estimation":
 *     On connection the Client runs a handshake: it sends `T_send`, the server
 *     replies with its clock `T_server`, and the Client records `T_receive`.
 *     Then (per research):
 *         latency = (T_receive - T_send) / 2
 *         offset  = (T_server + latency) - T_client
 *     "The Client applies `offset` so its local physics ticks align with the
 *     server timeline. The handshake is repeated a few times and the median
 *     offset is kept to reduce jitter."
 * - Requirement 16.5: "THE Client SHALL estimate its clock offset from the
 *     Game_Server during connection initialization so that local physics ticks
 *     align with the Game_Server timeline."
 *
 * Why this lives in the client `net` layer (not `@glitch/core`):
 * - Clock-offset estimation is a Client-side concern (the Client aligns its
 *   local timeline to the authoritative server). The design places it in the
 *   "Net Client (networking / sync layer)".
 * - BUT it is implemented here as a PURE, DOM/network-free function: every
 *   timestamp is passed in by the caller. There is no `Date.now()`, no
 *   `performance.now()`, and no `WebSocket` reference inside these estimators.
 *   That keeps the math deterministic and directly unit/property testable
 *   (the optional Property 38 in task 17.2), and lets the Net Client (task
 *   17.3) reuse the {@link HandshakeSample} type and feed it real timestamps.
 *
 * ---------------------------------------------------------------------------
 * Chosen `T_client` interpretation and the exact formula
 * ---------------------------------------------------------------------------
 * The design states the two-line form `offset = (T_server + latency) - T_client`
 * but does not pin down which instant `T_client` is sampled at. We choose the
 * standard, well-defined convention used by NTP-style single-shot estimators:
 *
 *     T_client := T_receive   (the offset is computed at the moment of receive)
 *
 * Substituting `latency = (T_receive - T_send) / 2` and `T_client = T_receive`:
 *
 *     offset = T_server + (T_receive - T_send) / 2 - T_receive
 *            = T_server - (T_send + T_receive) / 2
 *
 * So the single-sample offset is the difference between the server's clock
 * (`T_server`, stamped once at the server) and the MIDPOINT of the client's
 * send/receive instants — the client's best estimate of "the client clock at
 * the moment the server stamped `T_server`", assuming a symmetric round trip.
 *
 * ---------------------------------------------------------------------------
 * Sign convention
 * ---------------------------------------------------------------------------
 *     offset ≈ serverClock - clientClock
 *
 * Therefore to map a client timestamp onto the server timeline you ADD the
 * offset (see {@link toServerTime}); to map a server timestamp back to the
 * client clock you SUBTRACT it (see {@link toClientTime}). Callers aligning
 * local physics ticks to the server timeline use {@link toServerTime}.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One handshake round trip, all timestamps in milliseconds on the relevant
 * clock:
 * - `tSend`    — client clock when the handshake request was sent.
 * - `tServer`  — server clock stamped by the server in its reply.
 * - `tReceive` — client clock when the reply was received.
 *
 * `tSend` and `tReceive` are read from the SAME client clock (so their
 * difference is a valid round-trip duration); `tServer` is on the server clock.
 * Exported for reuse by the Net Client (task 17.3).
 */
export interface HandshakeSample {
  tSend: number;
  tServer: number;
  tReceive: number;
}

/** Offset/latency estimate derived from a single handshake sample. */
export interface OffsetEstimate {
  /** `serverClock - clientClock` estimate, in ms (see sign convention). */
  offset: number;
  /** One-way latency estimate `(tReceive - tSend) / 2`, in ms (>= 0). */
  latency: number;
}

/** Aggregate estimate over several handshake samples (median-based). */
export interface AggregateOffsetEstimate extends OffsetEstimate {
  /** Number of samples that contributed to the estimate (>= 1). */
  samples: number;
}

// ---------------------------------------------------------------------------
// Single-sample estimator
// ---------------------------------------------------------------------------

/**
 * Estimate the clock offset and one-way latency from a single handshake sample.
 *
 * Implements the chosen formula (see file header):
 *
 *     latency = (tReceive - tSend) / 2
 *     offset  = tServer - (tSend + tReceive) / 2
 *
 * The `offset` form is algebraically identical to the design's
 * `(tServer + latency) - tReceive`, with `T_client = tReceive`.
 *
 * Pure and deterministic: depends only on its argument.
 *
 * @throws RangeError if any timestamp is not a finite number.
 */
export function estimateOffsetSample(sample: HandshakeSample): OffsetEstimate {
  const { tSend, tServer, tReceive } = sample;
  if (!Number.isFinite(tSend) || !Number.isFinite(tServer) || !Number.isFinite(tReceive)) {
    throw new RangeError('estimateOffsetSample: all timestamps must be finite numbers');
  }

  const latency = (tReceive - tSend) / 2;
  // offset = (tServer + latency) - tReceive  ==  tServer - (tSend + tReceive) / 2
  const offset = tServer - (tSend + tReceive) / 2;
  return { offset, latency };
}

// ---------------------------------------------------------------------------
// Median helper
// ---------------------------------------------------------------------------

/**
 * Median of a non-empty list of numbers.
 *
 * Definition (documented for the even-count case): after sorting ascending,
 * an odd-length list takes the single middle value; an EVEN-length list takes
 * the AVERAGE of the two middle values. Operates on a copy (does not mutate the
 * input).
 *
 * @throws RangeError if `values` is empty.
 */
export function median(values: readonly number[]): number {
  const n = values.length;
  if (n === 0) {
    throw new RangeError('median: cannot take the median of an empty list');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = n >> 1;
  if (n % 2 === 1) {
    // Odd count: the single middle element. `mid` is in-bounds for n >= 1.
    return sorted[mid] as number;
  }
  // Even count: average of the two middle elements (both in-bounds for n >= 2).
  const lo = sorted[mid - 1] as number;
  const hi = sorted[mid] as number;
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Multi-sample aggregator
// ---------------------------------------------------------------------------

/**
 * Aggregate several handshake samples into a single offset/latency estimate,
 * keeping the MEDIAN to reduce jitter (design: "the median offset is kept").
 *
 * Computes the per-sample offset/latency via {@link estimateOffsetSample}, then
 * returns the median offset and the median latency (each taken independently),
 * along with the contributing sample count. Using the median per dimension is
 * robust to the asymmetric-latency outliers a few handshakes can produce.
 *
 * Pure and deterministic. The even-count median rule is defined by
 * {@link median} (average of the two middle values).
 *
 * @throws RangeError if `samples` is empty (a handshake yields >= 1 sample).
 */
export function estimateClockOffset(
  samples: readonly HandshakeSample[],
): AggregateOffsetEstimate {
  if (samples.length === 0) {
    throw new RangeError('estimateClockOffset: requires at least one handshake sample');
  }

  const offsets: number[] = [];
  const latencies: number[] = [];
  for (const sample of samples) {
    const { offset, latency } = estimateOffsetSample(sample);
    offsets.push(offset);
    latencies.push(latency);
  }

  return {
    offset: median(offsets),
    latency: median(latencies),
    samples: samples.length,
  };
}

// ---------------------------------------------------------------------------
// Offset application helpers
// ---------------------------------------------------------------------------

/**
 * Convert a client-clock timestamp onto the server timeline.
 *
 * Given the sign convention `offset ≈ serverClock - clientClock`, the mapping
 * ADDS the offset:
 *
 *     serverTime = clientTimeMs + offset
 *
 * Callers align local physics ticks to the Game_Server timeline by running the
 * tick scheduler against `toServerTime(localClockMs, offset)` (Requirement 16.5).
 *
 * @throws RangeError if either argument is not a finite number.
 */
export function toServerTime(clientTimeMs: number, offset: number): number {
  if (!Number.isFinite(clientTimeMs) || !Number.isFinite(offset)) {
    throw new RangeError('toServerTime: arguments must be finite numbers');
  }
  return clientTimeMs + offset;
}

/**
 * Convert a server-clock timestamp back to the local client timeline — the
 * exact inverse of {@link toServerTime}. SUBTRACTS the offset:
 *
 *     clientTime = serverTimeMs - offset
 *
 * @throws RangeError if either argument is not a finite number.
 */
export function toClientTime(serverTimeMs: number, offset: number): number {
  if (!Number.isFinite(serverTimeMs) || !Number.isFinite(offset)) {
    throw new RangeError('toClientTime: arguments must be finite numbers');
  }
  return serverTimeMs - offset;
}
