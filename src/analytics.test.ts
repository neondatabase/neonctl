import { beforeEach, describe, expect, it, vi } from 'vitest';

// pkg.ts reads package.json relative to its own file URL, which only exists
// after a build copies it into dist/. Mock it so this test can run on the
// raw source tree.
vi.mock('./pkg.js', () => ({
  default: { version: '0.0.0-test' },
}));

const trackSpy = vi.fn();
const identifySpy = vi.fn();
const closeAndFlushSpy = vi.fn().mockResolvedValue(undefined);

vi.mock('@segment/analytics-node', () => ({
  Analytics: vi.fn().mockImplementation(() => ({
    track: trackSpy,
    identify: identifySpy,
    closeAndFlush: closeAndFlushSpy,
  })),
}));

import { Analytics as MockedAnalytics } from '@segment/analytics-node';

import {
  __resetAnalyticsForTesting,
  analyticsMiddleware,
  closeAnalytics,
  coerceUserId,
  getAnalyticsEventProperties,
  initAnalyticsClientMiddleware,
  sendError,
} from './analytics';

const analyticsCtor = vi.mocked(MockedAnalytics);

const baseArgs = { _: ['projects', 'list'], output: 'json' };

describe('getAnalyticsEventProperties', () => {
  it('emits the agent-readiness signals when present', () => {
    const props = getAnalyticsEventProperties(
      baseArgs,
      {
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        TERM_PROGRAM: 'vscode',
        CURSOR_TRACE_ID: 'trace-xyz',
        NEON_CLIENT_USER_AGENT: 'codex/1.2.3',
        TRACEPARENT: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      },
      false,
    );

    expect(props.ci).toBe(true);
    expect(props.ciProvider).toBe('github-actions');
    // terminalType carries the outer shell; agentHostSource the inner harness.
    expect(props.terminalType).toBe('vscode-or-fork');
    expect(props.agentHostDetected).toBe(true);
    // Cursor wins agentHostSource over the opt-in fallback.
    expect(props.agentHostSource).toBe('cursor');
    expect(props.clientUserAgent).toBe('codex/1.2.3');
    expect(props.traceparent).toEqual({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      parentId: 'b7ad6b7169203331',
      flags: '01',
      sampled: true,
    });
    expect(props.command).toBe('projects list');
    expect(props.flags).toEqual({ output: 'json' });
    expect(props.isTty).toBe(false);
  });

  it('passes through isTty=true when the stream is a TTY', () => {
    const props = getAnalyticsEventProperties(baseArgs, {}, true);
    expect(props.isTty).toBe(true);
  });

  it('omits opt-in fields when their env vars are unset', () => {
    const props = getAnalyticsEventProperties(baseArgs, {}, false);

    expect(props.ciProvider).toBeUndefined();
    expect(props.terminalType).toBeUndefined();
    expect(props.agentHostDetected).toBe(false);
    expect(props.agentHostSource).toBeUndefined();
    expect('clientUserAgent' in props).toBe(false);
    expect('traceparent' in props).toBe(false);
  });

  it('drops malformed traceparent silently rather than passing junk downstream', () => {
    const props = getAnalyticsEventProperties(
      baseArgs,
      { TRACEPARENT: 'totally-not-a-traceparent' },
      false,
    );
    expect('traceparent' in props).toBe(false);
  });

  it('drops oversized traceparent without allocating large split output', () => {
    const props = getAnalyticsEventProperties(
      baseArgs,
      { TRACEPARENT: 'x'.repeat(10_000) },
      false,
    );
    expect('traceparent' in props).toBe(false);
  });

  it('sanitizes oversized clientUserAgent (strip control chars, cap length)', () => {
    const props = getAnalyticsEventProperties(
      baseArgs,
      {
        // 500 chars of 'x' plus a newline and a NUL — should be cleaned + capped to 256.
        NEON_CLIENT_USER_AGENT: 'x'.repeat(500) + '\n\x00',
      },
      false,
    );
    expect(props.clientUserAgent).toBe('x'.repeat(256));
  });

  it('reports agentHostSource = opt-in when only NEON_CLIENT_USER_AGENT is set', () => {
    const props = getAnalyticsEventProperties(
      baseArgs,
      { NEON_CLIENT_USER_AGENT: 'codex/1.2.3' },
      false,
    );
    expect(props.agentHostDetected).toBe(true);
    expect(props.agentHostSource).toBe('opt-in');
  });

  it('does NOT flag plain CI=true as an agent host', () => {
    const props = getAnalyticsEventProperties(
      baseArgs,
      { CI: 'true', GITHUB_ACTIONS: 'true' },
      false,
    );
    expect(props.agentHostDetected).toBe(false);
    expect(props.ciProvider).toBe('github-actions');
  });

  it('flags CLAUDE_CODE_ENTRYPOINT alone as agent (consistency with terminalType)', () => {
    const props = getAnalyticsEventProperties(
      baseArgs,
      { CLAUDE_CODE_ENTRYPOINT: 'cli' },
      false,
    );
    expect(props.agentHostDetected).toBe(true);
    expect(props.agentHostSource).toBe('claude-code');
  });

  it('preserves outer terminal when an agent marker is set', () => {
    // Important for dashboards: "Claude Code on iTerm" must be
    // distinguishable from "Claude Code on VSCode".
    const props = getAnalyticsEventProperties(
      baseArgs,
      { CLAUDECODE: '1', TERM_PROGRAM: 'iTerm.app' },
      false,
    );
    expect(props.terminalType).toBe('iterm');
    expect(props.agentHostSource).toBe('claude-code');
  });
});

