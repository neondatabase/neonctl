import { BranchScopeProps, CommonProps, ProjectScopeProps } from '../types.js';
import { looksLikeBranchId } from './formats.js';

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

  const { data } = await apiClient.listProjectBranches(projectId);
  const branchData = data.branches.find((b) => b.name === branch);
  if (!branchData) {
    throw new Error(
      `Branch ${branch} not found.\nAvailable branches: ${data.branches
        .map((b) => b.name)
        .join(', ')}`,
    );
  }
  return branchData.id;
};

export const branchIdFromProps = async (props: BranchScopeProps) => {
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

  const { data } = await props.apiClient.listProjectBranches(props.projectId);
  const defaultBranch = data.branches.find((b) => b.default);

  if (defaultBranch) {
    return defaultBranch.id;
  }

  throw new Error('No default branch found');
};

export const fillSingleProject = async (
  props: CommonProps & Partial<Pick<ProjectScopeProps, 'projectId'>>,
) => {
  if (props.projectId) {
    return props;
  }
  const { data } = await props.apiClient.listProjects({});
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
};
