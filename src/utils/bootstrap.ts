import axios, { isAxiosError } from 'axios';
import YAML from 'yaml';

import { log } from '../log.js';

/**
 * A scaffold template that lives in a subdirectory of a public GitHub repo we
 * control. `neon bootstrap` copies that subdirectory into a target folder —
 * conceptually the same as `degit user/repo/subdir`, but implemented in-house
 * so the download host stays configurable (and therefore end-to-end testable)
 * and so we never pull in a heavy dependency tree just to copy a few files.
 */
export type BootstrapTemplate = {
  /** Stable id used by `--template` and analytics. */
  id: string;
  /** Human label shown in the interactive selector. */
  title: string;
  /** One-line description shown under the title in the selector. */
  description: string;
  /**
   * Neon services the template uses (e.g. "Postgres", "Functions"). Shown as a
   * badge next to the title in the picker. Optional — older manifests omit it.
   */
  services?: string[];
  source: {
    owner: string;
    repo: string;
    /** Branch (or tag) the template is pulled from. */
    ref: string;
    /** Subdirectory within the repo to copy (no leading/trailing slash). */
    subdir: string;
  };
};

/** Hardcoded fallback used when the remote manifest cannot be fetched. */
export const FALLBACK_TEMPLATES: BootstrapTemplate[] = [
  {
    id: 'hono',
    title: 'Hono API (Drizzle, Neon Postgres) on Neon Functions',
    description:
      'A Hono API using Drizzle ORM and Neon Postgres, ready to deploy as a Neon Function.',
    services: ['Postgres', 'Functions'],
    source: {
      owner: 'neondatabase',
      repo: 'examples',
      ref: 'main',
      subdir: 'with-hono',
    },
  },
];

export const templateIds = (templates: BootstrapTemplate[]): string =>
  templates.map((t) => t.id).join(', ');

export const findTemplate = (
  templates: BootstrapTemplate[],
  id: string,
): BootstrapTemplate | undefined => templates.find((t) => t.id === id);

/** A single file or symlink to materialize, resolved from the repo tree. */
export type TemplateEntry =
  | {
      kind: 'file';
      /** Path relative to the target directory (subdir prefix stripped). */
      path: string;
      /** Path within the repo, used to fetch the raw bytes. */
      repoPath: string;
      executable: boolean;
    }
  | {
      kind: 'symlink';
      path: string;
      repoPath: string;
    };

export type GitTreeNode = {
  path: string;
  mode: string;
  type: string;
};

// Hosts are overridable so the e2e tests can point the downloader at a local
// server (the same trick `--api-host` uses to redirect the Neon API in tests).
// The defaults hit public GitHub; copying a public template needs no auth.
const githubApiBase = (): string =>
  process.env.NEON_BOOTSTRAP_GITHUB_API ?? 'https://api.github.com';

const githubRawBase = (): string =>
  process.env.NEON_BOOTSTRAP_GITHUB_RAW ?? 'https://raw.githubusercontent.com';

const githubToken = (): string =>
  process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';

const apiHeaders = (): Record<string, string> => ({
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'neonctl',
  ...(githubToken() ? { Authorization: `Bearer ${githubToken()}` } : {}),
});

