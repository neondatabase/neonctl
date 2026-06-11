import { Branch } from '@neondatabase/api-client';
import { isAxiosError } from 'axios';
import prompts from 'prompts';
import yargs from 'yargs';

import { applyContext, readContextFile } from '../context.js';
import { isCi } from '../env.js';
import { log } from '../log.js';
import { CommonProps } from '../types.js';
import {
  createBranch,
  pickBranchInteractively,
} from '../utils/branch_picker.js';
import { fillSingleProject } from '../utils/enrichers.js';
import { looksLikeBranchId } from '../utils/formats.js';
import { autoPullEnvAfterPin } from './env.js';
import {
  applyPolicyOnCreate,
  createBranchFromPolicyOnCheckout,
} from './config.js';
import { handler as linkHandler } from './link.js';

type CheckoutProps = CommonProps & {
  projectId?: string;
  orgId?: string;
  id?: string;
  envPull: boolean;
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
      'env-pull': {
        describe:
          "Pull the branch's Neon env vars (DATABASE_URL, …) into a local .env after " +
          'checkout. On by default; use --no-env-pull to skip (e.g. when injecting env at ' +
          'runtime with `neon-env run` / `neon dev`).',
        type: 'boolean',
        default: true,
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

  const { branchId, created, policyApplied } = await resolveBranchId(
    props,
    projectId,
  );

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

  // When checkout *created* the branch and a neon.ts exists, the branch was created straight
  // from the policy (evaluated as a new branch) so its settings/infra are already applied —
  // see `policyApplied`. The fallback below covers the case where the branch was created bare
  // (e.g. a policy-driven create wasn't possible); `applyPolicyOnCreate` is a no-op when there
  // is no neon.ts on disk. Checking out an existing branch never reconciles it.
  if (created && !policyApplied) {
    await applyPolicyOnCreate({
      projectId,
      branchId,
      ...(props.apiKey ? { apiKey: props.apiKey } : {}),
      ...(props.apiHost ? { apiHost: props.apiHost } : {}),
    });
  }

  // Bundle `env pull` so the branch-first loop is just link + checkout: the branch you
  // checked out is immediately usable for local dev. `--no-env-pull` opts out.
  await autoPullEnvAfterPin({
    ...props,
    projectId,
    branch: branchId,
    envPull: props.envPull,
  });
};

/**
 * Resolve the branch id to check out.
 *
 * - Branch **id** (`br-…`): looked up by id. A non-existent id is a hard "not
 *   found" error — we never offer to create one, since ids are server-assigned.
 * - Branch **name**: looked up by name. If it doesn't exist, in an interactive
 *   terminal we offer to create it (like `neonctl branch create --name <name>`);
 *   in a non-interactive context it's the usual "not found" error.
 * - **Omitted**: open an interactive picker listing the project's branches plus a
 *   "create a new branch" option (TTY only); in a non-interactive context a missing
 *   branch is a hard error.
 */
type ResolvedBranch = {
  branchId: string;
  /** True only when this checkout created a new branch (vs. selecting an existing one). */
  created: boolean;
  /**
   * True when the branch was created straight from the local `neon.ts` policy (so its
   * settings/infra are already applied and the handler must not re-apply). False for an
   * existing branch or a bare create with no policy on disk.
   */
  policyApplied: boolean;
};

const resolveBranchId = async (
  props: CheckoutProps,
  projectId: string,
): Promise<ResolvedBranch> => {
  const branches = (await props.apiClient.listProjectBranches({ projectId }))
    .data.branches;

  if (!props.id) {
    const picked = await pickBranchInteractively(branches, {
      message: 'Which branch would you like to check out?',
      nonInteractiveMessage:
        'No branch specified. Pass a branch name or id (e.g. `neonctl checkout main`), ' +
        'or run interactively to pick one from a list.',
    });
    if (picked.kind === 'existing') {
      return {
        branchId: picked.branchId,
        created: false,
        policyApplied: false,
      };
    }
    // The user chose "create a new branch" from the picker.
    return createCheckoutBranch(props, projectId, picked.name, branches);
  }

  const ref = props.id;

  // A `br-…` value is an id; match strictly by id and never offer to create.
  if (looksLikeBranchId(ref)) {
    const byId = branches.find((b: Branch) => b.id === ref);
    if (byId) {
      return { branchId: byId.id, created: false, policyApplied: false };
    }
    throw new Error(notFoundMessage(ref, branches));
  }

  const byName = branches.find((b: Branch) => b.name === ref);
  if (byName) {
    return { branchId: byName.id, created: false, policyApplied: false };
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
  return createCheckoutBranch(props, projectId, ref, branches);
};

/**
 * Create the branch to check out. When a `neon.ts` exists, route through the policy-driven
 * create so the new branch comes up branched from the policy's `parent` and configured with
 * its declared TTL / compute / services (evaluated as a *new* branch). Otherwise fall back to
 * a bare branch off the default — the handler then applies the policy (a no-op with no
 * `neon.ts`).
 */
const createCheckoutBranch = async (
  props: CheckoutProps,
  projectId: string,
  name: string,
  branches: Branch[],
): Promise<ResolvedBranch> => {
  const fromPolicy = await createBranchFromPolicyOnCheckout({
    projectId,
    branchName: name,
    ...(props.apiKey ? { apiKey: props.apiKey } : {}),
    ...(props.apiHost ? { apiHost: props.apiHost } : {}),
  });
  if (fromPolicy) {
    return {
      branchId: fromPolicy.branchId,
      created: true,
      policyApplied: true,
    };
  }
  return {
    branchId: await createBranch(props.apiClient, projectId, name, branches),
    created: true,
    policyApplied: false,
  };
};

const notFoundMessage = (ref: string, branches: Branch[]): string =>
  `Branch ${ref} not found.\nAvailable branches: ${branches
    .map((b: Branch) => b.name)
    .join(', ')}`;

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
