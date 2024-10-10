import { describe, it, expect } from 'vitest';
import { getGithubEnvVars } from './env';

describe('getGithubEnvVars', () => {
  it('success all keys', () => {
    const env = {
      GITHUB_ACTION: '1',
      GITHUB_ACTION_PATH: '2',
      GITHUB_ACTION_REPOSITORY: '3',
      GITHUB_REF_TYPE: '4',
      GITHUB_REF: '5',
      GITHUB_REF_NAME: '6',
      GITHUB_BASE_REF: '7',
      GITHUB_HEAD_REF: '8',
      GITHUB_JOB: '9',
      GITHUB_SHA: '10',
      GITHUB_REPOSITORY: '11',
      GITHUB_REPOSITORY_ID: '12',
      GITHUB_REPOSITORY_OWNER: '13',
      GITHUB_REPOSITORY_OWNER_ID: '14',
      GITHUB_TRIGGERING_ACTOR: '15',
      GITHUB_ACTOR: '16',
      GITHUB_ACTOR_ID: '17',
      GITHUB_EVENT_NAME: '18',
      GITHUB_RUN_NUMBER: '19',
      GITHUB_WORKFLOW: '20',
      GITHUB_WORKFLOW_REF: '21',
      GITHUB_WORKFLOW_SHA: '22',
      unrelated: 'unrelated',
    };

    const ret = {
      GITHUB_ACTION: '1',
      GITHUB_ACTION_PATH: '2',
      GITHUB_ACTION_REPOSITORY: '3',
      GITHUB_REF_TYPE: '4',
      GITHUB_REF: '5',
      GITHUB_REF_NAME: '6',
      GITHUB_BASE_REF: '7',
      GITHUB_HEAD_REF: '8',
      GITHUB_JOB: '9',
      GITHUB_SHA: '10',
      GITHUB_REPOSITORY: '11',
      GITHUB_REPOSITORY_ID: '12',
      GITHUB_REPOSITORY_OWNER: '13',
      GITHUB_REPOSITORY_OWNER_ID: '14',
      GITHUB_TRIGGERING_ACTOR: '15',
      GITHUB_ACTOR: '16',
      GITHUB_ACTOR_ID: '17',
      GITHUB_EVENT_NAME: '18',
      GITHUB_RUN_NUMBER: '19',
      GITHUB_WORKFLOW: '20',
      GITHUB_WORKFLOW_REF: '21',
      GITHUB_WORKFLOW_SHA: '22',
    };

    expect(getGithubEnvVars(env)).toEqual(ret);
  });
});
