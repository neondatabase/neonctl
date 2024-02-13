import { Api } from '@neondatabase/api-client';
import { looksLikeLSN, looksLikeTimestamp } from './formats.js';
import { branchIdResolve } from './enrichers.js';

export type PointInTime = {
  branchId: string;
} & (
  | {
      tag: 'head';
    }
  | {
      tag: 'lsn';
      lsn: string;
    }
  | {
      tag: 'timestamp';
      timestamp: string;
    }
);

export interface PointInTimeProps {
  targetBranchId: string;
  pointInTime: string;
  projectId: string;
  api: Api<unknown>;
}

export class PointInTimeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PointInTimeParseError';
  }
}

export const parsePointInTime = async ({
  pointInTime,
  targetBranchId,
  projectId,
  api,
}: PointInTimeProps) => {
  const splitIndex = pointInTime.lastIndexOf('@');
  const sourceBranch =
    splitIndex === -1 ? pointInTime : pointInTime.slice(0, splitIndex);
  const exactPIT = splitIndex === -1 ? null : pointInTime.slice(splitIndex + 1);

  const result = {
    branchId: '',
    ...(exactPIT === null
      ? { tag: 'head' }
      : looksLikeLSN(exactPIT)
        ? { tag: 'lsn', lsn: exactPIT }
        : { tag: 'timestamp', timestamp: exactPIT }),
  } satisfies PointInTime;

  if (result.tag === 'timestamp' && !looksLikeTimestamp(result.timestamp)) {
    throw new PointInTimeParseError('Invalid source branch format');
  }

  if (sourceBranch === '^self') {
    return {
      ...result,
      branchId: targetBranchId,
    };
  }

  if (sourceBranch === '^parent') {
    const { data } = await api.getProjectBranch(projectId, targetBranchId);
    const { parent_id: parentId } = data.branch;
    if (parentId == null) {
      throw new PointInTimeParseError('Branch has no parent');
    }
    return { ...result, branchId: parentId };
  }

  const branchId = await branchIdResolve({
    branch: sourceBranch,
    projectId,
    apiClient: api,
  });

  return { ...result, branchId };
};
