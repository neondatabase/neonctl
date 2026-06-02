import { isAxiosError } from 'axios';
import prompts from 'prompts';
import yargs from 'yargs';

import { applyContext, readContextFile } from '../context.js';
import { isCi } from '../env.js';
import { log } from '../log.js';
import { CommonProps } from '../types.js';
import { branchIdResolve, fillSingleProject } from '../utils/enrichers.js';
import { handler as linkHandler } from './link.js';

type CheckoutProps = CommonProps & {
  projectId?: string;
  orgId?: string;
  id: string;
};

export const command = 'checkout <id|name>';
export const describe =
  'Pin a branch in the local context (.neon) so subsequent commands target it';

export const builder = (argv: yargs.Argv) =>
  argv
    .usage('$0 checkout <id|name> [options]')
    .positional('id', {
      describe: 'Branch name or id to check out',
      type: 'string',
    })
    .options({
      'project-id': {
        describe: 'Project ID',
        type: 'string',
        // Mirror how `--api-key` defaults from `NEON_API_KEY`: fall back to
        // `NEON_PROJECT_ID` when the flag is omitted. The `.neon` context file
        // is consulted after this (via the global `enrichFromContext`
        // middleware) so the precedence is flag > env > context file.
        default: process.env.NEON_PROJECT_ID ?? undefined,
      },
    })
    .example([
      [
        '$0 checkout main',
        'Pin the branch named "main" in the closest .neon file',
      ],
      [
        '$0 checkout br-cool-snow-12345678 --project-id project-id-123',
        'Pin a branch by id for an explicit project',
      ],
    ]);

export const handler = async (props: CheckoutProps) => {
  // Branch listing is project-scoped, so `projectId` is the only thing
  // `checkout` actually needs. Resolve it through the standard chain
  // (flag > NEON_PROJECT_ID > .neon file > single-project auto-detect); when
  // nothing resolves, fall back to an interactive `neonctl link`.
  const projectId = await resolveProjectId(props);

  const branchId = await branchIdResolve({
    branch: props.id,
    apiClient: props.apiClient,
    projectId,
  });

  // `checkout` is a thin helper over `set-context`: it resolves the branch and
  // pins `branchId` without dropping the `projectId`/`orgId` already recorded in
  // the context file. Unlike `set-context` (which performs a destructive write),
  // we merge so a plain `neonctl checkout <branch>` keeps the existing link.
  const existing = readContextFile(props.contextFile);
  applyContext(props.contextFile, {
    ...existing,
    projectId,
    ...(props.orgId ? { orgId: props.orgId } : {}),
    branchId,
  });

  log.info(
    'Checked out branch %s on project %s. Updated %s.',
    branchId,
    projectId,
    props.contextFile,
  );
};

/**
 * Resolve the project id `checkout` should target.
 *
 * `props.projectId` is already populated from the `--project-id` flag, the
 * `NEON_PROJECT_ID` env var, or the closest `.neon` file (via the global
 * `enrichFromContext` middleware). When it's still missing we try to
 * auto-detect a single project (same behaviour as `branches` /
 * `connection-string`). If that fails we surface a telling error and, in an
 * interactive terminal, offer to run `neonctl link` in the current folder so
 * the user can pick a project/branch without having to re-run the command by
 * hand.
 */
const resolveProjectId = async (props: CheckoutProps): Promise<string> => {
  if (props.projectId) {
    return props.projectId;
  }

  const autoDetected = await tryAutoDetectProject(props);
  if (autoDetected) {
    return autoDetected;
  }

  const missingProjectMessage =
    'Could not determine which Neon project to check out a branch from. ' +
    'Provide one via the --project-id flag, the NEON_PROJECT_ID environment variable, ' +
    'or a .neon file (created by `neonctl link` / `neonctl set-context`).';

  if (isCi() || !process.stdout.isTTY) {
    throw new Error(missingProjectMessage);
  }

  log.error(missingProjectMessage);

  const { runLink } = await prompts({
    type: 'confirm',
    name: 'runLink',
    message: 'Run `neonctl link` in the current folder to pick a project now?',
    initial: true,
  });

  if (!runLink) {
    throw new Error(
      'Aborted: no project selected. Re-run with --project-id or link a project first.',
    );
  }

  await linkHandler({
    ...props,
    agent: false,
    yes: false,
  });

  const linked = readContextFile(props.contextFile);
  if (!linked.projectId) {
    throw new Error(
      'Linking did not produce a project id. Re-run `neonctl checkout` once the directory is linked.',
    );
  }
  // Carry the freshly-linked org id forward so the merge below keeps it.
  if (linked.orgId) {
    props.orgId = linked.orgId;
  }
  return linked.projectId;
};

/**
 * Best-effort single-project auto-detection. Returns the project id when the
 * API key maps to exactly one project, or `undefined` when the project can't be
 * determined unambiguously (zero or multiple projects) so the caller can fall
 * back to the interactive `link` flow.
 */
const tryAutoDetectProject = async (
  props: CheckoutProps,
): Promise<string | undefined> => {
  try {
    const filled = await fillSingleProject(props);
    return filled.projectId;
  } catch (err) {
    // `fillSingleProject` throws on "No projects found" / "Multiple projects
    // found" — both mean we can't pick a project automatically. Network/auth
    // errors are real and should surface to the user.
    if (isAxiosError(err)) {
      throw err;
    }
    log.debug(
      'checkout: could not auto-detect a single project: %s',
      err instanceof Error ? err.message : String(err),
    );
    return undefined;
  }
};
