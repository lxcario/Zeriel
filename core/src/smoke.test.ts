import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { CORE_PACKAGE } from './index.js';

describe('toolchain smoke test', () => {
  it('runs unit tests', () => {
    expect(CORE_PACKAGE).toBe('@glitch/core');
  });

  it('runs fast-check property tests with the global numRuns default of 100', () => {
    // Confirms the fast-check global config wired via Vitest setupFiles is active.
    expect(fc.readConfigureGlobal()?.numRuns).toBe(100);

    // A trivial property to prove the property-based harness executes.
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        return a + b === b + a;
      }),
    );
  });
});
