import { describe, it, expect } from 'vitest';
import {
  detectAgentHostSource,
  detectCiProvider,
  detectTerminalHost,
  getGithubEnvVars,
  isCi,
  parseTraceparent,
  sanitizeClientUserAgent,
} from './env';

describe('getGithubEnvVars', () => {
  it('success all keys', () => {
    const env = {
      GITHUB_ACTION_PATH: '1',
      GITHUB_REPOSITORY: '2',
      GITHUB_RUN_ID: '3',
      GITHUB_RUN_NUMBER: '4',
      GITHUB_SERVER_URL: '5',
      GITHUB_WORKFLOW_REF: '6',
      RUNNER_ARCH: '7',
      RUNNER_ENVIRONMENT: '8',
      RUNNER_OS: '9',
      unrelated: 'unrelated',
    };

    const ret = {
      GITHUB_ACTION_PATH: '1',
      GITHUB_REPOSITORY: '2',
      GITHUB_RUN_ID: '3',
      GITHUB_RUN_NUMBER: '4',
      GITHUB_SERVER_URL: '5',
      GITHUB_WORKFLOW_REF: '6',
      RUNNER_ARCH: '7',
      RUNNER_ENVIRONMENT: '8',
      RUNNER_OS: '9',
    };

    expect(getGithubEnvVars(env)).toEqual(ret);
  });

  it('empty all keys', () => {
    expect(getGithubEnvVars({})).toEqual({});
  });

  it('action path', () => {
    expect(
      getGithubEnvVars({
        GITHUB_ACTION_PATH:
          '/home/runner/work/_actions/neondatabase/create-branch-action/v5',
      }),
    ).toEqual({
      GITHUB_ACTION_PATH: 'neondatabase/create-branch-action/v5',
    });

    expect(
      getGithubEnvVars({
        GITHUB_ACTION_PATH:
          '/home/runner/actions-runner/_work/actions/neondatabase/create-branch-action/v5',
      }),
    ).toEqual({
      GITHUB_ACTION_PATH: 'neondatabase/create-branch-action/v5',
    });

    expect(
      getGithubEnvVars({
        GITHUB_ACTION_PATH:
          'C:\\b\\_actions\\neondatabase\\create-branch-action\\v5',
      }),
    ).toEqual({
      GITHUB_ACTION_PATH:
        'C:\\b\\_actions\\neondatabase\\create-branch-action\\v5',
    });

    expect(
      getGithubEnvVars({
        GITHUB_ACTION_PATH:
          '/home/runner/work/app/app/./.github/actions/custom-action',
      }),
    ).toEqual({
      GITHUB_ACTION_PATH: 'custom-action',
    });
  });
});

describe('isCi', () => {
  it('reads from the injected env', () => {
    expect(isCi({})).toBe(false);
    expect(isCi({ CI: 'false' })).toBe(false);
    expect(isCi({ CI: 'true' })).toBe(true);
    expect(isCi({ CI: '1' })).toBe(true);
  });
});

