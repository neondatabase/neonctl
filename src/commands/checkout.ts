import { Branch, EndpointType } from '@neondatabase/api-client';
import { isAxiosError } from 'axios';
import prompts from 'prompts';
import yargs from 'yargs';

import { retryOnLock } from '../api.js';
import { applyContext, readContextFile } from '../context.js';
import { isCi } from '../env.js';
import { log } from '../log.js';
import { CommonProps } from '../types.js';
import { fillSingleProject } from '../utils/enrichers.js';
import { looksLikeBranchId } from '../utils/formats.js';
import { handler as linkHandler } from './link.js';

type CheckoutProps = CommonProps & {
  projectId?: string;
  orgId?: string;
  id?: string;
};

// The positional is optional: omitting it in an interactive terminal opens a
// branch picker. In non-interactive contexts a missing branch is an error.
export const command = 'checkout [id|name]';
export const describe =
  'Pin a branch in the local context (.neon) so subsequent commands target it';

export const builder = (argv: yargs.Argv) =>
  argv
    .usage('$0 checkout [id|name] [options]')
    .positional('id', {
      describe:
        'Branch name or id to check out. Omit to pick interactively from the list of branches.',
      type: 'string',
    })
    .options({
      'project-id': {
        describe: 'Project ID',
        type: 'string',
      },
    })
    .example([
      [
        '$0 checkout',
        'Pick a branch interactively from the project in the closest .neon file',
      ],
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
  // (--project-id flag > .neon file > single-project auto-detect); when
  // nothing resolves, fall back to an interactive `neonctl link`.
  const projectId = await resolveProjectId(props);

  const branchId = await resolveBranchId(props, projectId);

  const orgId = await resolveOrgId(props, projectId);

  // `checkout` is a thin helper over `set-context`. It fully "heals" the
  // context file: it always (re)writes `projectId`, `branchId`, and `orgId`
  // (when the project has one) so a `.neon` that drifted or was missing fields
  // ends up complete and consistent after checkout.
  applyContext(props.contextFile, {
    projectId,
    ...(orgId ? { orgId } : {}),
    branchId,
  });

  log.info(
    'Checked out branch %s on project %s%s. Updated %s.',
    branchId,
    projectId,
    orgId ? ` (org ${orgId})` : '',
    props.contextFile,
  );
};

/**
 * Resolve the branch id to check out.
 *
 * - Branch **id** (`br-…`): looked up by id. A non-existent id is a hard "not
 *   found" error — we never offer to create one, since ids are server-assigned.
 * - Branch **name**: looked up by name. If it doesn't exist, in an interactive
 *   terminal we offer to create it (like `neonctl branch create --name <name>`);
 *   in a non-interactive context it's the usual "not found" error.
 * - **Omitted**: open an interactive picker listing the project's branches (TTY
 *   only); in a non-interactive context a missing branch is a hard error.
 */
const resolveBranchId = async (
  props: CheckoutProps,
  projectId: string,
): Promise<string> => {
  const branches = (await props.apiClient.listProjectBranches({ projectId }))
    .data.branches;

  if (!props.id) {
    return pickBranchInteractively(branches, projectId);
  }

  const ref = props.id;

  // A `br-…` value is an id; match strictly by id and never offer to create.
  if (looksLikeBranchId(ref)) {
    const byId = branches.find((b: Branch) => b.id === ref);
    if (byId) {
      return byId.id;
    }
    throw new Error(notFoundMessage(ref, branches));
  }

  const byName = branches.find((b: Branch) => b.name === ref);
  if (byName) {
    return byName.id;
  }

  // Name not found: offer to create it interactively, mirroring `branch create`.
  if (isCi() || !process.stdout.isTTY) {
    throw new Error(notFoundMessage(ref, branches));
  }

  log.error(notFoundMessage(ref, branches));
  const { create } = await prompts({
    type: 'confirm',
    name: 'create',
    message: `Branch "${ref}" does not exist. Create it now?`,
    initial: true,
  });
  if (!create) {
    throw new Error(`Aborted: branch "${ref}" was not found and not created.`);
  }
  return createBranch(props, projectId, ref, branches);
};

const notFoundMessage = (ref: string, branches: Branch[]): string =>
  `Branch ${ref} not found.\nAvailable branches: ${branches
    .map((b: Branch) => b.name)
    .join(', ')}`;

const pickBranchInteractively = async (
  branches: Branch[],
  projectId: string,
): Promise<string> => {
  if (isCi() || !process.stdout.isTTY) {
    throw new Error(
      'No branch specified. Pass a branch name or id (e.g. `neonctl checkout main`), ' +
        'or run interactively to pick one from a list.',
    );
  }
  if (branches.length === 0) {
    throw new Error(`No branches found for project ${projectId}.`);
  }
  const defaultIndex = Math.max(
    0,
    branches.findIndex((b: Branch) => b.default),
  );
  const { branchId } = await prompts({
    type: 'select',
    name: 'branchId',
    message: 'Which branch would you like to check out?',
    choices: branches.map((b: Branch) => ({
      title: `${b.default ? '✱ ' : ''}${b.name} (${b.id})`,
      value: b.id,
    })),
    initial: defaultIndex,
  });
  if (!branchId) {
    throw new Error('Aborted: no branch selected.');
  }
  return branchId;
};

/**
 * Create a branch with the same defaults as `neonctl branch create --name <name>`:
 * branched from the project's default branch with a read-write compute endpoint.
 */
const createBranch = async (
  props: CheckoutProps,
  projectId: string,
  name: string,
  branches: Branch[],
): Promise<string> => {
  const defaultBranch = branches.find((b: Branch) => b.default);
  if (!defaultBranch) {
    throw new Error('No default branch found');
  }
  const { data } = await retryOnLock(() =>
    props.apiClient.createProjectBranch(projectId, {
      branch: { name, parent_id: defaultBranch.id },
      endpoints: [{ type: EndpointType.ReadWrite }],
    }),
  );
  if (defaultBranch.protected) {
    log.warning(
      'The parent branch is protected; a unique role password has been generated for the new branch.',
    );
  }
  log.info('Created branch %s (%s).', data.branch.name, data.branch.id);
  return data.branch.id;
};

/**
 * Resolve the org id to heal into the context file.
 *
 * Prefer an org id we already know (from `--org-id`, the `.neon` file, or a
 * freshly-run `link`). Otherwise look it up from the project itself so the
 * `.neon` file ends up with an accurate `orgId` even when it was previously
 * missing. Projects on a personal account have no org; in that case (or if the
 * lookup fails for a non-auth reason) we return `undefined` and simply omit the
 * field rather than failing the checkout.
 */
const resolveOrgId = async (
  props: CheckoutProps,
  projectId: string,
): Promise<string | undefined> => {
  if (props.orgId) {
    return props.orgId;
  }
  try {
    const { data } = await props.apiClient.getProject(projectId);
    return data.project.org_id ?? undefined;
  } catch (err) {
    if (isAxiosError(err) && err.response?.status === 401) {
      throw err;
    }
    log.debug(
      'checkout: could not resolve org id for project %s: %s',
      projectId,
      err instanceof Error ? err.message : String(err),
    );
    return undefined;
  }
};

/**
 * Resolve the project id `checkout` should target.
 *
 * `props.projectId` is already populated from the `--project-id` flag or the
 * closest `.neon` file (via the global `enrichFromContext` middleware). When
 * it's still missing we try to auto-detect a single project (same behaviour as
 * `branches` / `connection-string`). If that fails we surface a telling error
 * and, in an interactive terminal, offer to run `neonctl link` in the current
 * folder so the user can pick a project/branch without having to re-run the
 * command by hand.
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
    'Provide one via the --project-id flag ' +
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
