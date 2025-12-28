import {
  BranchScopeProps,
  CommonProps,
  ProjectScopeProps,
  OrgScopeProps,
} from '../types.js';
import { looksLikeBranchId } from './formats.js';
import { Branch } from '@neondatabase/api-client';
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

export const fillSingleProject = async (
  props: ProjectScopeProps & { orgId?: string },
) => {
  if (props.projectId) {
    return props;
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
