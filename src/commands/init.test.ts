import { describe, expect, test, vi } from 'vitest';

// Mock dependencies that require package.json
vi.mock('../analytics.js', () => ({
  sendError: vi.fn(),
  trackEvent: vi.fn(),
  closeAnalytics: vi.fn(),
}));

// Mock neon-init
vi.mock('neon-init', () => ({
  init: vi.fn().mockResolvedValue(undefined),
}));

describe('init', () => {
  test('should call neon-init', async () => {
    const { handler } = await import('./init.js');
    const { init } = await import('neon-init');

    await handler();

    // Verify neon-init was called
    expect(init).toHaveBeenCalledOnce();
  });
});
