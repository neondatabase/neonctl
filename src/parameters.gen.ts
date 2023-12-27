// FILE IS GENERATED, DO NOT EDIT

export const projectCreateRequest = {
  'project.settings.quota.active_time_seconds': {
              type: "number",
              description: "The total amount of wall-clock time allowed to be spent by the project's compute endpoints.\n",
              demandOption: false,
  },
  'project.settings.quota.compute_time_seconds': {
              type: "number",
              description: "The total amount of CPU seconds allowed to be spent by the project's compute endpoints.\n",
              demandOption: false,
  },
  'project.settings.quota.written_data_bytes': {
              type: "number",
              description: "Total amount of data written to all of a project's branches.\n",
              demandOption: false,
  },
  'project.settings.quota.data_transfer_bytes': {
              type: "number",
              description: "Total amount of data transferred from all of a project's branches using the proxy.\n",
              demandOption: false,
  },
  'project.settings.quota.logical_size_bytes': {
              type: "number",
              description: "Limit on the logical size of every project's branch.\n",
              demandOption: false,
  },
  'project.settings.allowed_ips.ips': {
              type: "array",
              description: "A list of IP addresses that are allowed to connect to the endpoint.",
              demandOption: true,
  },
  'project.settings.allowed_ips.primary_branch_only': {
              type: "boolean",
              description: "If true, the list will be applied only to the primary branch.",
              demandOption: true,
  },
  'project.name': {
              type: "string",
              description: "The project name",
              demandOption: false,
  },
  'project.branch.name': {
              type: "string",
              description: "The branch name. If not specified, the default branch name will be used.\n",
              demandOption: false,
  },
  'project.branch.role_name': {
              type: "string",
              description: "The role name. If not specified, the default role name will be used.\n",
              demandOption: false,
  },
  'project.branch.database_name': {
              type: "string",
              description: "The database name. If not specified, the default database name will be used.\n",
              demandOption: false,
  },
  'project.provisioner': {
              type: "string",
              description: "The Neon compute provisioner.\nSpecify the `k8s-neonvm` provisioner to create a compute endpoint that supports Autoscaling.\n",
              demandOption: false,
 choices: ["k8s-pod","k8s-neonvm"],
  },
  'project.region_id': {
              type: "string",
              description: "The region identifier. Refer to our [Regions](https://neon.tech/docs/introduction/regions) documentation for supported regions. Values are specified in this format: `aws-us-east-1`\n",
              demandOption: false,
  },
  'project.default_endpoint_settings.suspend_timeout_seconds': {
              type: "number",
              description: "Duration of inactivity in seconds after which the compute endpoint is\nautomatically suspended. The value `0` means use the global default.\nThe value `-1` means never suspend. The default value is `300` seconds (5 minutes).\nThe maximum value is `604800` seconds (1 week). For more information, see\n[Auto-suspend configuration](https://neon.tech/docs/manage/endpoints#auto-suspend-configuration).\n",
              demandOption: false,
  },
  'project.pg_version': {
              type: "number",
              description: "The major PostgreSQL version number. Currently supported versions are `14`, `15` and `16`.",
              demandOption: false,
  },
  'project.store_passwords': {
              type: "boolean",
              description: "Whether or not passwords are stored for roles in the Neon project. Storing passwords facilitates access to Neon features that require authorization.\n",
              demandOption: false,
  },
  'project.history_retention_seconds': {
              type: "number",
              description: "The number of seconds to retain the point-in-time restore (PITR) backup history for this project.\nThe default is 604800 seconds (7 days).\n",
              demandOption: false,
  },
} as const;

