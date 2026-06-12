import { afterEach, describe, expect, test, vi } from 'vitest';

// Mock dependencies that require package.json
vi.mock('../analytics.js', () => ({
  sendError: vi.fn(),
  trackEvent: vi.fn(),
  closeAnalytics: vi.fn(),
}));

vi.mock('../log.js', () => ({
  log: { error: vi.fn(), info: vi.fn(), warning: vi.fn(), debug: vi.fn() },
}));

// Mock neon-init
vi.mock('neon-init', () => ({
  interactiveInit: vi.fn().mockResolvedValue(undefined),
  orchestrate: vi.fn().mockResolvedValue({ phase: 'complete', status: 'ok' }),
}));

describe('init', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test('should call interactiveInit when --agent is omitted', async () => {
    const { handler } = await import('./init.js');
    const { interactiveInit, orchestrate } = await import('neon-init');

    await handler({});

    expect(interactiveInit).toHaveBeenCalledTimes(1);
    expect(orchestrate).not.toHaveBeenCalled();
  });

  test('should call orchestrate when --agent is passed without a value', async () => {
    const { handler } = await import('./init.js');
    const { interactiveInit, orchestrate } = await import('neon-init');

    await handler({ agent: '' });

    expect(orchestrate).toHaveBeenCalledWith({
      agent: undefined,
      skipNeonAuth: undefined,
      skipMigrations: undefined,
      preview: undefined,
    });
    expect(interactiveInit).not.toHaveBeenCalled();
  });

  test('should call orchestrate with agent "cursor"', async () => {
    const { handler } = await import('./init.js');
    const { interactiveInit, orchestrate } = await import('neon-init');

    await handler({ agent: 'cursor' });

    expect(orchestrate).toHaveBeenCalledWith({
      agent: 'cursor',
      skipNeonAuth: undefined,
      skipMigrations: undefined,
      preview: undefined,
    });
    expect(interactiveInit).not.toHaveBeenCalled();
  });

  test('should pass skipNeonAuth and skipMigrations to orchestrate', async () => {
    const { handler } = await import('./init.js');
    const { orchestrate } = await import('neon-init');

    await handler({
      agent: 'claude',
      skipNeonAuth: true,
      skipMigrations: true,
    });

    expect(orchestrate).toHaveBeenCalledWith({
      agent: 'claude',
      skipNeonAuth: true,
      skipMigrations: true,
      preview: undefined,
    });
  });

  test('should pass preview to interactiveInit', async () => {
    const { handler } = await import('./init.js');
    const { interactiveInit } = await import('neon-init');

    await handler({ preview: true });

    expect(interactiveInit).toHaveBeenCalledWith({ preview: true });
  });
});
