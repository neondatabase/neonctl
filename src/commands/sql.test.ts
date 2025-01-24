import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handler } from './sql.js';
import { parseManagedServiceSql } from '../utils/sql_parser.js';
import { createProjectFromSpec } from '../utils/sql_create.js';
import { Api } from '@neondatabase/api-client';
import { log } from '../log.js';

// Mock dependencies
vi.mock('../utils/sql_parser.js');
vi.mock('../utils/sql_create.js');

const mockParseManagedServiceSql = vi.mocked(parseManagedServiceSql);
const mockCreateProjectFromSpec = vi.mocked(createProjectFromSpec);

describe('sql command', () => {
  // Define mock result first
  const mockResult = {
    project: {
      id: 'test-id',
      name: 'testdb',
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
  };

  const mockProps = {
    apiClient: {
      listApiKeys: vi.fn(),
      createApiKey: vi.fn(),
      revokeApiKey: vi.fn(),
      getProjectOperation: vi.fn(),
      createProject: vi.fn().mockResolvedValue({ data: mockResult }),
      listProjects: vi.fn(),
      listSharedProjects: vi.fn(),
      getProject: vi.fn(),
      updateProject: vi.fn(),
      deleteProject: vi.fn(),
    } as unknown as Api<unknown>,
    apiKey: 'test-key',
    apiHost: 'test-host',
    output: 'json' as const,
    contextFile: 'test-context',
  };

  const testSql = `CREATE MANAGED SERVICE testdb TYPE=POSTGRES_NEON SPECIFICATION=$$ spec:
    maxVCpu: 8
    postgresVersion: 17
    autoSuspend: True
    setupSQL = test-setup.sql
  $$`;

  const mockSpec = {
    name: 'testdb',
    type: 'POSTGRES_NEON',
    maxVCpu: 8,
    postgresVersion: 17,
    autoSuspend: true,
    setupSQL: 'test-setup.sql',
    historyRetentionSeconds: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockParseManagedServiceSql.mockReturnValue(mockSpec);
    mockCreateProjectFromSpec.mockResolvedValue(mockResult);
  });

  it('creates project with parsed specification', async () => {
    const { sql, ...props } = { ...mockProps, sql: testSql };
    await handler({ ...props, sql });

    expect(mockParseManagedServiceSql).toHaveBeenCalledWith(testSql);
    expect(mockCreateProjectFromSpec).toHaveBeenCalledWith(mockSpec, props);
  });

  it('handles parser errors', async () => {
    const logError = vi.spyOn(log, 'error').mockImplementation(() => {
      /* empty mock */
    });
    const processExit = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    mockParseManagedServiceSql.mockImplementation(() => {
      throw new Error('Invalid SQL format');
    });

    await handler({ ...mockProps, sql: 'invalid sql' });

    expect(logError).toHaveBeenCalled();
    expect(processExit).toHaveBeenCalledWith(1);

    logError.mockRestore();
    processExit.mockRestore();
  });

  it('handles project creation errors', async () => {
    const logError = vi.spyOn(log, 'error').mockImplementation(() => {
      /* empty mock */
    });
    const processExit = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    mockCreateProjectFromSpec.mockRejectedValue(new Error('API error'));

    await handler({ ...mockProps, sql: testSql });

    expect(logError).toHaveBeenCalled();
    expect(processExit).toHaveBeenCalledWith(1);

    logError.mockRestore();
    processExit.mockRestore();
  });
});
