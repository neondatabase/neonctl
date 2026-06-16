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
  detectAgent: vi.fn().mockReturnValue(null),
  enrichResponse: vi.fn().mockImplementation((v) => v),
  interactiveInit: vi.fn().mockResolvedValue(undefined),
  orchestrate: vi.fn().mockResolvedValue({ phase: 'complete', status: 'ok' }),
  routeDataStep: vi.fn().mockResolvedValue({ phase: 'complete', status: 'ok' }),
}));

describe('init', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  test('should call interactiveInit when no --agent flag', async () => {
    const { handler } = await import('./init.js');
    const { interactiveInit, orchestrate } = await import('neon-init');

    await handler({});

    expect(interactiveInit).toHaveBeenCalledTimes(1);
    expect(orchestrate).not.toHaveBeenCalled();
  });

  test('should fall through to interactiveInit when --agent is false and detectAgent returns null', async () => {
    const { handler } = await import('./init.js');
    const { interactiveInit, orchestrate } = await import('neon-init');

    await handler({ agent: false });

    expect(interactiveInit).toHaveBeenCalledTimes(1);
    expect(orchestrate).not.toHaveBeenCalled();
  });

  test('should call orchestrate when --agent is true', async () => {
    const { handler } = await import('./init.js');
    const { interactiveInit, orchestrate, detectAgent } = await import(
      'neon-init'
    );
    (detectAgent as ReturnType<typeof vi.fn>).mockReturnValue('cursor');

    await handler({ agent: true });

    expect(orchestrate).toHaveBeenCalledWith({
      agent: 'cursor',
      skipMigrations: undefined,
      preview: undefined,
    });
    expect(interactiveInit).not.toHaveBeenCalled();
  });

  test('should pass skipMigrations to orchestrate', async () => {
    const { handler } = await import('./init.js');
    const { orchestrate, detectAgent } = await import('neon-init');
    (detectAgent as ReturnType<typeof vi.fn>).mockReturnValue('claude');

    await handler({
      agent: true,
      skipMigrations: true,
    });

    expect(orchestrate).toHaveBeenCalledWith({
      agent: 'claude',
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

  test('should pass preview to orchestrate in agent mode', async () => {
    const { handler } = await import('./init.js');
    const { orchestrate, detectAgent } = await import('neon-init');
    (detectAgent as ReturnType<typeof vi.fn>).mockReturnValue('cursor');

    await handler({ agent: true, preview: true });

    expect(orchestrate).toHaveBeenCalledWith({
      agent: 'cursor',
      skipMigrations: undefined,
      preview: true,
    });
  });
});
