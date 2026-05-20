import { describe, expect, it } from 'vitest';
import { compareSemver, getInstalledVersion } from '../../src/version';

describe('version', () => {
  it('getInstalledVersion reads package.json', () => {
    const v = getInstalledVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('compareSemver orders x.y.z', () => {
    expect(compareSemver('0.1.4', '0.1.3')).toBeGreaterThan(0);
    expect(compareSemver('0.1.3', '0.1.3')).toBe(0);
    expect(compareSemver('0.1.2', '0.1.10')).toBeLessThan(0);
    expect(compareSemver('1.0.0', '0.9.9')).toBeGreaterThan(0);
  });
});
