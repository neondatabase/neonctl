// FILE IS GENERATED, DO NOT EDIT

export const ProjectCreateRequest = {
  'project.settings.quota.active_time_seconds': {
    type: 'number',
    description:
      "The total amount of wall-clock time allowed to be spent by project's compute endpoints.",
  },
  'project.settings.quota.compute_time_seconds': {
    type: 'number',
    description:
      "The total amount of CPU seconds allowed to be spent by project's compute endpoints.",
  },
  'project.settings.quota.written_data_bytes': {
    type: 'number',
    description: "Total amount of data written to all project's branches.",
  },
  'project.settings.quota.data_transfer_bytes': {
    type: 'number',
    description:
      "Total amount of data transferred from all project's branches using proxy.",
  },
  'project.settings.quota.logical_size_bytes': {
    type: 'number',
    description: "Limit on the logical size of every project's branch.",
  },
  'project.name': {
    type: 'string',
    description: 'The project name',
  },
  'project.branch.name': {
    type: 'string',
    description:
      'The branch name. If not specified, the default branch name will be used.',
  },
  'project.branch.role_name': {
    type: 'string',
    description:
      'The role name. If not specified, the default role name will be used.',
  },
  'project.branch.database_name': {
    type: 'string',
    description:
      'The database name. If not specified, the default database name will be used.',
  },
  'project.autoscaling_limit_min_cu': {
    type: 'number',
    description: 'The minimum number of CPU units',
  },
  'project.autoscaling_limit_max_cu': {
    type: 'number',
    description: 'The maximum number of CPU units',
  },
  'project.provisioner': {
    type: 'string',
    choices: ['k8s-pod', 'k8s-neonvm', 'docker'],
    description: 'The Neon compute provisioner.',
  },
  'project.region_id': {
    type: 'string',
    description:
      'The region identifier. See [the documentation](https://neon.tech/docs/introduction/regions) for the list of supported regions.',
  },
  'project.pg_version': {
    type: 'number',
    description:
      'The major PostgreSQL version number. Currently supported version are `14` and `15`.',
  },
  'project.store_passwords': {
    type: 'boolean',
    description:
      'Whether or not passwords are stored for roles in the Neon project. Storing passwords facilitates access to Neon features that require authorization.',
  },
} as const;
