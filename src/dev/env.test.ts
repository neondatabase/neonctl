/* eslint-disable @typescript-eslint/require-await */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  GetConnectionUriInput,
  NeonApi,
  NeonAuthSnapshot,
  NeonBranchSnapshot,
  NeonBucketSnapshot,
  NeonDataApiSnapshot,
  NeonDatabaseSnapshot,
  NeonEndpointSnapshot,
  NeonFunctionDeploymentSnapshot,
  NeonFunctionSnapshot,
  NeonProjectSnapshot,
  NeonRoleSnapshot,
} from '@neondatabase/config';

import { resolveDevEnv } from './env.js';

const PROJECT_ID = 'patient-art-12345';
const BRANCH_ID = 'br-main-00000001';

type FakeOverrides = {
  /** Override `getNeonAuth`. Defaults to returning `null`. */
  getNeonAuth?: NeonApi['getNeonAuth'];
  /** Override `getNeonDataApi`. Defaults to returning `null`. */
  getNeonDataApi?: NeonApi['getNeonDataApi'];
  /** Override `listBranches` (e.g. to make it throw for the graceful-degrade case). */
  listBranches?: NeonApi['listBranches'];
};

/**
 * A full {@link NeonApi} implementation backed by fixed in-memory state for one
 * project + one default branch. Methods that `pullConfig` and `fetchEnv` exercise
 * return real data; everything else throws `not implemented` so an unexpected call
 * fails loudly instead of silently passing.
 */
class FakeNeonApi implements NeonApi {
  constructor(private readonly overrides: FakeOverrides = {}) {}

  async listProjects(): Promise<NeonProjectSnapshot[]> {
    throw new Error('not implemented');
  }

  async getProject(projectId: string): Promise<NeonProjectSnapshot> {
    return {
      id: projectId,
      name: 'dev-project',
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

  async listBranches(projectId: string): Promise<NeonBranchSnapshot[]> {
    if (this.overrides.listBranches) {
      return this.overrides.listBranches(projectId);
    }
    return [
      {
        id: BRANCH_ID,
        name: 'main',
        isDefault: true,
        protected: false,
      },
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
        id: 'ep-fake-1',
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

  async getNeonDataApi(
    projectId: string,
    branchId: string,
    databaseName: string,
  ): Promise<NeonDataApiSnapshot | null> {
    if (this.overrides.getNeonDataApi) {
      return this.overrides.getNeonDataApi(projectId, branchId, databaseName);
    }
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

  async createBranchFunction(): Promise<NeonFunctionSnapshot> {
    throw new Error('not implemented');
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
}

describe('resolveDevEnv', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'neonctl-dev-env-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('tier 3: no neon.ts and no project/branch -> {}', async () => {
    await expect(resolveDevEnv({ cwd })).resolves.toEqual({});
  });

  it('tier 2: no neon.ts but project + branch -> pooled + unpooled DATABASE_URL', async () => {
    const result = await resolveDevEnv({
      cwd,
      projectId: PROJECT_ID,
      branchId: BRANCH_ID,
      api: new FakeNeonApi(),
    });

    expect(result.DATABASE_URL).toContain('-pooler.fake.neon.tech');
    expect(result.DATABASE_URL_UNPOOLED).toBeDefined();
    expect(result.DATABASE_URL_UNPOOLED).not.toContain('-pooler.');
    expect(result.NEON_AUTH_BASE_URL).toBeUndefined();
  });

  it('tier 2 with Auth integration present: still only Postgres URLs (auth is not surfaced)', async () => {
    const api = new FakeNeonApi({
      getNeonAuth: async () => ({
        projectId: 'auth-project',
        jwksUrl: 'https://auth.fake.neon.tech/.well-known/jwks.json',
        baseUrl: 'https://auth.fake.neon.tech',
      }),
    });

    // Tier 2 derives its config from `pullConfig`, whose `buildPulledBranchConfig`
    // never emits an `auth` block. `resolveConfig` therefore resolves `authEnabled`
    // to `false`, so `fetchEnv` never calls `getNeonAuth` and NEON_AUTH_BASE_URL is
    // not injected — even when a live Neon Auth integration exists on the branch.
    // Enabling auth requires a tier-1 `neon.ts` policy that returns `auth: {}`
    // (covered by the tier-1 test below).
    const result = await resolveDevEnv({
      cwd,
      projectId: PROJECT_ID,
      branchId: BRANCH_ID,
      api,
    });

    expect(Object.keys(result).sort()).toEqual([
      'DATABASE_URL',
      'DATABASE_URL_UNPOOLED',
    ]);
    expect(result.NEON_AUTH_BASE_URL).toBeUndefined();
  });

  it('tier 1: a neon.ts policy enabling auth -> DATABASE_URL and NEON_AUTH_BASE_URL', async () => {
    writeFileSync(
      join(cwd, 'neon.ts'),
      'export default () => ({ auth: {} });\n',
    );

    const api = new FakeNeonApi({
      getNeonAuth: async () => ({
        projectId: 'auth-project',
        jwksUrl: 'https://auth.fake.neon.tech/.well-known/jwks.json',
        baseUrl: 'https://auth.fake.neon.tech',
      }),
    });

    const result = await resolveDevEnv({
      cwd,
      projectId: PROJECT_ID,
      branchId: BRANCH_ID,
      api,
    });

    expect(result.DATABASE_URL).toBeDefined();
    expect(result.DATABASE_URL_UNPOOLED).toBeDefined();
    expect(result.NEON_AUTH_BASE_URL).toBe('https://auth.fake.neon.tech');
  });

  it('graceful: an api whose listBranches throws -> {} (does not throw)', async () => {
    const api = new FakeNeonApi({
      listBranches: async () => {
        throw new Error('network down');
      },
    });

    await expect(
      resolveDevEnv({
        cwd,
        projectId: PROJECT_ID,
        branchId: BRANCH_ID,
        api,
      }),
    ).resolves.toEqual({});
  });
});
