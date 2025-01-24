import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createProjectFromSpec } from './sql_create.js';
import { psql } from './psql.js';
import { existsSync } from 'fs';
import { Api } from '@neondatabase/api-client';

// Mock dependencies
vi.mock('./psql.js');
vi.mock('fs');

const mockPsql = vi.mocked(psql);
const mockExistsSync = vi.mocked(existsSync);

describe('createProjectFromSpec', () => {
  const mockApiClient = {
    listApiKeys: vi.fn(),
    createApiKey: vi.fn(),
    revokeApiKey: vi.fn(),
    getProjectOperation: vi.fn(),
    createProject: vi.fn().mockResolvedValue({
      data: {
        project: {
          id: 'test-id',
          name: 'test-db',
          region_id: 'test-region',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          data_storage_bytes_hour: 0,
          data_transfer_bytes: 0,
          written_data_bytes: 0,
          compute_time_seconds: 0,
          active_time_seconds: 0,
          cpu_used_sec: 0,
          active: true,
          provisioner: 'k8s-pod',
          store_passwords: true,
          proxy_host: 'test-proxy',
          proxy_port: 5432,
          platform_id: 'test-platform',
          branch_logical_size_limit: 0,
          branch_logical_size_bytes: 0,
          branch_logical_size_limit_bytes: 0,
          consumption_period_start: '2024-01-01T00:00:00Z',
          consumption_period_end: '2024-01-01T00:00:00Z',
          owner_id: 'test-owner',
          creation_source: 'console',
          pg_version: 17,
          default_endpoint_settings: {
            autoscaling_limit_max_cu: 8,
            suspend_timeout_seconds: -1,
          },
          history_retention_seconds: 0,
        },
        connection_uris: [
          {
            connection_uri: 'postgres://test-uri',
            connection_parameters: {
              database: 'neondb',
              host: 'test-proxy',
              password: 'test-password',
              port: 5432,
              sslmode: 'require',
              user: 'test-user',
              role: 'test-role',
              pooler_host: 'test-pooler-host',
            },
          },
        ],
        roles: [],
        databases: [],
        operations: [],
        branch: {
          id: 'test-branch',
          project_id: 'test-id',
          name: 'main',
          current: true,
          created_at: '2024-01-01T00:00:00Z',
          current_state: 'ready',
          state_changed_at: '2024-01-01T00:00:00Z',
          creation_source: 'console',
          default: true,
          logical_size: 0,
          physical_size: 0,
          compute_time: 0,
          written_data: 0,
          active_time: 0,
          parent_id: null,
          parent_lsn: null,
          parent_timestamp: null,
          protected: false,
          cpu_used_sec: 0,
          compute_time_seconds: 0,
          active_time_seconds: 0,
          last_active_time: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          primary: true,
        },
        endpoints: [],
      },
    }),
    listProjects: vi.fn(),
    listSharedProjects: vi.fn(),
    getProject: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
  } as unknown as Api<unknown>;

  const mockProps = {
    apiClient: mockApiClient,
    apiKey: 'test-key',
    apiHost: 'test-host',
    output: 'json' as const,
    contextFile: 'test-context',
  };

  const validSpec = {
    name: 'test-db',
    type: 'POSTGRES_NEON',
    maxVCpu: 8,
    postgresVersion: 17,
    autoSuspend: true,
    historyRetentionSeconds: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (mockApiClient.createProject as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        data: {
          project: {
            id: 'test-id',
            name: 'test-db',
            region_id: 'test-region',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
            data_storage_bytes_hour: 0,
            data_transfer_bytes: 0,
            written_data_bytes: 0,
            compute_time_seconds: 0,
            active_time_seconds: 0,
            cpu_used_sec: 0,
            active: true,
            provisioner: 'k8s-pod',
            store_passwords: true,
            proxy_host: 'test-proxy',
            proxy_port: 5432,
            platform_id: 'test-platform',
            branch_logical_size_limit: 0,
            branch_logical_size_bytes: 0,
            branch_logical_size_limit_bytes: 0,
            consumption_period_start: '2024-01-01T00:00:00Z',
            consumption_period_end: '2024-01-01T00:00:00Z',
            owner_id: 'test-owner',
            creation_source: 'console',
            pg_version: 17,
            default_endpoint_settings: {
              autoscaling_limit_max_cu: 8,
              suspend_timeout_seconds: -1,
            },
            history_retention_seconds: 0,
          },
          connection_uris: [
            {
              connection_uri: 'postgres://test-uri',
              connection_parameters: {
                database: 'neondb',
                host: 'test-proxy',
                password: 'test-password',
                port: 5432,
                sslmode: 'require',
                user: 'test-user',
                role: 'test-role',
                pooler_host: 'test-pooler-host',
              },
            },
          ],
          roles: [],
          databases: [],
          operations: [],
          branch: {
            id: 'test-branch',
            project_id: 'test-id',
            name: 'main',
            current: true,
            created_at: '2024-01-01T00:00:00Z',
            current_state: 'ready',
            state_changed_at: '2024-01-01T00:00:00Z',
            creation_source: 'console',
            default: true,
            logical_size: 0,
            physical_size: 0,
            compute_time: 0,
            written_data: 0,
            active_time: 0,
            parent_id: undefined,
            parent_lsn: undefined,
            parent_timestamp: undefined,
            protected: false,
            cpu_used_sec: 0,
            compute_time_seconds: 0,
            active_time_seconds: 0,
            last_active_time: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
            primary: true,
            written_data_bytes: 0,
            data_transfer_bytes: 0,
          },
          endpoints: [],
        },
      },
    );
    mockExistsSync.mockReturnValue(true);
    mockPsql.mockResolvedValue();
  });

  it('creates project with correct parameters', async () => {
    await createProjectFromSpec(validSpec, mockProps);

    expect(mockApiClient.createProject).toHaveBeenCalledWith({
      project: {
        name: 'test-db',
        pg_version: 17,
        default_endpoint_settings: {
          autoscaling_limit_max_cu: 8,
          suspend_timeout_seconds: -1,
        },
        history_retention_seconds: 0,
      },
    });
  });

  it('handles autoSuspend=false correctly', async () => {
    await createProjectFromSpec(
      { ...validSpec, autoSuspend: false },
      mockProps,
    );

    expect(mockApiClient.createProject).toHaveBeenCalledWith({
      project: expect.objectContaining({
        default_endpoint_settings: expect.objectContaining({
          suspend_timeout_seconds: 0,
        }),
      }),
    });
  });

  it('executes setupSQL when specified', async () => {
    const specWithSetup = {
      ...validSpec,
      setupSQL: 'setup.sql',
    };

    await createProjectFromSpec(specWithSetup, mockProps);

    expect(mockExistsSync).toHaveBeenCalledWith('setup.sql');
    expect(mockPsql).toHaveBeenCalledWith('postgres://test-uri', [
      '-f',
      'setup.sql',
    ]);
  });

  it('throws error when setupSQL file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const specWithSetup = {
      ...validSpec,
      setupSQL: 'nonexistent.sql',
    };

    await expect(
      createProjectFromSpec(specWithSetup, mockProps),
    ).rejects.toThrow('Setup SQL file not found: nonexistent.sql');
  });

  it('handles psql not available error', async () => {
    mockPsql.mockRejectedValue(new Error('psql is not available'));
    const specWithSetup = {
      ...validSpec,
      setupSQL: 'setup.sql',
    };

    await expect(
      createProjectFromSpec(specWithSetup, mockProps),
    ).rejects.toThrow('psql is required to execute setup SQL files');
  });

  it('propagates API errors', async () => {
    (mockApiClient.createProject as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('API error'),
    );

    await expect(createProjectFromSpec(validSpec, mockProps)).rejects.toThrow(
      'Failed to create project: API error',
    );
  });
});
