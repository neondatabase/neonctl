import { BranchScopeProps, CommonProps, OrgScopeProps } from '../types.js';
import { looksLikeBranchId } from './formats.js';
import { Branch, Database } from '@neondatabase/api-client';
import { isAxiosError } from 'axios';

export const branchIdResolve = async ({
  branch,
  apiClient,
  projectId,
}: {
  branch: string | number;
  apiClient: CommonProps['apiClient'];
  projectId: string;
}) => {
  branch = branch.toString();
  if (looksLikeBranchId(branch)) {
    return branch;
  }

  const { data } = await apiClient.listProjectBranches({
    projectId,
  });
  const branchData = data.branches.find((b: Branch) => b.name === branch);
  if (!branchData) {
    throw new Error(
      `Branch ${branch} not found.\nAvailable branches: ${data.branches
        .map((b: Branch) => b.name)
        .join(', ')}`,
    );
  }
  return branchData.id;
};

const getBranchIdFromProps = async (props: BranchScopeProps) => {
  const branch =
    'branch' in props && typeof props.branch === 'string'
      ? props.branch
      : (props as any).id;

  if (branch) {
    return await branchIdResolve({
      branch,
      apiClient: props.apiClient,
      projectId: props.projectId,
    });
  }

  const { data } = await props.apiClient.listProjectBranches({
    projectId: props.projectId,
  });
  const defaultBranch = data.branches.find((b: Branch) => b.default);

  if (defaultBranch) {
    return defaultBranch.id;
  }

  throw new Error('No default branch found');
};

export const branchIdFromProps = async (props: BranchScopeProps) => {
  (props as any).branchId = await getBranchIdFromProps(props);
  return (props as any).branchId;
};

/**
 * The branch a command is about to act on, resolved to **both** its id and its
 * human-readable name so callers can confirm the target to the user (see
 * {@link announceTargetBranch}) before mutating it.
 *
 * Resolution mirrors {@link branchIdFromProps}: an explicit `branch`/`id`
 * (name or `br-…` id) wins, otherwise the project's default branch is used. The
 * difference is that this always carries the name back, so it lists the
 * project's branches even for a `br-…` id (to look up the name). A `br-…` id the
 * listing doesn't return is still trusted as an id (matching `branchIdResolve`),
 * just with no friendlier name to show; a *name* that doesn't resolve is the
 * same hard error as before.
 */
export type ResolvedBranchRef = {
  branchId: string;
  /** Friendly branch name when known, otherwise the id. */
  branchName: string;
  /** True when no branch was specified and the project's default was used. */
  usedDefault: boolean;
};

export const resolveBranchRef = async (
  props: BranchScopeProps,
): Promise<ResolvedBranchRef> => {
  const branch =
    'branch' in props && typeof props.branch === 'string'
      ? props.branch
      : (props as any).id;

  const { data } = await props.apiClient.listProjectBranches({
    projectId: props.projectId,
  });
  const branches = data.branches;

  if (branch) {
    const ref = branch.toString();
    const found = looksLikeBranchId(ref)
      ? branches.find((b: Branch) => b.id === ref)
      : branches.find((b: Branch) => b.name === ref);
    if (found) {
      return {
        branchId: found.id,
        branchName: found.name ?? found.id,
        usedDefault: false,
      };
    }
    // A `br-…` id absent from the listing is still usable as an id (trust it like
    // branchIdResolve does); only an unresolved *name* is a genuine error.
    if (looksLikeBranchId(ref)) {
      return { branchId: ref, branchName: ref, usedDefault: false };
    }
    throw new Error(
      `Branch ${ref} not found.\nAvailable branches: ${branches
        .map((b: Branch) => b.name)
        .join(', ')}`,
    );
  }

  const defaultBranch = branches.find((b: Branch) => b.default);
  if (!defaultBranch) {
    throw new Error('No default branch found');
  }
  return {
    branchId: defaultBranch.id,
    branchName: defaultBranch.name ?? defaultBranch.id,
    usedDefault: true,
  };
};

export const resolveSingleDatabase = async (props: {
  apiClient: CommonProps['apiClient'];
  projectId: string;
  branchId: string;
  database?: string;
}): Promise<string> => {
  const { data } = await props.apiClient.listProjectBranchDatabases(
    props.projectId,
    props.branchId,
  );
  const databases = data.databases;

  if (props.database !== undefined) {
    if (!databases.find((d: Database) => d.name === props.database)) {
      throw new Error(
        `Database not found: ${props.database}. Available databases on branch ${props.branchId}: ${databases.map((d: Database) => d.name).join(', ')}`,
      );
    }
    return props.database;
  }

  if (databases.length === 0) {
    throw new Error(`No databases found for the branch: ${props.branchId}`);
  }
  if (databases.length === 1) {
    return databases[0].name;
  }
  throw new Error(
    `Multiple databases found for the branch, please provide one with the --database option: ${databases.map((d: Database) => d.name).join(', ')}`,
  );
};

export const fillSingleProject = async (
  props: CommonProps & { projectId?: string; orgId?: string },
) => {
  if (props.projectId) {
    return { ...props, projectId: props.projectId };
  }

  // If no orgId is provided, try to auto-fill it if there's only one org
  let orgId = props.orgId;
  if (!orgId) {
    const { data: orgsData } =
      await props.apiClient.getCurrentUserOrganizations();
    if (orgsData.organizations.length === 1) {
      orgId = orgsData.organizations[0].id;
    }
  }

  try {
    const { data } = await props.apiClient.listProjects({
      limit: 2,
      org_id: orgId,
    });
    if (data.projects.length === 0) {
      throw new Error('No projects found');
    }
    if (data.projects.length > 1) {
      throw new Error(
        `Multiple projects found, please provide one with the --project-id option`,
      );
    }
    return {
      ...props,
      projectId: data.projects[0].id,
    };
  } catch (error) {
    // If the API error is about missing org_id, provide a user-friendly message
    if (
      isAxiosError(error) &&
      error.response?.status === 400 &&
      error.response?.data?.message?.includes('org_id is required')
    ) {
      throw new Error(
        'Multiple projects found, please provide one with the --project-id option',
      );
    }
    throw error;
  }
};

export const fillSingleOrg = async (props: OrgScopeProps) => {
  if (props.orgId) {
    return props;
  }
  const { data } = await props.apiClient.getCurrentUserOrganizations();
  if (data.organizations.length === 0) {
    throw new Error('No organizations found');
  }
  if (data.organizations.length > 1) {
    throw new Error(
      `Multiple organizations found, please provide one with the --org-id option`,
    );
  }
  return { ...props, orgId: data.organizations[0].id };
};
