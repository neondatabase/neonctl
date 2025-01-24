import { ProjectCreateRequest } from '@neondatabase/api-client';
import { existsSync } from 'fs';
// log import removed as it's unused
import { psql } from './psql.js';
import { CommonProps } from '../types.js';

type ManagedServiceSpec = {
  name: string;
  type: string;
  maxVCpu: number;
  postgresVersion: number;
  autoSuspend: boolean;
  historyRetentionSeconds: number;
  setupSQL?: string;
};

export async function createProjectFromSpec(
  spec: ManagedServiceSpec,
  props: CommonProps,
) {
  // 1) Prepare the project object
  const project: ProjectCreateRequest['project'] = {
    name: spec.name,
    pg_version: spec.postgresVersion,
    default_endpoint_settings: {
      autoscaling_limit_max_cu: spec.maxVCpu,
      // If autoSuspend is true, set to -1 (never suspend)
      // If false or not present, set to 0 (default)
      suspend_timeout_seconds: spec.autoSuspend ? -1 : 0,
    },
    history_retention_seconds: spec.historyRetentionSeconds,
  };

  try {
    // 2) Create the project using the API client
    const { data } = await props.apiClient.createProject({
      project,
    });

    // 3) If setupSQL is specified, validate and execute it
    if (spec.setupSQL) {
      if (!existsSync(spec.setupSQL)) {
        throw new Error(`Setup SQL file not found: ${spec.setupSQL}`);
      }

      const connectionUri = data.connection_uris[0].connection_uri;
      try {
        // Use psql utility to execute the SQL file
        await psql(connectionUri, ['-f', spec.setupSQL]);
      } catch (error) {
        // If psql fails, it could be because it's not installed
        if (
          error instanceof Error &&
          error.message.includes('psql is not available')
        ) {
          throw new Error(
            'psql is required to execute setup SQL files. Please install PostgreSQL client tools.',
          );
        }
        throw error;
      }
    }

    return data;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to create project: ${error.message}`);
    }
    throw error;
  }
}