describe('detectCiProvider', () => {
  it('returns undefined when no CI signal', () => {
    expect(detectCiProvider({})).toBeUndefined();
    expect(detectCiProvider({ CI: 'false' })).toBeUndefined();
  });

  it('stays in sync with isCi: any CI=truthy maps to at least "unknown"', () => {
    // isCi accepts CI=yes etc.; detectCiProvider must agree so the two
    // never disagree on whether the session is CI.
    expect(detectCiProvider({ CI: 'yes' })).toBe('unknown');
    expect(detectCiProvider({ CI: 'maybe' })).toBe('unknown');
  });

  it('respects CI=false as an explicit override even when provider markers are set', () => {
    // Real-world case: a self-hosted GHA runner being used for local
    // debugging with CI=false. `ci` returns false; `ciProvider` must
    // agree, otherwise dashboards see ci=false / ciProvider=github-actions.
    expect(
      detectCiProvider({ CI: 'false', GITHUB_ACTIONS: 'true' }),
    ).toBeUndefined();
    expect(detectCiProvider({ CI: 'false', VERCEL: '1' })).toBeUndefined();
  });

  it('prefers specific providers over generic CI=true', () => {
    expect(detectCiProvider({ CI: 'true', GITHUB_ACTIONS: 'true' })).toBe(
      'github-actions',
    );
    expect(detectCiProvider({ CI: 'true', GITLAB_CI: 'true' })).toBe(
      'gitlab-ci',
    );
    expect(detectCiProvider({ CI: 'true', CIRCLECI: 'true' })).toBe('circleci');
    expect(detectCiProvider({ CI: 'true', BUILDKITE: 'true' })).toBe(
      'buildkite',
    );
    expect(detectCiProvider({ JENKINS_URL: 'http://j' })).toBe('jenkins');
    expect(detectCiProvider({ VERCEL: '1' })).toBe('vercel');
    expect(detectCiProvider({ NETLIFY: 'true' })).toBe('netlify');
    expect(detectCiProvider({ CF_PAGES: '1' })).toBe('cloudflare-pages');
    expect(detectCiProvider({ RAILWAY_PROJECT_ID: 'x' })).toBe('railway');
    expect(detectCiProvider({ FLY_APP_NAME: 'x' })).toBe('fly');
    expect(detectCiProvider({ TF_BUILD: 'True' })).toBe('azure-pipelines');
    expect(detectCiProvider({ CODEBUILD_BUILD_ID: 'x' })).toBe('aws-codebuild');
    expect(detectCiProvider({ APPVEYOR: 'True' })).toBe('appveyor');
    expect(detectCiProvider({ SEMAPHORE: 'true' })).toBe('semaphore');
    expect(detectCiProvider({ CODESPACES: 'true' })).toBe('github-codespaces');
    expect(detectCiProvider({ GITPOD_WORKSPACE_ID: 'x' })).toBe('gitpod');
    expect(detectCiProvider({ REPL_ID: 'x' })).toBe('replit');
    expect(detectCiProvider({ HEROKU_TEST_RUN_ID: 'x' })).toBe('heroku-ci');
  });

  it('falls back to unknown on bare CI=true', () => {
    expect(detectCiProvider({ CI: 'true' })).toBe('unknown');
    expect(detectCiProvider({ CI: '1' })).toBe('unknown');
  });

  it('uses iteration order as precedence when providers co-occur', () => {
    // Contract: when multiple provider markers are set in the same env,
    // earlier entries in CI_PROVIDERS win. Pinning this so a future
    // table reorder can't silently flip which provider gets reported.
    expect(
      detectCiProvider({ CI: 'true', GITHUB_ACTIONS: 'true', VERCEL: '1' }),
    ).toBe('github-actions');
    expect(
      detectCiProvider({ CI: 'true', CIRCLECI: 'true', NETLIFY: 'true' }),
    ).toBe('circleci');
  });
});

describe('detectTerminalHost', () => {
  it('returns undefined on plain shell', () => {
    expect(detectTerminalHost({})).toBeUndefined();
  });

  it('reflects the outer terminal even when an agent marker is set', () => {
    // Claude Code running inside iTerm: terminalType tracks the outer
    // shell (iTerm); the inner harness is reported separately by
    // detectAgentHostSource.
    expect(
      detectTerminalHost({ CLAUDECODE: '1', TERM_PROGRAM: 'iTerm.app' }),
    ).toBe('iterm');
  });

  it('treats Cursor as part of the vscode-fork family at the terminal layer', () => {
    expect(detectTerminalHost({ TERM_PROGRAM: 'cursor' })).toBe(
      'vscode-or-fork',
    );
    expect(detectTerminalHost({ TERM_PROGRAM: 'vscode' })).toBe(
      'vscode-or-fork',
    );
  });

  it('maps common terminal emulators to stable lowercase labels', () => {
    expect(detectTerminalHost({ TERM_PROGRAM: 'iTerm.app' })).toBe('iterm');
    expect(detectTerminalHost({ TERM_PROGRAM: 'Apple_Terminal' })).toBe(
      'apple-terminal',
    );
    expect(detectTerminalHost({ TMUX: 'foo' })).toBe('tmux');
    expect(detectTerminalHost({ TERM_PROGRAM: 'tmux' })).toBe('tmux');
    expect(detectTerminalHost({ TERM_PROGRAM: 'WezTerm' })).toBe('wezterm');
  });

  it('buckets unknown TERM_PROGRAM values to "other" (bounded cardinality)', () => {
    expect(detectTerminalHost({ TERM_PROGRAM: 'SomeNewThing' })).toBe('other');
    // Hostile / unbounded input also collapses to 'other', so the property
    // can't be flooded with attacker-chosen labels.
    expect(detectTerminalHost({ TERM_PROGRAM: 'A'.repeat(10_000) })).toBe(
      'other',
    );
    expect(detectTerminalHost({ TERM_PROGRAM: 'fo\x00o\x07ba\nr' })).toBe(
      'other',
    );
  });

  it('treats whitespace-only TERM_PROGRAM as unset', () => {
    expect(detectTerminalHost({ TERM_PROGRAM: '   ' })).toBeUndefined();
    expect(detectTerminalHost({ TERM_PROGRAM: '' })).toBeUndefined();
  });
});

