import { describe, it, expect } from 'vitest';
import { getGithubEnvVars } from './env';

describe('getGithubEnvVars', () => {
  it('success all keys', () => {
    const env = {
      GITHUB_ACTION_PATH: '1',
      GITHUB_REPOSITORY: '2',
      GITHUB_RUN_ID: '3',
      GITHUB_RUN_NUMBER: '4',
      GITHUB_SERVER_URL: '5',
      GITHUB_WORKFLOW_REF: '6',
      RUNNER_ARCH: '7',
      RUNNER_ENVIRONMENT: '8',
      RUNNER_OS: '9',
      unrelated: 'unrelated',
    };

    const ret = {
      GITHUB_ACTION_PATH: '1',
      GITHUB_REPOSITORY: '2',
      GITHUB_RUN_ID: '3',
      GITHUB_RUN_NUMBER: '4',
      GITHUB_SERVER_URL: '5',
      GITHUB_WORKFLOW_REF: '6',
      RUNNER_ARCH: '7',
      RUNNER_ENVIRONMENT: '8',
      RUNNER_OS: '9',
    };

    expect(getGithubEnvVars(env)).toEqual(ret);
  });

  it('empty all keys', () => {
    expect(getGithubEnvVars({})).toEqual({});
  });

  it('action path', () => {
    expect(
      getGithubEnvVars({
        GITHUB_ACTION_PATH:
          '/home/runner/work/_actions/neondatabase/create-branch-action/v5',
      }),
    ).toEqual({
      GITHUB_ACTION_PATH: 'neondatabase/create-branch-action/v5',
    });

    expect(
      getGithubEnvVars({
        GITHUB_ACTION_PATH:
          '/home/runner/actions-runner/_work/actions/neondatabase/create-branch-action/v5',
      }),
    ).toEqual({
      GITHUB_ACTION_PATH: 'neondatabase/create-branch-action/v5',
    });

    expect(
      getGithubEnvVars({
        GITHUB_ACTION_PATH:
          'C:\\b\\_actions\\neondatabase\\create-branch-action\\v5',
      }),
    ).toEqual({
      GITHUB_ACTION_PATH:
        'C:\\b\\_actions\\neondatabase\\create-branch-action\\v5',
    });

    expect(
      getGithubEnvVars({
        GITHUB_ACTION_PATH:
          '/home/runner/work/app/app/./.github/actions/custom-action',
      }),
    ).toEqual({
      GITHUB_ACTION_PATH: 'custom-action',
    });
  });
});
