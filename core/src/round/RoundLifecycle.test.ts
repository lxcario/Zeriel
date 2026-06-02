import { describe, it, expect, vi } from 'vitest';
import { RoundLifecycle } from './index.js';

/**
 * Smoke unit tests for task 6.3: the pure Round state machine.
 *
 * These prove the task's behaviors against the design's Round State Machine and
 * Requirements 10.1/10.3/10.4/10.5/10.6/17.4:
 * - the happy path `lobby -> resolving -> ready -> playing -> scoring -> lobby`;
 * - `start()` is rejected as `'not_ready'` from `lobby`/`resolving`/`resolve_failed`
 *   (Requirement 10.5);
 * - the "lyrics ok but audio failed" path routes `resolving -> resolve_failed`
 *   and `start()` stays impossible there (Requirement 17.4);
 * - `retry()` moves `resolve_failed -> resolving`;
 * - `pickDifferentTrack()` moves `ready -> lobby`;
 * - `newRound()` moves `scoring -> lobby` (Requirement 10.6);
 * - `enterScoring(finalize)` runs the finalizer BEFORE the state is observable
 *   as `'scoring'` (Requirement 10.4).
 *
 * The dedicated property tests (6.4 readiness-gated start, 6.5 scored-round
 * audio requirement, 6.6 finalize-before-scorecard) are optional/separate and
 * are NOT written here.
 */