const rawHeaders = (): Record<string, string> => ({
  'User-Agent': 'neonctl',
  ...(githubToken() ? { Authorization: `Bearer ${githubToken()}` } : {}),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Normalize a manifest entry's `services` into a clean string list. Tolerant by
 * design: a missing or non-array value yields `undefined`, and non-string items
 * are dropped, so a malformed `services` never sinks an otherwise-valid
 * template (it just renders without its badge).
 */
const parseServices = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const services = value.filter(
    (item): item is string => typeof item === 'string' && item.trim() !== '',
  );
  return services.length > 0 ? services : undefined;
};

// ---------------------------------------------------------------------------
// Remote template manifest
// ---------------------------------------------------------------------------

const manifestUrl = (): string =>
  process.env.NEON_BOOTSTRAP_MANIFEST_URL ??
  `${githubRawBase()}/neondatabase/examples/main/bootstrap.yaml`;

export const parseManifest = (text: string): BootstrapTemplate[] => {
  const data: unknown = YAML.parse(text);
  if (!isRecord(data) || !Array.isArray(data.templates)) {
    throw new Error('Invalid bootstrap manifest: missing "templates" array.');
  }
  const templates: BootstrapTemplate[] = [];
  for (let i = 0; i < data.templates.length; i++) {
    const item: unknown = data.templates[i];
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.title !== 'string' ||
      typeof item.description !== 'string' ||
      !isRecord(item.source) ||
      typeof item.source.owner !== 'string' ||
      typeof item.source.repo !== 'string' ||
      typeof item.source.ref !== 'string' ||
      typeof item.source.subdir !== 'string'
    ) {
      log.warning(
        'bootstrap: skipping malformed template entry at index %d in manifest.',
        i,
      );
      continue;
    }
    const services = parseServices(item.services);
    templates.push({
      id: item.id,
      title: item.title,
      description: item.description,
      ...(services ? { services } : {}),
      source: {
        owner: item.source.owner,
        repo: item.source.repo,
        ref: item.source.ref,
        subdir: item.source.subdir,
      },
    });
  }
  return templates;
};

/**
 * Fetch the template manifest from the remote `bootstrap.yaml` in the
 * neondatabase/examples repo. Falls back to the hardcoded list on any error
 * so the command never fails just because GitHub is unreachable.
 */
export const fetchTemplates = async (): Promise<BootstrapTemplate[]> => {
  const url = manifestUrl();
  try {
    const res = await axios.get<string>(url, {
      responseType: 'text',
      headers: rawHeaders(),
      timeout: 10_000,
    });
    const templates = parseManifest(res.data);
    if (templates.length === 0) {
      log.warning(
        'Remote bootstrap manifest at %s contained no templates; using built-in defaults.',
        url,
      );
      return FALLBACK_TEMPLATES;
    }
    return templates;
  } catch (err) {
    log.debug(
      'bootstrap: failed to fetch manifest from %s: %s — using built-in defaults.',
      url,
      err instanceof Error ? err.message : String(err),
    );
    return FALLBACK_TEMPLATES;
  }
};

const malformed = (what: string): Error =>
  new Error(`Unexpected GitHub API response while resolving ${what}.`);

type ResolvedCommit = { commitSha: string; treeSha: string };

const parseCommit = (data: unknown): ResolvedCommit => {
  if (!isRecord(data) || typeof data.sha !== 'string') {
    throw malformed('the template commit');
  }
  const { commit } = data;
  if (
    !isRecord(commit) ||
    !isRecord(commit.tree) ||
    typeof commit.tree.sha !== 'string'
  ) {
    throw malformed('the template tree');
  }
  return { commitSha: data.sha, treeSha: commit.tree.sha };
};

type ParsedTree = { truncated: boolean; tree: GitTreeNode[] };

const parseTree = (data: unknown): ParsedTree => {
  if (!isRecord(data) || !Array.isArray(data.tree)) {
    throw malformed('the template file tree');
  }
  const tree: GitTreeNode[] = [];
  for (const item of data.tree) {
    if (
      isRecord(item) &&
      typeof item.path === 'string' &&
      typeof item.mode === 'string' &&
      typeof item.type === 'string'
    ) {
      tree.push({ path: item.path, mode: item.mode, type: item.type });
    }
  }
  return { truncated: data.truncated === true, tree };
};

const friendlyGithubError = (err: unknown, url: string): Error => {
  if (isAxiosError(err)) {
    const status = err.response?.status;
    if (status === 404) {
      return new Error(
        `GitHub returned 404 for ${url}. The template repo, ref, or subdirectory may have moved.`,
      );
    }
    if (
      status === 403 &&
      err.response?.headers['x-ratelimit-remaining'] === '0'
    ) {
      return new Error(
        'GitHub API rate limit exceeded. Set a GITHUB_TOKEN environment variable to raise the limit, then retry.',
      );
    }
  }
  return err instanceof Error ? err : new Error(String(err));
};

