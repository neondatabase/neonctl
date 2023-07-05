import { BranchScopeProps, CommonProps, ProjectScopeProps } from './types';

const HAIKU_REGEX = /^[a-z]+-[a-z]+-\d{6}$/;

export const branchIdResolve = async ({
  branch,
  apiClient,
  projectId,
}: {
  branch: string;
  apiClient: CommonProps['apiClient'];
  projectId: string;
}) => {
  if (branch.startsWith('br-') && HAIKU_REGEX.test(branch.substring(3))) {
    return branch;
  }

  const { data } = await apiClient.listProjectBranches(projectId);
  const branchData = data.branches.find((b) => b.name === branch);
  if (!branchData) {
    throw new Error(
      `Branch ${branch} not found.\nAvailable branches: ${data.branches
        .map((b) => b.name)
        .join(', ')}`
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
      projectId: props.project.id,
    });
  }

  const { data } = await props.apiClient.listProjectBranches(props.project.id);
  const primaryBranch = data.branches.find((b) => b.primary);

  if (primaryBranch) {
    return primaryBranch.id;
  }

  throw new Error('No primary branch found');
};

export const fillSingleProject = async (
  props: CommonProps & Partial<Pick<ProjectScopeProps, 'project'>>
) => {
  if (props.project) {
    return props;
  }
  const { data } = await props.apiClient.listProjects({});
  if (data.projects.length === 0) {
    throw new Error('No projects found');
  }
  if (data.projects.length > 1) {
    throw new Error(
      `Multiple projects found, please provide one with the --project.id option`
    );
  }
  return {
    ...props,
    project: { id: data.projects[0].id },
  };
};