describe('RoundLifecycle (task 6.3)', () => {
  it('starts in lobby', () => {
    expect(new RoundLifecycle().state).toBe('lobby');
  });

  it('walks the happy path lobby -> resolving -> ready -> playing -> scoring -> lobby', () => {
    const rl = new RoundLifecycle();

    expect(rl.selectTrack()).toEqual({ ok: true, state: 'resolving' });
    expect(rl.state).toBe('resolving');

    // 10.1: audio AND lyrics resolved -> ready.
    expect(rl.reportResolution({ audioResolved: true, lyricsResolved: true })).toEqual({
      ok: true,
      state: 'ready',
    });
    expect(rl.state).toBe('ready');
    expect(rl.audioResolved).toBe(true);
    expect(rl.lyricsResolved).toBe(true);

    // 10.1: Host starts -> playing.
    expect(rl.start()).toEqual({ ok: true, state: 'playing' });
    expect(rl.state).toBe('playing');

    // 10.3 + 10.4: enter scoring after finalizing.
    const scoring = rl.enterScoring(() => 'RESULT');
    expect(scoring).toEqual({ ok: true, state: 'scoring', result: 'RESULT' });
    expect(rl.state).toBe('scoring');

    // 10.6: new round -> lobby.
    expect(rl.newRound()).toEqual({ ok: true, state: 'lobby' });
    expect(rl.state).toBe('lobby');
    // Resolution booleans cleared for the next track.
    expect(rl.audioResolved).toBe(false);
    expect(rl.lyricsResolved).toBe(false);
  });

  // --- Requirement 10.5: start is gated on readiness ---

  it('rejects start() from lobby as not_ready without changing state (10.5)', () => {
    const rl = new RoundLifecycle();
    expect(rl.start()).toEqual({ ok: false, reason: 'not_ready', state: 'lobby' });
    expect(rl.state).toBe('lobby');
  });

  it('rejects start() from resolving as not_ready without changing state (10.5)', () => {
    const rl = new RoundLifecycle();
    rl.selectTrack();
    expect(rl.start()).toEqual({ ok: false, reason: 'not_ready', state: 'resolving' });
    expect(rl.state).toBe('resolving');
  });

  it('rejects start() from resolve_failed as not_ready without changing state (10.5)', () => {
    const rl = new RoundLifecycle();
    rl.selectTrack();
    rl.reportResolution({ audioResolved: false, lyricsResolved: false });
    expect(rl.state).toBe('resolve_failed');
    expect(rl.start()).toEqual({ ok: false, reason: 'not_ready', state: 'resolve_failed' });
    expect(rl.state).toBe('resolve_failed');
  });

  // --- Requirement 17.4: lyrics ok but audio failed cannot start a scored round ---

  it('routes resolving -> resolve_failed when audio fails even if lyrics are available, and start() stays impossible (17.4)', () => {
    const rl = new RoundLifecycle();
    rl.selectTrack();

    const res = rl.reportResolution({ audioResolved: false, lyricsResolved: true });
    expect(res).toEqual({ ok: true, state: 'resolve_failed' });
    expect(rl.state).toBe('resolve_failed');
    expect(rl.audioResolved).toBe(false);
    expect(rl.lyricsResolved).toBe(true);

    // A scored round can never start without resolved audio.
    expect(rl.start()).toEqual({ ok: false, reason: 'not_ready', state: 'resolve_failed' });
    expect(rl.state).toBe('resolve_failed');
  });

  it('routes resolving -> resolve_failed when lyrics fail even if audio is available', () => {
    const rl = new RoundLifecycle();
    rl.selectTrack();
    expect(rl.reportResolution({ audioResolved: true, lyricsResolved: false })).toEqual({
      ok: true,
      state: 'resolve_failed',
    });
    expect(rl.state).toBe('resolve_failed');
  });

  // --- retry: resolve_failed -> resolving ---

  it('retries from resolve_failed back to resolving and clears resolution flags', () => {
    const rl = new RoundLifecycle();
    rl.selectTrack();
    rl.reportResolution({ audioResolved: false, lyricsResolved: true });
    expect(rl.lyricsResolved).toBe(true);

    expect(rl.retry()).toEqual({ ok: true, state: 'resolving' });
    expect(rl.state).toBe('resolving');
    expect(rl.audioResolved).toBe(false);
    expect(rl.lyricsResolved).toBe(false);

    // A retry that now resolves both reaches ready and can start.
    rl.reportResolution({ audioResolved: true, lyricsResolved: true });
    expect(rl.state).toBe('ready');
    expect(rl.start()).toEqual({ ok: true, state: 'playing' });
  });

  // --- pick different track: ready -> lobby ---

  it('returns ready -> lobby on pickDifferentTrack and clears resolution flags', () => {
    const rl = new RoundLifecycle();
    rl.selectTrack();
    rl.reportResolution({ audioResolved: true, lyricsResolved: true });
    expect(rl.state).toBe('ready');

    expect(rl.pickDifferentTrack()).toEqual({ ok: true, state: 'lobby' });
    expect(rl.state).toBe('lobby');
    expect(rl.audioResolved).toBe(false);
    expect(rl.lyricsResolved).toBe(false);
  });

  // --- Requirement 10.4: finalize runs before scoring is observable ---

  it('runs the finalizer BEFORE state becomes observable as scoring (10.4)', () => {
    const rl = new RoundLifecycle();
    rl.selectTrack();
    rl.reportResolution({ audioResolved: true, lyricsResolved: true });
    rl.start();
    expect(rl.state).toBe('playing');

    // The finalizer asserts the state is still 'playing' at the moment it runs,
    // proving finalization completes before scoring becomes observable.
    let stateWhenFinalizing: string | undefined;
    const finalize = vi.fn(() => {
      stateWhenFinalizing = rl.state;
      return { totalScore: 42 };
    });

    const result = rl.enterScoring(finalize);

    expect(finalize).toHaveBeenCalledTimes(1);
    expect(stateWhenFinalizing).toBe('playing'); // not yet scoring during finalize
    expect(result).toEqual({ ok: true, state: 'scoring', result: { totalScore: 42 } });
    expect(rl.state).toBe('scoring'); // observable as scoring only AFTER finalize
  });

  it('does not run the finalizer or change state when enterScoring is called off the playing edge', () => {
    const rl = new RoundLifecycle(); // lobby
    const finalize = vi.fn(() => 'should-not-run');

    const result = rl.enterScoring(finalize);

    expect(finalize).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: 'invalid_transition', state: 'lobby' });
    expect(rl.state).toBe('lobby');
  });

  it('stays playing (fail-closed) and notifies no one if the finalizer throws (10.4)', () => {
    const rl = new RoundLifecycle();
    rl.selectTrack();
    rl.reportResolution({ audioResolved: true, lyricsResolved: true });
    rl.start();

    expect(() =>
      rl.enterScoring(() => {
        throw new Error('finalize failed');
      }),
    ).toThrow('finalize failed');
    // State never advanced to scoring, so no client is notified.
    expect(rl.state).toBe('playing');
  });

  // --- illegal transitions are rejected without state change ---

  it('rejects out-of-order transitions as invalid_transition without changing state', () => {
    const rl = new RoundLifecycle(); // lobby

    expect(rl.reportResolution({ audioResolved: true, lyricsResolved: true })).toEqual({
      ok: false,
      reason: 'invalid_transition',
      state: 'lobby',
    });
    expect(rl.retry()).toEqual({ ok: false, reason: 'invalid_transition', state: 'lobby' });
    expect(rl.pickDifferentTrack()).toEqual({
      ok: false,
      reason: 'invalid_transition',
      state: 'lobby',
    });
    expect(rl.newRound()).toEqual({ ok: false, reason: 'invalid_transition', state: 'lobby' });
    expect(rl.state).toBe('lobby');

    // selectTrack twice: the second is invalid from resolving.
    rl.selectTrack();
    expect(rl.selectTrack()).toEqual({
      ok: false,
      reason: 'invalid_transition',
      state: 'resolving',
    });
    expect(rl.state).toBe('resolving');
  });

  it('rejects newRound() from playing as invalid_transition', () => {
    const rl = new RoundLifecycle();
    rl.selectTrack();
    rl.reportResolution({ audioResolved: true, lyricsResolved: true });
    rl.start();
    expect(rl.newRound()).toEqual({
      ok: false,
      reason: 'invalid_transition',
      state: 'playing',
    });
    expect(rl.state).toBe('playing');
  });

  it('supports a second full round after newRound (10.6)', () => {
    const rl = new RoundLifecycle();
    // First round.
    rl.selectTrack();
    rl.reportResolution({ audioResolved: true, lyricsResolved: true });
    rl.start();
    rl.enterScoring(() => undefined);
    expect(rl.newRound()).toEqual({ ok: true, state: 'lobby' });

    // Second round with a newly selected track.
    expect(rl.selectTrack()).toEqual({ ok: true, state: 'resolving' });
    rl.reportResolution({ audioResolved: true, lyricsResolved: true });
    expect(rl.state).toBe('ready');
    expect(rl.start()).toEqual({ ok: true, state: 'playing' });
  });
});