export const projectUpdateRequest = {
  'project.settings.quota.active_time_seconds': {
              type: "number",
              description: "The total amount of wall-clock time allowed to be spent by the project's compute endpoints.\n",
              demandOption: false,
  },
  'project.settings.quota.compute_time_seconds': {
              type: "number",
              description: "The total amount of CPU seconds allowed to be spent by the project's compute endpoints.\n",
              demandOption: false,
  },
  'project.settings.quota.written_data_bytes': {
              type: "number",
              description: "Total amount of data written to all of a project's branches.\n",
              demandOption: false,
  },
  'project.settings.quota.data_transfer_bytes': {
              type: "number",
              description: "Total amount of data transferred from all of a project's branches using the proxy.\n",
              demandOption: false,
  },
  'project.settings.quota.logical_size_bytes': {
              type: "number",
              description: "Limit on the logical size of every project's branch.\n",
              demandOption: false,
  },
  'project.settings.allowed_ips.ips': {
              type: "array",
              description: "A list of IP addresses that are allowed to connect to the endpoint.",
              demandOption: true,
  },
  'project.settings.allowed_ips.primary_branch_only': {
              type: "boolean",
              description: "If true, the list will be applied only to the primary branch.",
              demandOption: true,
  },
  'project.name': {
              type: "string",
              description: "The project name",
              demandOption: false,
  },
  'project.default_endpoint_settings.suspend_timeout_seconds': {
              type: "number",
              description: "Duration of inactivity in seconds after which the compute endpoint is\nautomatically suspended. The value `0` means use the global default.\nThe value `-1` means never suspend. The default value is `300` seconds (5 minutes).\nThe maximum value is `604800` seconds (1 week). For more information, see\n[Auto-suspend configuration](https://neon.tech/docs/manage/endpoints#auto-suspend-configuration).\n",
              demandOption: false,
  },
  'project.history_retention_seconds': {
              type: "number",
              description: "The number of seconds to retain the point-in-time restore (PITR) backup history for this project.\nThe default is 604800 seconds (7 days).\n",
              demandOption: false,
  },
} as const;

export const branchCreateRequest = {
  'endpoints': {
              type: "array",
              description: undefined,
              demandOption: false,
  },
  'branch.parent_id': {
              type: "string",
              description: "The `branch_id` of the parent branch. If omitted or empty, the branch will be created from the project's primary branch.\n",
              demandOption: false,
  },
  'branch.name': {
              type: "string",
              description: "The branch name\n",
              demandOption: false,
  },
  'branch.parent_lsn': {
              type: "string",
              description: "A Log Sequence Number (LSN) on the parent branch. The branch will be created with data from this LSN.\n",
              demandOption: false,
  },
  'branch.parent_timestamp': {
              type: "string",
              description: "A timestamp identifying a point in time on the parent branch. The branch will be created with data starting from this point in time.\n",
              demandOption: false,
  },
} as const;

export const branchCreateRequestEndpointOptions = {
  'type': {
              type: "string",
              description: "The compute endpoint type. Either `read_write` or `read_only`.\nThe `read_only` compute endpoint type is not yet supported.\n",
              demandOption: true,
 choices: ["read_only","read_write"],
  },
  'provisioner': {
              type: "string",
              description: "The Neon compute provisioner.\nSpecify the `k8s-neonvm` provisioner to create a compute endpoint that supports Autoscaling.\n",
              demandOption: false,
 choices: ["k8s-pod","k8s-neonvm"],
  },
  'suspend_timeout_seconds': {
              type: "number",
              description: "Duration of inactivity in seconds after which the compute endpoint is\nautomatically suspended. The value `0` means use the global default.\nThe value `-1` means never suspend. The default value is `300` seconds (5 minutes).\nThe maximum value is `604800` seconds (1 week). For more information, see\n[Auto-suspend configuration](https://neon.tech/docs/manage/endpoints#auto-suspend-configuration).\n",
              demandOption: false,
  },
} as const;

export const branchUpdateRequest = {
  'branch.name': {
              type: "string",
              description: undefined,
              demandOption: false,
  },
} as const;

