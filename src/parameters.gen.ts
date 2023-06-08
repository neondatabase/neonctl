// FILE IS GENERATED, DO NOT EDIT

export const projectCreateRequest = {
  'project.settings.quota.active_time_seconds': {
    type: 'number',
    description:
      "The total amount of wall-clock time allowed to be spent by project's compute endpoints.\n",

    demandOption: false,
  },
  'project.settings.quota.compute_time_seconds': {
    type: 'number',
    description:
      "The total amount of CPU seconds allowed to be spent by project's compute endpoints.\n",

    demandOption: false,
  },
  'project.settings.quota.written_data_bytes': {
    type: 'number',
    description: "Total amount of data written to all project's branches.\n",

    demandOption: false,
  },
  'project.settings.quota.data_transfer_bytes': {
    type: 'number',
    description:
      "Total amount of data transferred from all project's branches using proxy.\n",

    demandOption: false,
  },
  'project.settings.quota.logical_size_bytes': {
    type: 'number',
    description: "Limit on the logical size of every project's branch.\n",

    demandOption: false,
  },
  'project.name': {
    type: 'string',
    description: 'The project name',

    demandOption: false,
  },
  'project.branch.name': {
    type: 'string',
    description:
      'The branch name. If not specified, the default branch name will be used.\n',

    demandOption: false,
  },
  'project.branch.role_name': {
    type: 'string',
    description:
      'The role name. If not specified, the default role name will be used.\n',

    demandOption: false,
  },
  'project.branch.database_name': {
    type: 'string',
    description:
      'The database name. If not specified, the default database name will be used.\n',

    demandOption: false,
  },
  'project.provisioner': {
    type: 'string',
    description: 'The Neon compute provisioner.\n',

    demandOption: false,
    choices: ['k8s-pod', 'k8s-neonvm', 'docker'],
  },
  'project.region_id': {
    type: 'string',
    description:
      'The region identifier. See [the documentation](https://neon.tech/docs/introduction/regions) for the list of supported regions.\n',

    demandOption: false,
  },
  'project.pg_version': {
    type: 'number',
    description:
      'The major PostgreSQL version number. Currently supported version are `14` and `15`.',

    demandOption: false,
  },
  'project.store_passwords': {
    type: 'boolean',
    description:
      'Whether or not passwords are stored for roles in the Neon project. Storing passwords facilitates access to Neon features that require authorization.\n',

    demandOption: false,
  },
  'project.history_retention_seconds': {
    type: 'number',
    description:
      'The number of seconds to retain PITR backup history for this project. Defaults to 7 days\n',

    demandOption: false,
  },
} as const;

export const branchCreateRequest = {
  'branch.parent_id': {
    type: 'string',
    description: 'The `branch_id` of the parent branch\n',

    demandOption: false,
  },
  'branch.name': {
    type: 'string',
    description: 'The branch name\n',

    demandOption: false,
  },
  'branch.parent_lsn': {
    type: 'string',
    description:
      'A Log Sequence Number (LSN) on the parent branch. The branch will be created with data from this LSN.\n',

    demandOption: false,
  },
  'branch.parent_timestamp': {
    type: 'string',
    description:
      'A timestamp identifying a point in time on the parent branch. The branch will be created with data starting from this point in time.\n',

    demandOption: false,
  },
} as const;

export const branchCreateRequestEndpointOptions = {
  type: {
    type: 'string',
    description:
      'The compute endpoint type. Either `read_write` or `read_only`.\nThe `read_only` compute endpoint type is not yet supported.\n',

    demandOption: true,
    choices: ['read_only', 'read_write'],
  },
  provisioner: {
    type: 'string',
    description: 'The Neon compute provisioner.\n',

    demandOption: false,
    choices: ['k8s-pod', 'k8s-neonvm', 'docker'],
  },
  suspend_timeout_seconds: {
    type: 'number',
    description:
      'Duration of inactivity in seconds after which endpoint will be\nautomatically suspended. Value `0` means use global default,\n`-1` means never suspend. Maximum value is 1 week in seconds.\n',

    demandOption: false,
  },
} as const;

