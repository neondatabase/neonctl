export const isCi = () => {
  return process.env.CI !== 'false' && Boolean(process.env.CI);
};

export const isDebug = () => {
  return Boolean(process.env.DEBUG);
};

export const getGithubEnvironmentVars = () => {
  const vars = [
    'GITHUB_ACTION',
    'GITHUB_ACTION_PATH',
    'GITHUB_ACTION_REPOSITORY',
    'GITHUB_TRIGGERING_ACTOR',
    'GITHUB_ACTOR',
    'GITHUB_ACTOR_ID',
    'GITHUB_EVENT_NAME',
    'GITHUB_RUN_NUMBER',

    'GITHUB_REF_TYPE',
    'GITHUB_REF',
    'GITHUB_REF_NAME',
    'GITHUB_BASE_REF',
    'GITHUB_HEAD_REF',
    'GITHUB_JOB',
    'GITHUB_SHA',
    'GITHUB_REPOSITORY',
    'GITHUB_REPOSITORY_ID',
    'GITHUB_REPOSITORY_OWNER',
    'GITHUB_REPOSITORY_OWNER_ID',

    'GITHUB_WORKFLOW',
    'GITHUB_WORKFLOW_REF',
    'GITHUB_WORKFLOW_SHA',
  ];
  return vars.map((item) => {
    return { item: process.env[item] };
  });
};
