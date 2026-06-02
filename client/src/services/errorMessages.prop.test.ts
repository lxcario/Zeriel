import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  mapExternalError,
  type AudioResolveFailure,
  type InstanceAttempt,
  type LyricsFailure,
  type SearchFailure,
  type ExternalServiceFailure,
} from './errorMessages.ts';

/**
 * Property-based test for the external-error-to-message mapping (task 2.10).
 *
 * Property 39: External errors map to actionable, retryable messages.
 * Validates: Requirements 17.1, 17.5.
 *
 * Design ("Correctness Properties" / Property 39): *For any* external-service
 * failure result (Piped, LRCLIB, or search), the UI mapping produces a
 * non-empty actionable message describing the failure and at least one next
 * step, including a retry control for recoverable errors.
 *
 * Strategy: generate ARBITRARY `ExternalServiceFailure` values covering every
 * `reason` variant of all three source types, then assert the universal
 * invariants `mapExternalError` must uphold across the whole input space. The
 * existing `errorMessages.test.ts` pins the concrete per-branch behavior; this
 * file proves the cross-cutting guarantees hold for all inputs. numRuns is left
 * at the global default (100, from vitest.setup.ts).
 */

// --- Generators (constrained to the discriminated-union input space) -------

/** One Piped instance attempt outcome (mirrors the Audio_Resolver result). */
const instanceAttemptArb: fc.Arbitrary<InstanceAttempt> = fc.record({
  instance: fc.webUrl(),
  outcome: fc.constantFrom<InstanceAttempt['outcome']>(
    'ok',
    'error',
    'timeout',
    'no_streams',
  ),
});

/** Audio resolution failure with an arbitrary (possibly empty) attempts array. */
const audioResolveFailureArb: fc.Arbitrary<AudioResolveFailure> = fc.record({
  ok: fc.constant<false>(false),
  reason: fc.constant<'all_instances_failed'>('all_instances_failed'),
  attempts: fc.array(instanceAttemptArb),
});

/** Lyrics failure across both reason literals. */
const lyricsFailureArb: fc.Arbitrary<LyricsFailure> = fc.record({
  ok: fc.constant<false>(false),
  reason: fc.constantFrom<LyricsFailure['reason']>('no_lyrics', 'retrieval_failed'),
});

/**
 * Search failure across all four transport reasons, with an optional status.
 *
 * Built as a `oneof` of two explicitly-typed branches so the value type never
 * carries `status: number | undefined`: one branch omits the `status` key
 * entirely, the other always includes a numeric `status`. This keeps coverage
 * of both the no-status and with-status cases while remaining assignable to
 * `fc.Arbitrary<SearchFailure>` under `exactOptionalPropertyTypes`.
 */
const searchFailureArb: fc.Arbitrary<SearchFailure> = fc.oneof(
  // Without a `status` key (e.g. timeout / network / parse failures).
  fc.record({
    ok: fc.constant<false>(false),
    reason: fc.constantFrom<SearchFailure['reason']>(
      'timeout',
      'network',
      'http',
      'parse',
    ),
  }),
  // With a numeric `status` (e.g. an `http` failure carrying the status code).
  fc.record({
    ok: fc.constant<false>(false),
    reason: fc.constantFrom<SearchFailure['reason']>(
      'timeout',
      'network',
      'http',
      'parse',
    ),
    status: fc.integer({ min: 100, max: 599 }),
  }),
);

/** Any external-service failure (union over the three sources). */
const externalServiceFailureArb: fc.Arbitrary<ExternalServiceFailure> = fc.oneof(
  audioResolveFailureArb,
  lyricsFailureArb,
  searchFailureArb,
);

// --- Property 39 ------------------------------------------------------------

describe('Property 39: External errors map to actionable, retryable messages', () => {
  it('maps every failure to a non-empty actionable message with a retry control when recoverable', () => {
    fc.assert(
      fc.property(externalServiceFailureArb, (failure) => {
        const result = mapExternalError(failure);

        // Requirement 17.1: an actionable message describing the failure.
        expect(result.message.trim().length).toBeGreaterThan(0);

        // Requirement 17.1: always at least one actionable next step.
        expect(result.actions.length).toBeGreaterThan(0);

        // Requirement 17.1: every offered action carries a usable label.
        for (const action of result.actions) {
          expect(action.label.trim().length).toBeGreaterThan(0);
        }

        // Requirement 17.5: recoverable errors expose a retry control.
        if (result.recoverable === true) {
          expect(result.actions.some((a) => a.kind === 'retry')).toBe(true);
        }
      }),
    );
  });
});
