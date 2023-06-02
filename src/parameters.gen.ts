// FILE IS GENERATED, DO NOT EDIT

export const projectCreateRequest = {
  'project.settings.quota.active_time_seconds': {
    type: 'number',
    description:
      "The total amount of wall-clock time allowed to be spent by project's compute endpoints.\n",
  },
  'project.settings.quota.compute_time_seconds': {
    type: 'number',
    description:
      "The total amount of CPU seconds allowed to be spent by project's compute endpoints.\n",
  },
  'project.settings.quota.written_data_bytes': {
    type: 'number',
    description: "Total amount of data written to all project's branches.\n",
  },
  'project.settings.quota.data_transfer_bytes': {
    type: 'number',
    description:
      "Total amount of data transferred from all project's branches using proxy.\n",
  },
  'project.settings.quota.logical_size_bytes': {
    type: 'number',
    description: "Limit on the logical size of every project's branch.\n",
  },
  'project.name': {
    type: 'string',
    description: 'The project name',
  },
  'project.branch.name': {
    type: 'string',
    description:
      'The branch name. If not specified, the default branch name will be used.\n',
  },
  'project.branch.role_name': {
    type: 'string',
    description:
      'The role name. If not specified, the default role name will be used.\n',
  },
  'project.branch.database_name': {
    type: 'string',
    description:
      'The database name. If not specified, the default database name will be used.\n',
  },
  'project.provisioner': {
    type: 'string',
    description: 'The Neon compute provisioner.\n',
    choices: ['k8s-pod', 'k8s-neonvm', 'docker'],
  },
  'project.region_id': {
    type: 'string',
    description:
      'The region identifier. See [the documentation](https://neon.tech/docs/introduction/regions) for the list of supported regions.\n',
  },
  'project.pg_version': {
    type: 'number',
    description:
      'The major PostgreSQL version number. Currently supported version are `14` and `15`.',
  },
  'project.store_passwords': {
    type: 'boolean',
    description:
      'Whether or not passwords are stored for roles in the Neon project. Storing passwords facilitates access to Neon features that require authorization.\n',
  },
  'project.history_retention_seconds': {
    type: 'number',
    description:
      'The number of seconds to retain PITR backup history for this project. Defaults to 7 days\n',
  },
} as const;

export const branchCreateRequest = {
  'branch.parent_id': {
    type: 'string',
    description: 'The `branch_id` of the parent branch\n',
  },
  'branch.name': {
    type: 'string',
    description: 'The branch name\n',
  },
  'branch.parent_lsn': {
    type: 'string',
    description:
      'A Log Sequence Number (LSN) on the parent branch. The branch will be created with data from this LSN.\n',
  },
  'branch.parent_timestamp': {
    type: 'string',
    description:
      'A timestamp identifying a point in time on the parent branch. The branch will be created with data starting from this point in time.\n',
  },
} as const;

export const branchCreateRequestEndpointOptions = {
  type: {
    type: 'string',
    description:
      'The compute endpoint type. Either `read_write` or `read_only`.\nThe `read_only` compute endpoint type is not yet supported.\n',
    choices: ['read_only', 'read_write'],
  },
  provisioner: {
    type: 'string',
    description: 'The Neon compute provisioner.\n',
    choices: ['k8s-pod', 'k8s-neonvm', 'docker'],
  },
  suspend_timeout_seconds: {
    type: 'number',
    description:
      'Duration of inactivity in seconds after which endpoint will be\nautomatically suspended. Value `0` means use global default,\n`-1` means never suspend. Maximum value is 1 week in seconds.\n',
  },
} as const;

export const branchUpdateRequest = {
  'branch.name': {
    type: 'string',
    description: undefined,
  },
} as const;
