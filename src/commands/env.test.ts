/* eslint-disable @typescript-eslint/require-await */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NeonApi } from '@neondatabase/config';
import type {
  CreateCredentialInput,
  GetConnectionUriInput,
  NeonAuthSnapshot,
  NeonBranchSnapshot,
  NeonBranchStorageSnapshot,
  NeonBucketSnapshot,
  NeonCredentialMeta,
  NeonCredentialSecret,
  NeonDataApiSnapshot,
  NeonDatabaseSnapshot,
  NeonEndpointSnapshot,
  NeonFunctionDeploymentSnapshot,
  NeonFunctionSnapshot,
  NeonProjectSnapshot,
  NeonRoleSnapshot,
} from '@neondatabase/config';

import { autoPullEnvAfterPin, pull, type EnvPullProps } from './env.js';

const PROJECT_ID = 'patient-art-12345';
const BRANCH_ID = 'br-snowy-frost-12345';
const BRANCH_NAME = 'main';

type FakeOverrides = {
  getNeonAuth?: NeonApi['getNeonAuth'];
};

/**
 * Minimal {@link NeonApi} for one project + default branch, with the methods `pullConfig`
 * and `fetchEnv` exercise (env-pull's tier-2 path). Auth defaults to off; override to test
 * the NEON_AUTH_BASE_URL pull.
 */
class FakeNeonApi implements NeonApi {
  constructor(private readonly overrides: FakeOverrides = {}) {}

  async listProjects(): Promise<NeonProjectSnapshot[]> {
    throw new Error('not implemented');
  }
  async getProject(projectId: string): Promise<NeonProjectSnapshot> {
    return {
      id: projectId,
      name: 'p',
      regionId: 'aws-us-east-1',
      pgVersion: 17,
    };
  }
  async createProject(): Promise<NeonProjectSnapshot> {
    throw new Error('not implemented');
  }
  async updateProject(): Promise<NeonProjectSnapshot> {
    throw new Error('not implemented');
  }
  async listBranches(): Promise<NeonBranchSnapshot[]> {
    return [
      { id: BRANCH_ID, name: BRANCH_NAME, isDefault: true, protected: false },
    ];
  }
  async createBranch(): Promise<{
    branch: NeonBranchSnapshot;
    endpoints: NeonEndpointSnapshot[];
  }> {
    throw new Error('not implemented');
  }
  async updateBranch(): Promise<NeonBranchSnapshot> {
    throw new Error('not implemented');
  }
  async listEndpoints(): Promise<NeonEndpointSnapshot[]> {
    return [
      {
        id: 'ep-1',
        branchId: BRANCH_ID,
        type: 'read_write',
        autoscalingLimitMinCu: 0.25,
        autoscalingLimitMaxCu: 0.25,
        suspendTimeout: '5m',
      },
    ];
  }
  async updateEndpoint(): Promise<NeonEndpointSnapshot> {
    throw new Error('not implemented');
  }
  async listBranchRoles(
    projectId: string,
    branchId: string,
  ): Promise<NeonRoleSnapshot[]> {
    void projectId;
    return [{ name: 'neondb_owner', branchId, protected: false }];
  }
  async listBranchDatabases(
    projectId: string,
    branchId: string,
  ): Promise<NeonDatabaseSnapshot[]> {
    void projectId;
    return [{ name: 'neondb', branchId, ownerName: 'neondb_owner' }];
  }
  async getConnectionUri(
    projectId: string,
    input: GetConnectionUriInput,
  ): Promise<{ uri: string }> {
    void projectId;
    const host = input.pooled
      ? `${BRANCH_ID}-pooler.fake.neon.tech`
      : `${BRANCH_ID}.fake.neon.tech`;
    return {
      uri: `postgresql://${input.roleName}:pw@${host}/${input.databaseName}?sslmode=require`,
    };
  }
  async getNeonAuth(
    projectId: string,
    branchId: string,
  ): Promise<NeonAuthSnapshot | null> {
    if (this.overrides.getNeonAuth) {
      return this.overrides.getNeonAuth(projectId, branchId);
    }
    return null;
  }
  async enableNeonAuth(): Promise<NeonAuthSnapshot> {
    throw new Error('not implemented');
  }
  async getNeonDataApi(): Promise<NeonDataApiSnapshot | null> {
    return null;
  }
  async enableProjectBranchDataApi(): Promise<NeonDataApiSnapshot> {
    throw new Error('not implemented');
  }
  async listBranchBuckets(): Promise<NeonBucketSnapshot[]> {
    return [];
  }
  async createBranchBucket(): Promise<NeonBucketSnapshot> {
    throw new Error('not implemented');
  }
  async deleteBranchBucket(): Promise<void> {
    throw new Error('not implemented');
  }
  async listBranchFunctions(): Promise<NeonFunctionSnapshot[]> {
    return [];
  }
  async deleteBranchFunction(): Promise<void> {
    throw new Error('not implemented');
  }
  async deployBranchFunction(): Promise<NeonFunctionDeploymentSnapshot> {
    throw new Error('not implemented');
  }
  async getAiGatewayEnabled(): Promise<boolean> {
    return false;
  }
  async enableAiGateway(): Promise<void> {
    throw new Error('not implemented');
  }
  async disableAiGateway(): Promise<void> {
    throw new Error('not implemented');
  }
  async createCredential(
    _projectId: string,
    branchId: string,
    input: CreateCredentialInput,
  ): Promise<NeonCredentialSecret> {
    return {
      tokenId: 'cred-fake-0000',
      tokenIdShort: 'credfake0000',
      apiToken: 'nt_live_credfake0000_secret',
      s3SecretAccessKey: 's3secret'.padEnd(64, '0'),
      scopes: input.scopes,
      branchId,
      createdAt: '2026-01-01T00:00:00Z',
    };
  }
  async listCredentials(): Promise<NeonCredentialMeta[]> {
    return [];
  }
  async revokeCredential(): Promise<void> {
    return;
  }
  async getProjectBranchStorage(): Promise<NeonBranchStorageSnapshot | null> {
    return {
      s3Endpoint: 'https://fake.storage.neon.tech',
      region: 'us-east-1',
      forcePathStyle: true,
    };
  }
}

