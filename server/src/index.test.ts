import { describe, it, expect } from 'vitest';
import { describeServer } from './index.js';

describe('server scaffold', () => {
  it('imports the shared @glitch/core package', () => {
    expect(describeServer()).toContain('@glitch/core');
  });
});