export const branchUpdateRequest = {
  'branch.name': {
    type: 'string',
    description: undefined,

    demandOption: false,
  },
} as const;

export const endpointCreateRequest = {
  'endpoint.branch_id': {
    type: 'string',
    description:
      'The ID of the branch the compute endpoint will be associated with\n',

    demandOption: true,
  },
  'endpoint.region_id': {
    type: 'string',
    description:
      "The region where the compute endpoint will be created. Only the project's `region_id` is permitted.\n",

    demandOption: false,
  },
  'endpoint.type': {
    type: 'string',
    description:
      'The compute endpoint type. Either `read_write` or `read_only`.\nThe `read_only` compute endpoint type is not yet supported.\n',

    demandOption: true,
    choices: ['read_only', 'read_write'],
  },
  'endpoint.provisioner': {
    type: 'string',
    description: 'The Neon compute provisioner.\n',

    demandOption: false,
    choices: ['k8s-pod', 'k8s-neonvm', 'docker'],
  },
  'endpoint.pooler_enabled': {
    type: 'boolean',
    description:
      'Whether to enable connection pooling for the compute endpoint\n',

    demandOption: false,
  },
  'endpoint.pooler_mode': {
    type: 'string',
    description:
      'The connection pooler mode. Neon supports PgBouncer in `transaction` mode only.\n',

    demandOption: false,
    choices: ['transaction'],
  },
  'endpoint.disabled': {
    type: 'boolean',
    description: 'Whether to restrict connections to the compute endpoint\n',

    demandOption: false,
  },
  'endpoint.passwordless_access': {
    type: 'boolean',
    description:
      'NOT YET IMPLEMENTED. Whether to permit passwordless access to the compute endpoint.\n',

    demandOption: false,
  },
  'endpoint.suspend_timeout_seconds': {
    type: 'number',
    description:
      'Duration of inactivity in seconds after which endpoint will be\nautomatically suspended. Value `0` means use global default,\n`-1` means never suspend. Maximum value is 1 week in seconds.\n',

    demandOption: false,
  },
} as const;

export const endpointUpdateRequest = {
  'endpoint.branch_id': {
    type: 'string',
    description:
      'The destination branch ID. The destination branch must not have an exsiting read-write endpoint.\n',

    demandOption: false,
  },
  'endpoint.provisioner': {
    type: 'string',
    description: 'The Neon compute provisioner.\n',

    demandOption: false,
    choices: ['k8s-pod', 'k8s-neonvm', 'docker'],
  },
  'endpoint.pooler_enabled': {
    type: 'boolean',
    description:
      'Whether to enable connection pooling for the compute endpoint\n',

    demandOption: false,
  },
  'endpoint.pooler_mode': {
    type: 'string',
    description:
      'The connection pooler mode. Neon supports PgBouncer in `transaction` mode only.\n',

    demandOption: false,
    choices: ['transaction'],
  },
  'endpoint.disabled': {
    type: 'boolean',
    description: 'Whether to restrict connections to the compute endpoint\n',

    demandOption: false,
  },
  'endpoint.passwordless_access': {
    type: 'boolean',
    description:
      'NOT YET IMPLEMENTED. Whether to permit passwordless access to the compute endpoint.\n',

    demandOption: false,
  },
  'endpoint.suspend_timeout_seconds': {
    type: 'number',
    description:
      'Duration of inactivity in seconds after which endpoint will be\nautomatically suspended. Value `0` means use global default,\n`-1` means never suspend. Maximum value is 1 week in seconds.\n',

    demandOption: false,
  },
} as const;

export const databaseCreateRequest = {
  'database.name': {
    type: 'string',
    description: 'The name of the datbase\n',

    demandOption: true,
  },
  'database.owner_name': {
    type: 'string',
    description: 'The name of the role that owns the database\n',

    demandOption: true,
  },
} as const;