export const endpointCreateRequest = {
  'endpoint.branch_id': {
              type: "string",
              description: "The ID of the branch the compute endpoint will be associated with\n",
              demandOption: true,
  },
  'endpoint.region_id': {
              type: "string",
              description: "The region where the compute endpoint will be created. Only the project's `region_id` is permitted.\n",
              demandOption: false,
  },
  'endpoint.type': {
              type: "string",
              description: "The compute endpoint type. Either `read_write` or `read_only`.\nThe `read_only` compute endpoint type is not yet supported.\n",
              demandOption: true,
 choices: ["read_only","read_write"],
  },
  'endpoint.provisioner': {
              type: "string",
              description: "The Neon compute provisioner.\nSpecify the `k8s-neonvm` provisioner to create a compute endpoint that supports Autoscaling.\n",
              demandOption: false,
 choices: ["k8s-pod","k8s-neonvm"],
  },
  'endpoint.pooler_enabled': {
              type: "boolean",
              description: "Whether to enable connection pooling for the compute endpoint\n",
              demandOption: false,
  },
  'endpoint.pooler_mode': {
              type: "string",
              description: "The connection pooler mode. Neon supports PgBouncer in `transaction` mode only.\n",
              demandOption: false,
 choices: ["transaction"],
  },
  'endpoint.disabled': {
              type: "boolean",
              description: "Whether to restrict connections to the compute endpoint.\nEnabling this option schedules a suspend compute operation.\nA disabled compute endpoint cannot be enabled by a connection or\nconsole action. However, the compute endpoint is periodically\nenabled by check_availability operations.\n",
              demandOption: false,
  },
  'endpoint.passwordless_access': {
              type: "boolean",
              description: "NOT YET IMPLEMENTED. Whether to permit passwordless access to the compute endpoint.\n",
              demandOption: false,
  },
  'endpoint.suspend_timeout_seconds': {
              type: "number",
              description: "Duration of inactivity in seconds after which the compute endpoint is\nautomatically suspended. The value `0` means use the global default.\nThe value `-1` means never suspend. The default value is `300` seconds (5 minutes).\nThe maximum value is `604800` seconds (1 week). For more information, see\n[Auto-suspend configuration](https://neon.tech/docs/manage/endpoints#auto-suspend-configuration).\n",
              demandOption: false,
  },
} as const;

export const endpointUpdateRequest = {
  'endpoint.branch_id': {
              type: "string",
              description: "The destination branch ID. The destination branch must not have an exsiting read-write endpoint.\n",
              demandOption: false,
  },
  'endpoint.provisioner': {
              type: "string",
              description: "The Neon compute provisioner.\nSpecify the `k8s-neonvm` provisioner to create a compute endpoint that supports Autoscaling.\n",
              demandOption: false,
 choices: ["k8s-pod","k8s-neonvm"],
  },
  'endpoint.pooler_enabled': {
              type: "boolean",
              description: "Whether to enable connection pooling for the compute endpoint\n",
              demandOption: false,
  },
  'endpoint.pooler_mode': {
              type: "string",
              description: "The connection pooler mode. Neon supports PgBouncer in `transaction` mode only.\n",
              demandOption: false,
 choices: ["transaction"],
  },
  'endpoint.disabled': {
              type: "boolean",
              description: "Whether to restrict connections to the compute endpoint.\nEnabling this option schedules a suspend compute operation.\nA disabled compute endpoint cannot be enabled by a connection or\nconsole action. However, the compute endpoint is periodically\nenabled by check_availability operations.\n",
              demandOption: false,
  },
  'endpoint.passwordless_access': {
              type: "boolean",
              description: "NOT YET IMPLEMENTED. Whether to permit passwordless access to the compute endpoint.\n",
              demandOption: false,
  },
  'endpoint.suspend_timeout_seconds': {
              type: "number",
              description: "Duration of inactivity in seconds after which the compute endpoint is\nautomatically suspended. The value `0` means use the global default.\nThe value `-1` means never suspend. The default value is `300` seconds (5 minutes).\nThe maximum value is `604800` seconds (1 week). For more information, see\n[Auto-suspend configuration](https://neon.tech/docs/manage/endpoints#auto-suspend-configuration).\n",
              demandOption: false,
  },
} as const;

export const databaseCreateRequest = {
  'database.name': {
              type: "string",
              description: "The name of the datbase\n",
              demandOption: true,
  },
  'database.owner_name': {
              type: "string",
              description: "The name of the role that owns the database\n",
              demandOption: true,
  },
} as const;

export const roleCreateRequest = {
  'role.name': {
              type: "string",
              description: "The role name. Cannot exceed 63 bytes in length.\n",
              demandOption: true,
  },
} as const;

