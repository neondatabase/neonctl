export const isCi = () => {
  return process.env.CI !== 'false' && Boolean(process.env.CI);
};

export const isDebug = () => {
  return Boolean(process.env.DEBUG);
};

export const getGithubEnvVars = (env: Dict<string>) => {
  const vars = [
    // github action info
    'GITHUB_ACTION_PATH',

    // source github repository
    'GITHUB_REPOSITORY',

    // environment info
    'GITHUB_RUN_ID',
    'GITHUB_RUN_NUMBER',
    'GITHUB_SERVER_URL',
    'GITHUB_WORKFLOW_REF',
    'RUNNER_ARCH',
    'RUNNER_ENVIRONMENT',
    'RUNNER_OS',
  ];

  const map = new Map();
  vars.forEach((v) => {
    let value = env[v];
    if (value === undefined || value === '') {
      return;
    }
    if (v === 'GITHUB_ACTION_PATH') {
      value = value.includes('actions/')
        ? value.replace(/^.*actions\/(.+)$/, '$1')
        : value;
    }

    map.set(v, value);
  });

  return Object.fromEntries(map);
};
