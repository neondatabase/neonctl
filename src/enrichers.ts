import { BranchScopeProps, CommonProps } from './types';

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
    throw new Error(`Branch ${branch} not found`);
  }
  return branchData.id;
};

export const branchIdFromProps = async (props: BranchScopeProps) =>
  branchIdResolve({
    branch:
      'branch' in props && typeof props.branch === 'string'
        ? props.branch
        : (props as any).id,
    apiClient: props.apiClient,
    projectId: props.project.id,
  });
