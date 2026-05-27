// Defensive caps so a malformed or hostile env var can't bloat events or
// burn CPU during parsing. A W3C v00 traceparent is exactly 55 bytes;
// the other caps are sized well above any value we'd plausibly see from
// real shells / harnesses while still bounding worst-case work.
const MAX_TRACEPARENT_LEN = 256;
const MAX_CLIENT_USER_AGENT_LEN = 256;
const MAX_TERM_PROGRAM_LEN = 64;

// Single source of truth for the WindsurfTerminal marker — referenced both
// as the outer terminal and the inner agent harness.
const WINDSURF_TERM_PROGRAM = 'WindsurfTerminal';

export const isCi = (env: NodeJS.ProcessEnv = process.env) => {
  return env.CI !== 'false' && Boolean(env.CI);
};

export const isDebug = () => {
  return Boolean(process.env.DEBUG);
};

// CI / hosted-environment marker table. Iteration order is the precedence
// when multiple markers co-occur (pinned by a test in env.test.ts).
// Add new entries as new providers ship rather than touching the
// iteration logic in detectCiProvider.
//
// Hosted dev environments (Codespaces, Gitpod, Replit) are bucketed here
// even though they aren't strictly "CI" — they reliably indicate a
// non-laptop runtime, which is what a dashboard usually wants to split on.
const CI_PROVIDERS: readonly {
  label: string;
  match: (env: NodeJS.ProcessEnv) => boolean;
}[] = [
  { label: 'github-actions', match: (e) => !!e.GITHUB_ACTIONS },
  { label: 'gitlab-ci', match: (e) => !!e.GITLAB_CI },
  { label: 'circleci', match: (e) => !!e.CIRCLECI },
  { label: 'buildkite', match: (e) => !!e.BUILDKITE },
  { label: 'travis', match: (e) => !!e.TRAVIS },
  { label: 'jenkins', match: (e) => !!e.JENKINS_URL || !!e.JENKINS_HOME },
  { label: 'teamcity', match: (e) => !!e.TEAMCITY_VERSION },
  {
    label: 'bitbucket-pipelines',
    match: (e) => !!e.BITBUCKET_BUILD_NUMBER || !!e.BITBUCKET_COMMIT,
  },
  { label: 'drone', match: (e) => !!e.DRONE },
  { label: 'azure-pipelines', match: (e) => !!e.TF_BUILD },
  { label: 'aws-codebuild', match: (e) => !!e.CODEBUILD_BUILD_ID },
  { label: 'appveyor', match: (e) => !!e.APPVEYOR },
  { label: 'semaphore', match: (e) => !!e.SEMAPHORE },
  { label: 'woodpecker', match: (e) => !!e.WOODPECKER },
  { label: 'heroku-ci', match: (e) => !!e.HEROKU_TEST_RUN_ID },
  { label: 'vercel', match: (e) => !!e.VERCEL },
  { label: 'netlify', match: (e) => !!e.NETLIFY },
  { label: 'cloudflare-pages', match: (e) => !!e.CF_PAGES },
  { label: 'render', match: (e) => !!e.RENDER },
  { label: 'railway', match: (e) => !!e.RAILWAY_PROJECT_ID },
  { label: 'fly', match: (e) => !!e.FLY_APP_NAME },
  { label: 'github-codespaces', match: (e) => !!e.CODESPACES },
  { label: 'gitpod', match: (e) => !!e.GITPOD_WORKSPACE_ID },
  { label: 'replit', match: (e) => !!e.REPL_ID },
];

export const detectCiProvider = (
  env: NodeJS.ProcessEnv,
): string | undefined => {
  // When the user explicitly sets `CI=false`, treat as not-CI even if
  // other markers are still in the env (matches isCi's behavior).
  if (env.CI === 'false') return undefined;
  for (const { label, match } of CI_PROVIDERS) {
    if (match(env)) return label;
  }
  // Fall back to a generic 'unknown' bucket whenever isCi() says yes but
  // no specific provider matched — keeps `ciProvider` populated for every
  // CI run, so dashboards never have to UNION on the boolean separately.
  return isCi(env) ? 'unknown' : undefined;
};

