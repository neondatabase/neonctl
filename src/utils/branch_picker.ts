import { Api, Branch, EndpointType } from '@neondatabase/api-client';
import prompts from 'prompts';

import { retryOnLock } from '../api.js';
import { log } from '../log.js';
import { isCi } from '../env.js';

/**
 * Outcome of the interactive branch picker: either an existing branch's id was chosen, or
 * the user opted to create a new branch and supplied its name. Shared by `neonctl checkout`
 * and `neonctl link` so both offer the same "create or pick" experience.
 */
export type PickedBranch =
  | { kind: 'existing'; branchId: string }
  | { kind: 'create'; name: string };

/** Sentinel `value` for the "create a new branch" choice (no branch id can collide). */
const CREATE_BRANCH_CHOICE = Symbol('create-branch');

/**
 * Render a branch's display name with the same word labels as `neonctl branch list`
 * (`[default]`, `[protected]`) instead of symbols, so the picker reads clearly.
 */
const branchLabel = (branch: Branch): string => {
  const labels: string[] = [];
  if (branch.default) {
    labels.push('[default]');
  }
  if (branch.protected) {
    labels.push('[protected]');
  }
  labels.push(branch.name);
  return labels.join(' ');
};

/**
 * Prompt the user to pick a branch from `branches`, with a "＋ Create a new branch…" option
 * pinned to the top (mirroring the project/org pickers). The default selection is the
 * project's default branch (the create option sits at index 0, so the default index is
 * offset by one).
 *
 * Throws `opts.nonInteractiveMessage` when there is no TTY (or in CI): the caller knows the
 * right guidance for its command, so the message is supplied rather than hard-coded here.
 */
export const pickBranchInteractively = async (
  branches: Branch[],
  opts: { message: string; nonInteractiveMessage: string },
): Promise<PickedBranch> => {
  if (isCi() || !process.stdout.isTTY) {
    throw new Error(opts.nonInteractiveMessage);
  }
  const defaultBranchIndex = branches.findIndex((b: Branch) => b.default);
  const initial = defaultBranchIndex >= 0 ? defaultBranchIndex + 1 : 0;
  const { choice } = await prompts({
    type: 'select',
    name: 'choice',
    message: opts.message,
    choices: [
      { title: '＋ Create a new branch…', value: CREATE_BRANCH_CHOICE },
      ...branches.map((b: Branch) => ({
        title: `${branchLabel(b)} (${b.id})`,
        value: b.id,
      })),
    ],
    initial,
  });
  if (choice === undefined) {
    throw new Error('Aborted: no branch selected.');
  }
  if (choice === CREATE_BRANCH_CHOICE) {
    return { kind: 'create', name: await promptNewBranchName(branches) };
  }
  return { kind: 'existing', branchId: choice as string };
};

/**
 * Prompt for a new branch name, rejecting empty input and names already taken on the
 * project (so we never silently select a different, pre-existing branch).
 */
export const promptNewBranchName = async (
  branches: Branch[],
): Promise<string> => {
  const existing = new Set(branches.map((b: Branch) => b.name));
  const { name } = await prompts({
    type: 'text',
    name: 'name',
    message: 'New branch name:',
    validate: (value: string) => {
      const trimmed = value.trim();
      if (trimmed === '') return 'Branch name cannot be empty.';
      if (existing.has(trimmed))
        return `A branch named "${trimmed}" already exists.`;
      return true;
    },
  });
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed === '') {
    throw new Error('Aborted: no branch name provided.');
  }
  return trimmed;
};

/**
 * Create a branch with the same defaults as `neonctl branch create --name <name>`:
 * branched from the project's default branch with a read-write compute endpoint. Returns
 * the new branch id.
 */
export const createBranch = async (
  apiClient: Api<unknown>,
  projectId: string,
  name: string,
  branches: Branch[],
): Promise<string> => {
  const defaultBranch = branches.find((b: Branch) => b.default);
  if (!defaultBranch) {
    throw new Error('No default branch found');
  }
  const { data } = await retryOnLock(() =>
    apiClient.createProjectBranch(projectId, {
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
