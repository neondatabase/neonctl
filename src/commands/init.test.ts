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
  init: vi.fn().mockResolvedValue(undefined),
}));

describe('init', () => {
  const exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation((() => undefined) as never);

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('should call neon-init with no options when agent is omitted', async () => {
    const { handler } = await import('./init.js');
    const { init } = await import('neon-init');

    await handler({});

    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith(undefined);
  });

  test('should call neon-init with { agent: "Cursor" } when --agent cursor', async () => {
    const { handler } = await import('./init.js');
    const { init } = await import('neon-init');

    await handler({ agent: 'cursor' });

    expect(init).toHaveBeenCalledWith({ agent: 'Cursor' });
  });

  test('should call neon-init with { agent: "VS Code" } when --agent copilot', async () => {
    const { handler } = await import('./init.js');
    const { init } = await import('neon-init');

    await handler({ agent: 'copilot' });

    expect(init).toHaveBeenCalledWith({ agent: 'VS Code' });
  });

  test('should call neon-init with { agent: "Claude CLI" } when --agent claude', async () => {
    const { handler } = await import('./init.js');
    const { init } = await import('neon-init');

    await handler({ agent: 'claude' });

    expect(init).toHaveBeenCalledWith({ agent: 'Claude CLI' });
  });

  test('should log error and exit 1 when --agent is invalid', async () => {
    const { handler } = await import('./init.js');
    const { init } = await import('neon-init');
    const { log } = await import('../log.js');

    await handler({ agent: 'invalid-agent' });

    expect(init).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      'Invalid --agent value: "invalid-agent". Supported: cursor, copilot, claude',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