/** Stand-in for the neonctl Api client; only branch resolution is exercised. */
const fakeApiClient = {
  listProjectBranches: async () => ({
    data: {
      branches: [{ id: BRANCH_ID, name: BRANCH_NAME, default: true }],
    },
  }),
};

const baseProps = (api: FakeNeonApi, cwd: string): EnvPullProps => ({
  apiClient: fakeApiClient as never,
  apiKey: '',
  apiHost: 'https://console.neon.tech/api/v2',
  contextFile: '',
  output: 'table',
  projectId: PROJECT_ID,
  branch: BRANCH_NAME,
  cwd,
  runtimeApi: api,
});

describe('env pull', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'neonctl-env-pull-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('writes Neon vars into .env.local when no .env exists', async () => {
    await pull(baseProps(new FakeNeonApi(), cwd));

    const content = readFileSync(join(cwd, '.env.local'), 'utf8');
    expect(content).toMatch(/^DATABASE_URL=/m);
    expect(content).toMatch(/^DATABASE_URL_UNPOOLED=/m);
    expect(content).toContain('-pooler.fake.neon.tech');
    // Auth is off by default, so NEON_AUTH_BASE_URL is not written.
    expect(content).not.toContain('NEON_AUTH_BASE_URL');
  });

  it('includes NEON_AUTH_BASE_URL when the branch has Auth enabled', async () => {
    // A neon.ts that enables auth, plus a branch that actually has the integration.
    writeFileSync(join(cwd, 'neon.ts'), 'export default { auth: {} };\n');
    const api = new FakeNeonApi({
      getNeonAuth: async () => ({
        projectId: 'auth-project',
        jwksUrl: 'https://auth.fake.neon.tech/.well-known/jwks.json',
        baseUrl: 'https://auth.fake.neon.tech',
      }),
    });

    await pull(baseProps(api, cwd));

    const content = readFileSync(join(cwd, '.env.local'), 'utf8');
    expect(content).toMatch(
      /^NEON_AUTH_BASE_URL=https:\/\/auth\.fake\.neon\.tech$/m,
    );
  });

  it('updates an existing .env in place, preserving other keys', async () => {
    writeFileSync(
      join(cwd, '.env'),
      '# app\nAPP_NAME=demo\nDATABASE_URL=postgres://stale\n',
    );

    await pull(baseProps(new FakeNeonApi(), cwd));

    // Existing .env is used (not .env.local) and unrelated keys survive.
    const content = readFileSync(join(cwd, '.env'), 'utf8');
    expect(content).toContain('# app');
    expect(content).toContain('APP_NAME=demo');
    expect(content).toContain('-pooler.fake.neon.tech');
    expect(content).not.toContain('postgres://stale');
  });

  it('writes to an explicit --file', async () => {
    await pull({ ...baseProps(new FakeNeonApi(), cwd), file: '.env.preview' });
    const content = readFileSync(join(cwd, '.env.preview'), 'utf8');
    expect(content).toMatch(/^DATABASE_URL=/m);
  });
});

/**
 * Branch-level `getConnectionUri` failure, to exercise the auto-pull failure path. The pin
 * (`link` / `checkout`) has already happened by the time auto-pull runs, so a pull failure
 * must degrade to a non-throwing `failed` result rather than tearing down the command.
 */
class UnreachableNeonApi extends FakeNeonApi {
  override async getConnectionUri(): Promise<{ uri: string }> {
    throw new Error('boom: Neon API unreachable');
  }
}

describe('autoPullEnvAfterPin (bundled into link / checkout)', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'neonctl-auto-pull-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('pulls by default, writing the branch vars into .env.local', async () => {
    const result = await autoPullEnvAfterPin({
      ...baseProps(new FakeNeonApi(), cwd),
      envPull: true,
    });

    expect(result.status).toBe('written');
    const content = readFileSync(join(cwd, '.env.local'), 'utf8');
    expect(content).toMatch(/^DATABASE_URL=/m);
  });

  it('skips the pull (writing nothing) when --no-env-pull is passed', async () => {
    const result = await autoPullEnvAfterPin({
      ...baseProps(new FakeNeonApi(), cwd),
      envPull: false,
    });

    expect(result).toEqual({ status: 'skipped' });
    expect(existsSync(join(cwd, '.env.local'))).toBe(false);
    expect(existsSync(join(cwd, '.env'))).toBe(false);
  });

  it('degrades a pull failure to a warning instead of throwing (the pin still stands)', async () => {
    const result = await autoPullEnvAfterPin({
      ...baseProps(new UnreachableNeonApi(), cwd),
      envPull: true,
    });

    expect(result.status).toBe('failed');
    // Nothing is written when the pull fails before resolving any vars.
    expect(existsSync(join(cwd, '.env.local'))).toBe(false);
  });
});