// Known outer terminals. The lookup table is the documentation; add new
// terminals here as they ship rather than extending an if-chain.
const TERM_PROGRAM_LABELS: Readonly<Record<string, string>> = {
  vscode: 'vscode-or-fork',
  cursor: 'vscode-or-fork',
  [WINDSURF_TERM_PROGRAM]: 'windsurf',
  'iTerm.app': 'iterm',
  Apple_Terminal: 'apple-terminal',
  WezTerm: 'wezterm',
  ghostty: 'ghostty',
  kitty: 'kitty',
  Alacritty: 'alacritty',
};

// Best-effort label for the outer terminal / shell environment the CLI is
// running in. Drawn from TERM_PROGRAM and the TMUX presence check — i.e.
// the underlying shell, *not* the agent harness on top of it. The agent
// harness, if any, lives in `agentHostSource` so dashboards can split
// "Claude Code on iTerm" vs "Claude Code on VSCode" without losing either.
// `undefined` means neither TERM_PROGRAM nor TMUX was set (most commonly
// a plain shell with neither marker).
//
// Notes:
//  - When TMUX is set we return 'tmux' regardless of TERM_PROGRAM. Tmux
//    is a multiplexer rather than a terminal; surfacing it as its own
//    bucket keeps dashboards readable.
//  - `TERM_PROGRAM=vscode` and `TERM_PROGRAM=cursor` both map to
//    `vscode-or-fork`. `agentHostSource` separately reports a Cursor AI
//    session when `CURSOR_TRACE_ID` is set.
export const detectTerminalHost = (
  env: NodeJS.ProcessEnv,
): string | undefined => {
  // Slice before trim so a multi-MB hostile TERM_PROGRAM doesn't traverse
  // the whole string in `.trim()` before the length cap kicks in.
  const raw = env.TERM_PROGRAM?.slice(0, MAX_TERM_PROGRAM_LEN).trim();
  // Generic tmux: the env var is sometimes set by the terminal, sometimes
  // only TMUX is. Check both. Place before the TERM_PROGRAM lookup so we
  // don't have to enumerate every terminal-that-sets-tmux.
  if (raw === 'tmux' || env.TMUX) return 'tmux';
  if (!raw) return undefined;
  const known = TERM_PROGRAM_LABELS[raw];
  if (known) return known;
  // Unknown TERM_PROGRAM goes into a single 'other' bucket so the
  // cardinality of this property is bounded by the allowlist + 'other',
  // regardless of how many distinct (or hostile) values users' shells
  // emit. New terminals can be promoted into TERM_PROGRAM_LABELS when
  // we want to break them out specifically.
  return 'other';
};

// Agent-host markers in precedence order: product-specific markers first,
// then the generic NEON_CLIENT_USER_AGENT opt-in last. Adding a new agent
// is one entry here and one test in env.test.ts.
const AGENT_MARKERS: readonly {
  source: string;
  match: (env: NodeJS.ProcessEnv) => boolean;
}[] = [
  {
    source: 'claude-code',
    match: (e) => e.CLAUDECODE === '1' || !!e.CLAUDE_CODE_ENTRYPOINT,
  },
  { source: 'cursor', match: (e) => !!e.CURSOR_TRACE_ID },
  {
    source: 'windsurf',
    match: (e) => e.TERM_PROGRAM === WINDSURF_TERM_PROGRAM,
  },
  // OpenAI Codex CLI injects these env vars on the subprocesses it
  // spawns via its shell tool (see openai/codex codex-rs/core/src/spawn.rs
  // and codex-rs/core/src/sandboxing/mod.rs). Neither is user-facing
  // configuration; the names are specific enough that a false positive
  // requires someone to deliberately set them.
  {
    source: 'codex',
    match: (e) =>
      e.CODEX_SANDBOX === 'seatbelt' ||
      e.CODEX_SANDBOX_NETWORK_DISABLED === '1',
  },
  // Generic opt-in: matches only when sanitization yields a usable value,
  // so when 'opt-in' is the resolved source the emitted clientUserAgent
  // property is guaranteed to be present. Sanitization runs again here
  // (the analytics pipeline also sanitizes for the property); intentional
  // — keeps both call sites resolving via the same function instead of
  // threading a pre-sanitized value through the marker table.
  {
    source: 'opt-in',
    match: (e) =>
      sanitizeClientUserAgent(e.NEON_CLIENT_USER_AGENT) !== undefined,
  },
];

