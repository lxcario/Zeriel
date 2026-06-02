import * as fc from 'fast-check';

// Global default for all fast-check property tests across the monorepo.
// Property tests run a minimum of 100 generated cases unless a test overrides it.
fc.configureGlobal({ numRuns: 100 });
