import { describe, expect, test } from 'vitest';
import { unzipSync } from 'fflate';
import { zipBundle } from './zip';

describe('zip', () => {
  test('zipBundle round-trips the given entries', () => {
    const entries: Record<string, Uint8Array> = {
      'out.js': new TextEncoder().encode('export default {};'),
      'out.js.map': new TextEncoder().encode('{"version":3}'),
    };
    const back = unzipSync(zipBundle(entries));
    expect(Object.keys(back).sort()).toEqual(['out.js', 'out.js.map']);
    expect(new TextDecoder().decode(back['out.js'])).toBe('export default {};');
  });
});
