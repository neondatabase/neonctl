/* eslint-disable @typescript-eslint/require-await */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NeonApi } from '@neondatabase/config-runtime';
import type {
  CreateBucketInput,
  DeployFunctionInput,
  GetConnectionUriInput,
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

import type { ConfigProps } from './config.js';
import { applyCmd, applyPolicyOnCreate, planCmd, status } from './config.js';

const PROJECT_ID = 'patient-art-12345';
const BRANCH_ID = 'br-snowy-frost-12345';
const BRANCH_NAME = 'main';

/**
 * Full {@link NeonApi} implementation backed by fixed in-memory state for one
 * project + one default branch. The handful of methods that `inspect` / `plan` /
 * `apply` exercise return real data; everything else throws so an unexpected call
 * fails loudly instead of silently passing. `enableNeonAuth` records its calls so
 * a test can assert `apply` actually mutated remote state.
 */
class FakeNeonApi implements NeonApi {
  readonly enableNeonAuthCalls: { projectId: string; branchId: string }[] = [];
  readonly deployBranchFunctionCalls: {
    projectId: string;
    branchId: string;
    slug: string;
    input: DeployFunctionInput;
  }[] = [];

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

  async listBranches(): Promise<NeonBranchSnapshot[]> {
    return [
      {
        id: BRANCH_ID,
        name: BRANCH_NAME,
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
    return {
      uri: `postgresql://${input.roleName}:pw@${BRANCH_ID}.fake.neon.tech/${input.databaseName}?sslmode=require`,
    };
  }

  async getNeonAuth(): Promise<NeonAuthSnapshot | null> {
    return null;
  }

  async enableNeonAuth(
    projectId: string,
    branchId: string,
  ): Promise<NeonAuthSnapshot> {
    this.enableNeonAuthCalls.push({ projectId, branchId });
    return {
      projectId: 'auth-project',
      jwksUrl: 'https://auth.fake.neon.tech/.well-known/jwks.json',
      baseUrl: 'https://auth.fake.neon.tech',
    };
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

  async createBranchBucket(
    projectId: string,
    branchId: string,
    input: CreateBucketInput,
  ): Promise<NeonBucketSnapshot> {
    void projectId;
    void branchId;
    return { name: input.name, accessLevel: input.accessLevel ?? 'private' };
  }

  async deleteBranchBucket(): Promise<void> {
    throw new Error('not implemented');
  }

  async listBranchFunctions(): Promise<NeonFunctionSnapshot[]> {
    return [];
  }

  async createBranchFunction(
    projectId: string,
    branchId: string,
    input: { slug: string; name: string },
  ): Promise<NeonFunctionSnapshot> {
    void projectId;
    void branchId;
    return {
      id: `fn-${input.slug}`,
      slug: input.slug,
      name: input.name,
      invocationUrl: `https://${input.slug}.${BRANCH_ID}.fake.neon.tech`,
    };
  }

  async deleteBranchFunction(): Promise<void> {
    throw new Error('not implemented');
  }

  async deployBranchFunction(
    projectId: string,
    branchId: string,
    slug: string,
    input: DeployFunctionInput,
  ): Promise<NeonFunctionDeploymentSnapshot> {
    this.deployBranchFunctionCalls.push({ projectId, branchId, slug, input });
    return { id: 1, status: 'completed' };
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

/**
 * Minimal stand-in for the neonctl `Api` client. Only `listProjectBranches` is
 * exercised (by `branchIdFromProps`, to resolve the branch name to its id);
 * anything else is absent and would throw if touched.
 */
const fakeApiClient = {
  listProjectBranches: async () => ({
    data: {
      branches: [
        {
          id: BRANCH_ID,
          name: BRANCH_NAME,
          default: true,
        },
      ],
    },
  }),
};

/** Capture writer output (the writer respects `props.out`). */
const captureOut = (): { stream: PassThrough; read: () => string } => {
  const stream = new PassThrough();
  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
  });
  return { stream, read: () => buffer };
};

const baseProps = (
  api: FakeNeonApi,
  out: PassThrough,
): ConfigProps & { runtimeApi: NeonApi; out: PassThrough } => ({
  apiClient: fakeApiClient as never,
  apiKey: '',
  apiHost: 'https://console.neon.tech/api/v2',
  contextFile: '',
  output: 'json',
  projectId: PROJECT_ID,
  branch: BRANCH_NAME,
  runtimeApi: api,
  out,
});

describe('config commands', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'neonctl-config-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  const writeConfig = (body: string): string => {
    const path = join(cwd, 'neon.ts');
    writeFileSync(path, body);
    return path;
  };

  it('status returns the live project + branch state with a resolved neon.ts-shaped config', async () => {
    const api = new FakeNeonApi();
    const { stream, read } = captureOut();

    await status(baseProps(api, stream));

    const parsed = JSON.parse(read());
    expect(parsed.project.id).toBe(PROJECT_ID);
    expect(parsed.branch.id).toBe(BRANCH_ID);
    expect(parsed.branch.name).toBe(BRANCH_NAME);
    // The `config` column is the resolved neon.ts-shaped view, not the raw `{}`: the fake
    // branch has compute settings (so a `branch.postgres` section) and no auth/dataApi.
    expect(parsed.config.branch.postgres.computeSettings).toMatchObject({
      autoscalingLimitMaxCu: 0.25,
      suspendTimeout: '5m',
    });
    expect(parsed.config.auth).toBeUndefined();
    expect(parsed.config.dataApi).toBeUndefined();
    expect(parsed.config.preview).toBeUndefined();
  });

  it('status --config-json prints only the neon.ts-shaped config to stdout', async () => {
    const api = new FakeNeonApi();
    const { stream, read } = captureOut();

    // Capture process.stdout (the --config-json path writes there directly).
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      await status({ ...baseProps(api, stream), configJson: true });
    } finally {
      process.stdout.write = orig;
    }

    // The writer (table/json output) is NOT used; only stdout JSON.
    expect(read()).toBe('');
    const json = JSON.parse(chunks.join(''));
    // No project/branch envelope — just the config.
    expect(json.project).toBeUndefined();
    expect(json.branch.postgres.computeSettings.suspendTimeout).toBe('5m');
  });

  it('plan is a dry run whose applied list includes the auth service change', async () => {
    const api = new FakeNeonApi();
    const { stream, read } = captureOut();
    const config = writeConfig('export default { auth: {} };\n');

    await planCmd({ ...baseProps(api, stream), config });

    const result = JSON.parse(read());
    expect(result.dryRun).toBe(true);
    const authChange = result.applied.find(
      (change: { identifier: string }) => change.identifier === 'auth',
    );
    expect(authChange).toBeDefined();
    expect(authChange.kind).toBe('service');
    // A dry run never mutates remote state.
    expect(api.enableNeonAuthCalls).toHaveLength(0);
  });

  it('apply actually enables Neon Auth and is not a dry run', async () => {
    const api = new FakeNeonApi();
    const { stream, read } = captureOut();
    const config = writeConfig('export default { auth: {} };\n');

    await applyCmd({ ...baseProps(api, stream), config });

    const result = JSON.parse(read());
    expect(result.dryRun).toBe(false);
    expect(api.enableNeonAuthCalls).toHaveLength(1);
    expect(api.enableNeonAuthCalls[0]).toEqual({
      projectId: PROJECT_ID,
      branchId: BRANCH_ID,
    });
  });

  it("apply deploys a function via neonctl's own bundler", async () => {
    const api = new FakeNeonApi();
    const { stream } = captureOut();

    // A real handler module on disk: applyCmd's injected bundler (bundleEntry +
    // zipBundle) actually runs esbuild against this source and zips the output, so
    // it must be valid TypeScript that esbuild can bundle.
    const source = join(cwd, 'hello.ts');
    writeFileSync(
      source,
      "export default { fetch() { return new Response('ok'); } };\n",
    );
    const config = writeConfig(
      `export default { preview: { functions: { hello: { name: 'Hello', source: ${JSON.stringify(
        source,
      )} } } } };\n`,
    );

    await applyCmd({ ...baseProps(api, stream), config });

    // The function was new (listBranchFunctions returns []), so apply both creates
    // it and deploys code to it. We assert the deploy carried a real bundle.
    expect(api.deployBranchFunctionCalls).toHaveLength(1);
    const call = api.deployBranchFunctionCalls[0];
    expect(call.projectId).toBe(PROJECT_ID);
    expect(call.branchId).toBe(BRANCH_ID);
    expect(call.slug).toBe('hello');

    // The bundle must be the real ZIP produced by neonctl's bundleEntry + zipBundle
    // (NOT config-runtime's own esbuild default bundler). A non-empty Uint8Array
    // whose first two bytes are the ZIP local-file-header magic ("PK") proves a real
    // archive was built by neonctl's injected FunctionBundler.
    const { bundle } = call.input;
    expect(bundle).toBeInstanceOf(Uint8Array);
    expect(bundle.byteLength).toBeGreaterThan(0);
    expect(bundle[0]).toBe(0x50); // 'P'
    expect(bundle[1]).toBe(0x4b); // 'K'
  });

  it('--env loads a .env file into the environment before evaluating neon.ts', async () => {
    const api = new FakeNeonApi();
    const { stream } = captureOut();

    const source = join(cwd, 'hello.ts');
    writeFileSync(
      source,
      "export default { fetch() { return new Response('ok'); } };\n",
    );
    // The function's env value reads process.env.RESEND_API_KEY — which is only present if
    // the --env file is loaded before the policy is evaluated.
    const config = writeConfig(
      `export default { preview: { functions: { hello: { name: 'Hello', source: ${JSON.stringify(
        source,
      )}, env: { resendApiKey: process.env.RESEND_API_KEY ?? '' } } } } };\n`,
    );
    const envFile = join(cwd, '.env.deploy');
    writeFileSync(envFile, 'RESEND_API_KEY=re_from_file\n');

    try {
      await applyCmd({ ...baseProps(api, stream), config, env: envFile });
    } finally {
      delete process.env.RESEND_API_KEY;
    }

    expect(api.deployBranchFunctionCalls).toHaveLength(1);
    expect(api.deployBranchFunctionCalls[0].input.environment).toEqual({
      resendApiKey: 're_from_file',
    });
  });
});

describe('applyPolicyOnCreate', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'neonctl-create-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('applies the neon.ts policy to the new branch when one is present', async () => {
    const api = new FakeNeonApi();
    writeFileSync(join(cwd, 'neon.ts'), 'export default { auth: {} };\n');

    await applyPolicyOnCreate({
      projectId: PROJECT_ID,
      branchId: BRANCH_ID,
      runtimeApi: api,
      cwd,
    });

    expect(api.enableNeonAuthCalls).toHaveLength(1);
  });

  it('is a no-op when there is no neon.ts on the path', async () => {
    const api = new FakeNeonApi();

    await applyPolicyOnCreate({
      projectId: PROJECT_ID,
      branchId: BRANCH_ID,
      runtimeApi: api,
      cwd, // empty temp dir, no neon.ts
    });

    expect(api.enableNeonAuthCalls).toHaveLength(0);
  });
});
