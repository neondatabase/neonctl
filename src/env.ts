export const isCi = () => {
  return process.env.CI !== 'false' && Boolean(process.env.CI);
};

export const isDebug = () => {
  return Boolean(process.env.DEBUG);
};

export const getGithubEnvironmentVars = () => {
  const vars = [
    // github action info
    'GITHUB_ACTION',
    'GITHUB_ACTION_PATH',
    'GITHUB_ACTION_REPOSITORY',

    // source github repository and actor info
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
    'GITHUB_TRIGGERING_ACTOR',
    'GITHUB_ACTOR',
    'GITHUB_ACTOR_ID',
    'GITHUB_EVENT_NAME',
    'GITHUB_RUN_NUMBER',

    // reusable workflow info
    'GITHUB_WORKFLOW',
    'GITHUB_WORKFLOW_REF',
    'GITHUB_WORKFLOW_SHA',
  ];

  const map = new Map();
  vars.forEach((v) => {
    if (process.env[v]) {
      map.set(v, process.env[v]);
    }
  });

  return map;
};