describe('detectAgentHostSource', () => {
  it('names the marker that triggered detection', () => {
    expect(detectAgentHostSource({ CLAUDECODE: '1' })).toBe('claude-code');
    expect(detectAgentHostSource({ CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe(
      'claude-code',
    );
    expect(detectAgentHostSource({ CURSOR_TRACE_ID: 'abc' })).toBe('cursor');
    expect(detectAgentHostSource({ TERM_PROGRAM: 'WindsurfTerminal' })).toBe(
      'windsurf',
    );
    expect(detectAgentHostSource({ CODEX_SANDBOX: 'seatbelt' })).toBe('codex');
    expect(detectAgentHostSource({ CODEX_SANDBOX_NETWORK_DISABLED: '1' })).toBe(
      'codex',
    );
    expect(
      detectAgentHostSource({ NEON_CLIENT_USER_AGENT: 'opt-in-tool/1.2.3' }),
    ).toBe('opt-in');
  });

  it('returns undefined when no agent marker is set', () => {
    expect(detectAgentHostSource({})).toBeUndefined();
    expect(detectAgentHostSource({ TERM_PROGRAM: 'vscode' })).toBeUndefined();
    expect(
      detectAgentHostSource({ CI: 'true', GITHUB_ACTIONS: 'true' }),
    ).toBeUndefined();
  });

  it('product-specific markers win over the opt-in fallback', () => {
    // If a harness identifies itself via both its own marker AND
    // NEON_CLIENT_USER_AGENT, prefer the product-specific name.
    expect(
      detectAgentHostSource({
        CLAUDECODE: '1',
        NEON_CLIENT_USER_AGENT: 'codex/1.2.3',
      }),
    ).toBe('claude-code');
  });

  it('uses iteration order as precedence when two product markers co-occur', () => {
    // Contract: when multiple product markers are set in the same env,
    // earlier entries in AGENT_MARKERS win. Pinning this so a future
    // table reorder can't silently flip which agent gets reported.
    expect(
      detectAgentHostSource({
        CLAUDECODE: '1',
        CURSOR_TRACE_ID: 'abc',
      }),
    ).toBe('claude-code');
  });

  it('opt-in source is bound to sanitizeClientUserAgent: sanitize→undefined ⇒ no opt-in source', () => {
    // Contract pinned across the table: the 'opt-in' source must never
    // fire for any input that sanitizeClientUserAgent rejects. Each pair
    // is tested together so that if sanitization widens or narrows in the
    // future, both halves of the relationship are re-verified at once
    // (the first assertion fails first, forcing a deliberate update).
    const rejectedByCurrentSanitizer = [
      undefined,
      '',
      '   ',
      '\n\t',
      '\x00\x07',
    ];
    for (const v of rejectedByCurrentSanitizer) {
      expect(sanitizeClientUserAgent(v)).toBeUndefined();
      expect(
        detectAgentHostSource({ NEON_CLIENT_USER_AGENT: v }),
      ).toBeUndefined();
    }
  });
});

describe('parseTraceparent', () => {
  it('returns undefined for unset / empty input', () => {
    expect(parseTraceparent(undefined)).toBeUndefined();
    expect(parseTraceparent('')).toBeUndefined();
  });

  it('parses a valid W3C traceparent and derives sampled bit', () => {
    expect(
      parseTraceparent(
        '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      ),
    ).toEqual({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      parentId: 'b7ad6b7169203331',
      flags: '01',
      sampled: true,
    });
    expect(
      parseTraceparent(
        '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00',
      ),
    ).toEqual({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      parentId: 'b7ad6b7169203331',
      flags: '00',
      sampled: false,
    });
  });

  it('derives sampled correctly across all flag bits', () => {
    // sampled is bit 0; the seven other bits in the flags byte are reserved.
    const base = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-';
    expect(parseTraceparent(base + 'ff')?.sampled).toBe(true);
    expect(parseTraceparent(base + 'fe')?.sampled).toBe(false);
    expect(parseTraceparent(base + '02')?.sampled).toBe(false);
  });

  it('trims surrounding whitespace', () => {
    expect(
      parseTraceparent(
        '  00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00  ',
      ),
    ).toEqual({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      parentId: 'b7ad6b7169203331',
      flags: '00',
      sampled: false,
    });
  });

  it('tolerates W3C future versions that append trailing fields', () => {
    // 'ff' is reserved/invalid per spec — use a non-reserved future version.
    expect(
      parseTraceparent(
        '01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01-future-stuff',
      ),
    ).toEqual({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      parentId: 'b7ad6b7169203331',
      flags: '01',
      sampled: true,
    });
  });

  it('rejects the reserved ff version', () => {
    expect(
      parseTraceparent(
        'ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      ),
    ).toBeUndefined();
  });

  it('rejects trailing fields on v00 (spec requires exactly 4 fields)', () => {
    expect(
      parseTraceparent(
        '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01-extra',
      ),
    ).toBeUndefined();
  });

  it('rejects all-zero traceId / parentId per spec', () => {
    expect(
      parseTraceparent(
        '00-00000000000000000000000000000000-b7ad6b7169203331-01',
      ),
    ).toBeUndefined();
    expect(
      parseTraceparent(
        '00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01',
      ),
    ).toBeUndefined();
  });

  it('rejects oversized input without parsing it', () => {
    expect(parseTraceparent('x'.repeat(10_000))).toBeUndefined();
  });

  it('rejects malformed inputs', () => {
    // too few segments
    expect(parseTraceparent('00-aaa-bbb')).toBeUndefined();
    // wrong trace-id length
    expect(parseTraceparent('00-abc-b7ad6b7169203331-01')).toBeUndefined();
    // wrong parent-id length
    expect(
      parseTraceparent('00-0af7651916cd43dd8448eb211c80319c-bbbb-01'),
    ).toBeUndefined();
    // non-hex chars
    expect(
      parseTraceparent(
        '00-0af7651916cd43dd8448eb211c80319z-b7ad6b7169203331-01',
      ),
    ).toBeUndefined();
  });
});

describe('sanitizeClientUserAgent', () => {
  it('returns undefined for unset / empty / whitespace-only input', () => {
    expect(sanitizeClientUserAgent(undefined)).toBeUndefined();
    expect(sanitizeClientUserAgent('')).toBeUndefined();
    expect(sanitizeClientUserAgent('   ')).toBeUndefined();
  });

  it('trims and passes through reasonable values', () => {
    expect(sanitizeClientUserAgent('  codex/1.2.3  ')).toBe('codex/1.2.3');
  });

  it('strips ASCII control characters', () => {
    expect(sanitizeClientUserAgent('codex\n\x07/1.2.3\x00')).toBe(
      'codex/1.2.3',
    );
  });

  it('caps oversized input at 256 chars after slicing the raw value first', () => {
    const huge = 'x'.repeat(100_000);
    const out = sanitizeClientUserAgent(huge);
    expect(out).toBeDefined();
    expect(out?.length).toBe(256);
  });
});
