import { Api } from '@neondatabase/api-client';
import { looksLikeLSN, looksLikeTimestamp } from './formats.js';
import { branchIdResolve } from './enrichers.js';

export type PointInTime =
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
    };
export type PointInTimeBranchId = {
  branchId: string;
} & PointInTime;

export type PointInTimeBranch = {
  branch: string;
} & PointInTime;

export type PointInTimeProps = {
  targetBranchId: string;
  pointInTime: string;
  projectId: string;
  api: Api<unknown>;
};

export class PointInTimeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PointInTimeParseError';
  }
}

export const parsePITBranch = (input: string) => {
  const splitIndex = input.lastIndexOf('@');
  const sourceBranch = splitIndex === -1 ? input : input.slice(0, splitIndex);
  const exactPIT = splitIndex === -1 ? null : input.slice(splitIndex + 1);
  const result = {
    branch: sourceBranch,
    ...(exactPIT === null
      ? { tag: 'head' }
      : looksLikeLSN(exactPIT)
        ? { tag: 'lsn', lsn: exactPIT }
        : { tag: 'timestamp', timestamp: exactPIT }),
  } satisfies PointInTimeBranch;
  if (result.tag === 'timestamp') {
    const timestamp = result.timestamp;
    if (!looksLikeTimestamp(timestamp)) {
      throw new PointInTimeParseError(
        `Invalid source branch format - ${input}`,
      );
    }
    if (Date.parse(timestamp) > Date.now()) {
      throw new PointInTimeParseError(
        `Timestamp can not be in future - ${input}`,
      );
    }
  }
  return result;
};

export const parsePointInTime = async ({
  pointInTime,
  targetBranchId,
  projectId,
  api,
}: PointInTimeProps): Promise<PointInTimeBranchId> => {
  const parsedPIT = parsePITBranch(pointInTime);

  let branchId = '';
  if (parsedPIT.branch === '^self') {
    branchId = targetBranchId;
  } else if (parsedPIT.branch === '^parent') {
    const { data } = await api.getProjectBranch(projectId, targetBranchId);
    const { parent_id: parentId } = data.branch;
    if (parentId == null) {
      throw new PointInTimeParseError('Branch has no parent');
    }
    branchId = parentId;
  } else {
    branchId = await branchIdResolve({
      branch: parsedPIT.branch,
      projectId,
      apiClient: api,
    });
  }

  // @ts-expect-error extracting pit from parsedPIT
  delete parsedPIT.branch;
  return { ...parsedPIT, branchId };
};
