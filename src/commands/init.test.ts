import { afterEach, describe, expect, test, vi } from 'vitest';

// Mock dependencies that require package.json
vi.mock('../analytics.js', () => ({
  sendError: vi.fn(),
  trackEvent: vi.fn(),
  closeAnalytics: vi.fn(),
}));

// Mock neon-init
vi.mock('neon-init', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  orchestrate: vi.fn().mockResolvedValue({
    phase: 'setup',
    status: 'complete',
    nextAction: { type: 'complete', message: 'Done' },
  }),
}));

describe('init', () => {
  const exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation((() => undefined) as never);
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(() => true);

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Interactive mode (v1) — no --json, no --agent
  // -------------------------------------------------------------------------

  test('should call init() with no options when agent is omitted', async () => {
    const { handler } = await import('./init.js');
    const { init } = await import('neon-init');

    await handler({});

    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith();
  });

  test('should log error and exit 1 when --agent is invalid (interactive mode)', async () => {
    const { handler } = await import('./init.js');
    const { init, orchestrate } = await import('neon-init');

    await handler({ agent: 'invalid-agent' });

    // When --agent is provided, jsonMode is true, so orchestrate is called with the raw agent string
    expect(orchestrate).toHaveBeenCalledWith({
      agent: 'invalid-agent',
      skipNeonAuth: undefined,
      skipMigrations: undefined,
    });
    expect(init).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Agent/JSON mode (v2) — --json or --agent triggers orchestrate()
  // -------------------------------------------------------------------------

  test('should call orchestrate() when --json is true', async () => {
    const { handler } = await import('./init.js');
    const { orchestrate } = await import('neon-init');

    await handler({ json: true });

    expect(orchestrate).toHaveBeenCalledTimes(1);
    expect(orchestrate).toHaveBeenCalledWith({
      agent: undefined,
      skipNeonAuth: undefined,
      skipMigrations: undefined,
    });
  });

  test('should call orchestrate() when --agent is provided', async () => {
    const { handler } = await import('./init.js');
    const { orchestrate } = await import('neon-init');

    await handler({ agent: 'cursor' });

    expect(orchestrate).toHaveBeenCalledTimes(1);
    expect(orchestrate).toHaveBeenCalledWith({
      agent: 'cursor',
      skipNeonAuth: undefined,
      skipMigrations: undefined,
    });
  });

  test('should pass skip flags to orchestrate()', async () => {
    const { handler } = await import('./init.js');
    const { orchestrate } = await import('neon-init');

    await handler({
      json: true,
      skipNeonAuth: true,
      skipMigrations: true,
    });

    expect(orchestrate).toHaveBeenCalledWith({
      agent: undefined,
      skipNeonAuth: true,
      skipMigrations: true,
    });
  });

  test('should output JSON from orchestrate result', async () => {
    const { handler } = await import('./init.js');

    await handler({ json: true });

    expect(stdoutSpy).toHaveBeenCalledWith(
      JSON.stringify(
        {
          phase: 'setup',
          status: 'complete',
          nextAction: { type: 'complete', message: 'Done' },
        },
        null,
        2,
      ) + '\n',
    );
  });

  test('should exit 1 when orchestrate() throws', async () => {
    const { handler } = await import('./init.js');
    const { orchestrate } = await import('neon-init');
    const { sendError } = await import('../analytics.js');

    vi.mocked(orchestrate).mockRejectedValueOnce(new Error('boom'));

    await handler({ json: true });

    expect(sendError).toHaveBeenCalledWith(
      expect.any(Error),
      'NEON_INIT_FAILED',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('should exit 1 when init() throws in interactive mode', async () => {
    const { handler } = await import('./init.js');
    const { init } = await import('neon-init');
    const { sendError } = await import('../analytics.js');

    vi.mocked(init).mockRejectedValueOnce(new Error('boom'));

    await handler({});

    expect(sendError).toHaveBeenCalledWith(
      expect.any(Error),
      'NEON_INIT_FAILED',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