const getJson = async (url: string): Promise<unknown> => {
  try {
    const res = await axios.get<unknown>(url, { headers: apiHeaders() });
    return res.data;
  } catch (err) {
    throw friendlyGithubError(err, url);
  }
};

/**
 * Map a flat (recursive) git tree to the entries under `subdir`, with the
 * `subdir/` prefix stripped from each `path`. Pure so it can be unit tested
 * without touching the network. Directory nodes are dropped — git never
 * stores empty directories, and writing files re-creates their parents.
 */
export const selectSubtreeEntries = (
  tree: GitTreeNode[],
  subdir: string,
): TemplateEntry[] => {
  const prefix = `${subdir.replace(/\/+$/, '')}/`;
  const entries: TemplateEntry[] = [];
  for (const node of tree) {
    if (node.type !== 'blob') {
      continue;
    }
    if (!node.path.startsWith(prefix)) {
      continue;
    }
    const path = node.path.slice(prefix.length);
    if (node.mode === '120000') {
      entries.push({ kind: 'symlink', path, repoPath: node.path });
    } else {
      entries.push({
        kind: 'file',
        path,
        repoPath: node.path,
        executable: node.mode === '100755',
      });
    }
  }
  return entries;
};

export type ResolvedTemplate = {
  /** Immutable commit the whole copy is pinned to (no time-of-check races). */
  commitSha: string;
  entries: TemplateEntry[];
};

/**
 * Resolve a template to the exact set of files to write. Pins everything to a
 * single immutable commit: the ref is resolved to a commit sha, the tree is
 * read from that commit's tree, and every blob is later fetched by that same
 * commit — so a push to the template repo mid-copy can't produce a mismatched
 * checkout.
 */
export const resolveTemplate = async (
  template: BootstrapTemplate,
): Promise<ResolvedTemplate> => {
  const { owner, repo, ref, subdir } = template.source;
  const api = githubApiBase();

  const commit = parseCommit(
    await getJson(`${api}/repos/${owner}/${repo}/commits/${ref}`),
  );
  const { truncated, tree } = parseTree(
    await getJson(
      `${api}/repos/${owner}/${repo}/git/trees/${commit.treeSha}?recursive=1`,
    ),
  );
  if (truncated) {
    throw new Error(
      `GitHub returned a truncated file tree for ${owner}/${repo}; cannot reliably copy template "${template.id}".`,
    );
  }

  const entries = selectSubtreeEntries(tree, subdir);
  if (entries.length === 0) {
    throw new Error(
      `Template subdirectory "${subdir}" was not found in ${owner}/${repo}@${ref}.`,
    );
  }
  log.debug(
    'bootstrap: resolved %d files for template "%s" at %s',
    entries.length,
    template.id,
    commit.commitSha,
  );
  return { commitSha: commit.commitSha, entries };
};

const rawUrl = (
  template: BootstrapTemplate,
  commitSha: string,
  repoPath: string,
): string =>
  `${githubRawBase()}/${template.source.owner}/${template.source.repo}/${commitSha}/${repoPath}`;

/** Download a file's raw bytes, pinned to the resolved commit. */
export const fetchFileBytes = async (
  template: BootstrapTemplate,
  commitSha: string,
  repoPath: string,
): Promise<Buffer> => {
  const url = rawUrl(template, commitSha, repoPath);
  try {
    const res = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      headers: rawHeaders(),
    });
    return Buffer.from(res.data);
  } catch (err) {
    throw friendlyGithubError(err, url);
  }
};

/**
 * Read a symlink's target. In a git blob a symlink is stored as a regular file
 * whose contents are the (relative) link target, so the raw bytes are exactly
 * the string we pass to `symlink(2)`.
 */
export const fetchSymlinkTarget = async (
  template: BootstrapTemplate,
  commitSha: string,
  repoPath: string,
): Promise<string> => {
  const bytes = await fetchFileBytes(template, commitSha, repoPath);
  return bytes.toString('utf8');
};