describe('analytics opt-out (--no-analytics)', () => {
  beforeEach(() => {
    // Reset module-level state so each test exercises the args.analytics
    // guard from a known starting point, regardless of file-level order.
    __resetAnalyticsForTesting();
    trackSpy.mockClear();
    identifySpy.mockClear();
    closeAndFlushSpy.mockClear();
    analyticsCtor.mockClear();
  });

  it('initAnalyticsClientMiddleware does not throw when the Segment constructor throws', () => {
    analyticsCtor.mockImplementationOnce(() => {
      throw new Error('segment init failed');
    });
    expect(() => {
      initAnalyticsClientMiddleware({ analytics: true });
    }).not.toThrow();
  });

  it('initAnalyticsClientMiddleware does not throw when identify throws', () => {
    identifySpy.mockImplementationOnce(() => {
      throw new Error('segment identify failed');
    });
    expect(() => {
      initAnalyticsClientMiddleware({ analytics: true });
    }).not.toThrow();
  });

  it('initAnalyticsClientMiddleware does NOT instantiate Segment when analytics=false', () => {
    // With state reset, clientInitialized starts false — so the only
    // thing preventing the Analytics constructor from firing is the
    // args.analytics guard. Asserting on the constructor (not just
    // identify/track) makes the contract explicit.
    initAnalyticsClientMiddleware({ analytics: false });
    expect(analyticsCtor).not.toHaveBeenCalled();
    expect(identifySpy).not.toHaveBeenCalled();
  });

  it('analyticsMiddleware does NOT track when analytics=false (even after the client is initialized)', async () => {
    // Initialize first so we're exercising the args.analytics guard
    // inside analyticsMiddleware, not the !client short-circuit — those
    // are two independent defenses and the test should pin both.
    initAnalyticsClientMiddleware({ analytics: true });
    trackSpy.mockClear();
    identifySpy.mockClear();

    await analyticsMiddleware({
      analytics: false,
      configDir: '/tmp/does-not-exist',
      _: ['projects', 'list'],
    });

    expect(trackSpy).not.toHaveBeenCalled();
    expect(identifySpy).not.toHaveBeenCalled();
  });
});

describe('sendError', () => {
  beforeEach(() => {
    __resetAnalyticsForTesting();
    trackSpy.mockClear();
    identifySpy.mockClear();
    // Ensure the analytics client is initialised so sendError has a sink.
    initAnalyticsClientMiddleware({ analytics: true });
  });

  it('attaches env-derived signals to CLI Error events', () => {
    sendError(new Error('boom'), 'API_ERROR');
    expect(trackSpy).toHaveBeenCalledTimes(1);
    const call = trackSpy.mock.calls[0][0] as {
      event: string;
      properties: Record<string, unknown>;
    };
    expect(call.event).toBe('CLI Error');
    // Error-specific fields are still present.
    expect(call.properties.message).toBe('boom');
    expect(call.properties.errCode).toBe('API_ERROR');
    // Env-derived fields are now attached so errors can be sliced by
    // agent / CI environment just like successes.
    expect(call.properties).toHaveProperty('ci');
    expect(call.properties).toHaveProperty('isTty');
    expect(call.properties).toHaveProperty('agentHostDetected');
    expect(call.properties).toHaveProperty('githubEnvVars');
  });

  it('does not throw when the Segment client throws', () => {
    trackSpy.mockImplementationOnce(() => {
      throw new Error('segment network unreachable');
    });
    expect(() => {
      sendError(new Error('boom'), 'API_ERROR');
    }).not.toThrow();
  });
});

describe('coerceUserId', () => {
  it('accepts non-empty trimmed strings', () => {
    expect(coerceUserId('abc')).toBe('abc');
    expect(coerceUserId('  abc  ')).toBe('abc');
    expect(coerceUserId('123')).toBe('123');
  });

  it('accepts finite non-zero numbers as decimal strings', () => {
    expect(coerceUserId(42)).toBe('42');
    expect(coerceUserId(-1)).toBe('-1');
  });

  it('maps falsy / empty / non-finite to anonymous', () => {
    expect(coerceUserId(undefined)).toBe('anonymous');
    expect(coerceUserId(null)).toBe('anonymous');
    expect(coerceUserId(0)).toBe('anonymous');
    expect(coerceUserId('')).toBe('anonymous');
    expect(coerceUserId('   ')).toBe('anonymous');
    expect(coerceUserId(NaN)).toBe('anonymous');
    expect(coerceUserId(Infinity)).toBe('anonymous');
  });

  it('maps non-string / non-number garbage to anonymous (does NOT pass [object Object] etc. through)', () => {
    expect(coerceUserId({})).toBe('anonymous');
    expect(coerceUserId({ id: 1 })).toBe('anonymous');
    expect(coerceUserId([])).toBe('anonymous');
    expect(coerceUserId([1, 2])).toBe('anonymous');
    expect(coerceUserId(true)).toBe('anonymous');
    expect(coerceUserId(false)).toBe('anonymous');
  });
});

describe('closeAnalytics', () => {
  beforeEach(() => {
    __resetAnalyticsForTesting();
    closeAndFlushSpy.mockClear();
    initAnalyticsClientMiddleware({ analytics: true });
  });

  it('does not throw when the Segment flush rejects', async () => {
    closeAndFlushSpy.mockImplementationOnce(() =>
      Promise.reject(new Error('segment flush failed')),
    );
    await expect(closeAnalytics()).resolves.toBeUndefined();
  });
});
