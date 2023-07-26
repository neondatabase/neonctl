const HAIKU_REGEX = /^[a-z]+-[a-z]+-\d+$/;

export const looksLikeBranchId = (branch: string) =>
  branch.startsWith('br-') && HAIKU_REGEX.test(branch.substring(3));

const LSN_REGEX = /^[a-fA-F0-9]{1,8}\/[a-fA-F0-9]{1,8}$/;

export const looksLikeLSN = (lsn: string) => LSN_REGEX.test(lsn);

export const looksLikeTimestamp = (timestamp: string) =>
  !isNaN(Date.parse(timestamp));