// Names the marker that triggered agent-host detection. `undefined` means
// the invocation does not look like an agent host. The boolean form
// (`agentHostDetected` in analytics) is derived from this so the two can
// never disagree.
export const detectAgentHostSource = (
  env: NodeJS.ProcessEnv,
): string | undefined => {
  for (const { source, match } of AGENT_MARKERS) {
    if (match(env)) return source;
  }
  return undefined;
};

// Parses the W3C Trace Context `traceparent` header value per
// https://www.w3.org/TR/trace-context/#traceparent-header:
//   version "-" traceId "-" parentId "-" traceFlags
// Only used if the caller's tooling already set TRACEPARENT (e.g. the
// parent harness is propagating a trace). The CLI does not emit OTel
// spans on its own; this just preserves the parent's IDs as event
// properties so they can be correlated later if needed.
//
// Spec rules enforced:
//  - version 'ff' is reserved/invalid and rejected.
//  - version '00' requires exactly 4 fields.
//  - All-zero traceId or parentId is invalid; rejected.
//  - Later versions are parsed only if their first 4 fields match the
//    v00 shape (32-hex traceId, 16-hex parentId, 2-hex flags); trailing
//    fields are ignored. A future version that changes any of those
//    field widths would be rejected by these validators.
export type Traceparent = {
  traceId: string;
  parentId: string;
  flags: string;
  sampled: boolean;
};

export const parseTraceparent = (
  value: string | undefined,
): Traceparent | undefined => {
  if (!value) return undefined;
  // Length-cap up front so a hostile env var can't allocate a huge split
  // result before the structural checks reject it.
  if (value.length > MAX_TRACEPARENT_LEN) return undefined;
  const parts = value.trim().split('-');
  if (parts.length < 4) return undefined;
  const [version, traceId, parentId, flags] = parts;
  if (
    !/^[0-9a-f]{2}$/.test(version) ||
    version === 'ff' ||
    !/^[0-9a-f]{32}$/.test(traceId) ||
    !/^[0-9a-f]{16}$/.test(parentId) ||
    !/^[0-9a-f]{2}$/.test(flags)
  ) {
    return undefined;
  }
  // v00 is fully specified at 4 fields; trailing data is a protocol error.
  // Later versions are allowed to append fields and we ignore them.
  if (version === '00' && parts.length !== 4) return undefined;
  // All-zero traceId / parentId are explicitly invalid per the spec.
  if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) return undefined;
  return {
    traceId,
    parentId,
    flags,
    sampled: (parseInt(flags, 16) & 1) === 1,
  };
};

// Sanitizes the opt-in NEON_CLIENT_USER_AGENT env var. Free-form by
// design, but: cap length so a runaway value can't bloat events; strip
// control characters that would mangle line-oriented downstream sinks.
export const sanitizeClientUserAgent = (
  value: string | undefined,
): string | undefined => {
  if (!value) return undefined;
  // Slice before trim/strip so a multi-MB hostile value doesn't traverse
  // the whole string in `.trim()` / `.replace()` first.
  const capped = value.slice(0, MAX_CLIENT_USER_AGENT_LEN);
  // eslint-disable-next-line no-control-regex
  const cleaned = capped.replace(/[\x00-\x1f\x7f]/g, '').trim();
  return cleaned || undefined;
};

export const getGithubEnvVars = (
  env: NodeJS.ProcessEnv,
): Record<string, string> => {
  const vars = [
    // github action info
    'GITHUB_ACTION_PATH',

    // source github repository
    'GITHUB_REPOSITORY',

    // environment info
    'GITHUB_RUN_ID',
    'GITHUB_RUN_NUMBER',
    'GITHUB_SERVER_URL',
    'GITHUB_WORKFLOW_REF',
    'RUNNER_ARCH',
    'RUNNER_ENVIRONMENT',
    'RUNNER_OS',
  ];

  const map = new Map<string, string>();
  vars.forEach((v) => {
    let value = env[v];
    if (value === undefined || value === '') {
      return;
    }
    if (v === 'GITHUB_ACTION_PATH') {
      value = value.includes('actions/')
        ? value.replace(/^.*actions\/(.+)$/, '$1')
        : value;
    }

    map.set(v, value);
  });

  return Object.fromEntries(map);
};
