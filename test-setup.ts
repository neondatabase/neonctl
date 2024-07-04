import { beforeEach } from 'vitest';

beforeEach(() => {
  process.env.CI = 'true';
  process.argv.push('--no-color');
  process.env.FORCE_COLOR = 'false';
});
