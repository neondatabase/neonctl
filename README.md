The Neon CLI is a command-line interface that lets you manage [Neon Serverless Postgres](https://neon.tech/) directly from the terminal. For the complete documentation, see [Neon CLI](https://neon.tech/docs/reference/neon-cli).

## Install the Neon CLI

**npm**

```shell
npm i -g neonctl
```

Requires Node.js 18.0 or higher.

**Howebrew**

```shell
brew install neonctl
```

**Binary (macOS, Linux, Windows)**

Download a binary file [here](https://github.com/neondatabase/neonctl/releases).

### Upgrade

**npm**

```shell
npm update -g neonctl
```

Requires Node.js 18.0 or higher.

**Howebrew**

```shell
brew upgrade neonctl
```

**Binary (macOS, Linux, Windows)**

To upgrade a binary version, download the latest binary file, as described above, and replace your old binary with the new one.

## Connect

Run the following command to authenticate a connection to Neon:

```bash
neonctl auth
```

The `auth` command launches a browser window where you can authorize the Neon CLI to access your Neon account. Running a Neon CLI command without authenticating with [neonctl auth](https://neon.tech/docs/reference/cli-auth) automatically launches the browser authentication process.

Alternatively, you can authenticate a connection with a Neon API key using the `--api-key` option when running a Neon CLI command. For example, an API key is used with the following `neonctl projects list` command:

```bash
neonctl projects list --api-key <neon_api_key>
```

For information about obtaining an Neon API key, see [Authentication](https://api-docs.neon.tech/reference/authentication), in the _Neon API Reference_.

## Configure autocompletion

The Neon CLI supports autocompletion, which you can configure in a few easy steps. See [Neon CLI commands — completion](https://neon.tech/docs/reference/cli-completion) for instructions.

## Linking a project

`neonctl link` is a Vercel-style command that binds the current directory to a Neon project. It picks (or creates) an organization, picks (or creates) a project, resolves the project's default branch, and writes a `.neon` file with `{ "orgId", "projectId", "branchId" }`. Subsequent commands run in this directory (or any sub-directory) automatically pick up that context.

There are three modes:

**Interactive (default)** — guided prompts for humans:

```bash
$ neonctl link
? Which organization would you like to link? › Personal Org (org-abc123)
? Which project would you like to link? › + Create new project
? Name for the new project: › my-app
? Which region should the new project run in? › AWS US East (Ohio) (aws-us-east-2)
Created project polished-snowflake-12345678 ("my-app") in aws-us-east-2.
Linked .neon:
  orgId:    org-abc123
  projectId: polished-snowflake-12345678
  branchId:  br-main-branch-87654321
```

**Non-interactive (flags or `--params` JSON)** — for scripts and CI:

```bash
# Link to an existing project
neonctl link --org-id org-abc123 --project-id polished-snowflake-12345678

# Create a new project and link
neonctl link --org-id org-abc123 --project-name my-app --region-id aws-us-east-2

# Same payload, one JSON blob
neonctl link --params '{"orgId":"org-abc123","projectName":"my-app","regionId":"aws-us-east-2"}'
```

**Agent mode (`--agent`)** — a JSON state machine designed for AI coding assistants. Each invocation returns a single JSON object with a `status` discriminator describing the next step, the available options, and the exact follow-up command to run.

```bash
$ neonctl link --agent
{
  "status": "needs_org",
  "instruction": "Ask the user which of these 2 organizations they want to link the current directory to. After they pick one, re-run the next_command_template with the chosen --org-id value.",
  "options": [
    { "id": "org-abc123", "name": "Personal Org" },
    { "id": "org-team",   "name": "Team Org" }
  ],
  "next_command_template": "neonctl link --agent --org-id <org_id>"
}

$ neonctl link --agent --org-id org-abc123
{
  "status": "needs_project",
  "instruction": "Ask the user whether to link to one of these 1 existing projects (use next_command_template with --project-id) or create a new project (use create_option.next_command_template).",
  "options": [
    { "id": "polished-snowflake-12345678", "name": "my-app" }
  ],
  "create_option": {
    "instruction": "To create a new project, ask the user for a project name. The region can be omitted to receive a follow-up needs_project_details response that lists available regions.",
    "next_command_template": "neonctl link --agent --org-id org-abc123 --project-name <name> --region-id <region_id>"
  },
  "next_command_template": "neonctl link --agent --org-id org-abc123 --project-id <project_id>"
}

$ neonctl link --agent --org-id org-abc123 --project-id polished-snowflake-12345678
{
  "status": "linked",
  "context_file": "/path/to/cwd/.neon",
  "context": {
    "orgId": "org-abc123",
    "projectId": "polished-snowflake-12345678",
    "branchId": "br-main-branch-87654321"
  },
  "project": { "id": "polished-snowflake-12345678" },
  "message": "Linked /path/to/cwd/.neon to project polished-snowflake-12345678 (org org-abc123) on branch br-main-branch-87654321."
}
```

The agent flow also handles project creation. If the agent sends `--project-name` without `--region-id`, the next response is `needs_project_details` with the list of supported regions.

**Organization-scoped API keys** (those created at the organization level rather than the user level) cannot list user organizations or call the regions endpoint. `link` handles this transparently:

- If the API key is org-scoped and at least one project already exists in the org, the CLI auto-detects the `org_id` from the first project. In interactive mode it prints an informational message; in `--agent` mode it skips straight to `needs_project`.
- If the API key is org-scoped and no projects exist yet, `--agent` returns a `needs_org` response with `options: []` and an instruction telling the user to find their org ID in the Neon Console. Interactive mode prints an error pointing to `--org-id`.
- When the regions endpoint is not allowed, `link` falls back to a built-in static region list.

**Agent error contract**: any unexpected failure in `--agent` mode is reported as JSON to stdout with exit code 1, so agents can always parse the response:

```json
{
  "status": "error",
  "code": "CLIENT_ERROR",
  "message": "user has no access to projects"
}
```

`link` is a thin wrapper around `set-context`: both write to the same `.neon` file via a shared `applyContext` helper, so anything `link` can write, `set-context` can write too (including the newly-supported `--branch-id` flag).

### checkout

`checkout <id|name>` pins a branch in the local context so subsequent commands target it — it's a focused helper over `set-context` for the common "switch the branch I'm working on" case. It resolves the branch (by name or id) against the project, then writes `branchId` into the `.neon` file. Unlike `set-context` (which performs a destructive write), `checkout` **merges**: it preserves the `projectId`/`orgId` already recorded in `.neon`, so `neonctl checkout my-branch` keeps the existing link intact.

The project is resolved through the standard neonctl chain, each entry winning over the next:

1. `--project-id <id>` flag
2. `projectId` from the closest `.neon` file (found by walking up from the current directory — see "Where `.neon` lives" below)
3. If still unresolved and the API key maps to exactly one project, that project is auto-detected (same behaviour as `branches` and `connection-string`)

If none of those resolve a project, `checkout` prints a telling error explaining the chain above. In an interactive terminal it then offers to run `neonctl link` in the current folder so you can pick (or create) a project on the spot; once linked, it continues and pins the requested branch. In non-interactive contexts (CI or no TTY) it exits with a non-zero code and the same guidance instead of prompting.

The resolved branch id is then written to the same `.neon` file that `link` and `set-context` use:

```bash
$ neonctl checkout main --project-id polished-snowflake-12345678
INFO: Checked out branch br-main-branch-87654321 on project polished-snowflake-12345678. Updated /path/to/cwd/.neon.

$ cat .neon
{
  "orgId": "org-abc123",
  "projectId": "polished-snowflake-12345678",
  "branchId": "br-main-branch-87654321"
}
```

**Where `.neon` lives**: `link` (and `set-context`) write `.neon` into the **current working directory** by default. If an existing `.neon` is found in any parent directory, that file is reused — so commands run from a sub-directory of a linked project still pick up the project's context. To pin the location explicitly, pass `--context-file <path>`.

**`.gitignore` scaffolding**: when `.neon` is **created** for the first time, the CLI also makes sure a `.gitignore` sits alongside it listing `.neon`. If `.gitignore` doesn't exist it's created with a single `.neon` line; if it does exist, `.neon` is appended only when missing (no duplicates, your other entries are left alone). On subsequent updates to an existing `.neon`, `.gitignore` is left untouched — so if you deliberately un-ignore `.neon` (e.g. to commit shared context), the entry is not re-added on every command.

## Commands

| Command                                                                    | Subcommands                                                                                 | Description                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------ |
| [auth](https://neon.com/docs/reference/cli-auth)                           |                                                                                             | Authenticate                   |
| [projects](https://neon.com/docs/reference/cli-projects)                   | `list`, `create`, `update`, `delete`, `get`                                                 | Manage projects                |
| [ip-allow](https://neon.com/docs/reference/cli-ip-allow)                   | `list`, `add`, `remove`, `reset`                                                            | Manage IP Allow                |
| [me](https://neon.com/docs/reference/cli-me)                               |                                                                                             | Show current user              |
| [branches](https://neon.com/docs/reference/cli-branches)                   | `list`, `create`, `rename`, `add-compute`, `set-default`, `set-expiration`, `delete`, `get` | Manage branches                |
| [databases](https://neon.com/docs/reference/cli-databases)                 | `list`, `create`, `delete`                                                                  | Manage databases               |
| [roles](https://neon.com/docs/reference/cli-roles)                         | `list`, `create`, `delete`                                                                  | Manage roles                   |
| [operations](https://neon.com/docs/reference/cli-operations)               | `list`                                                                                      | Manage operations              |
| [connection-string](https://neon.com/docs/reference/cli-connection-string) |                                                                                             | Get connection string          |
| psql                                                                       |                                                                                             | Connect to a database via psql |
| [set-context](https://neon.com/docs/reference/cli-set-context)             |                                                                                             | Set context for session        |
| checkout                                                                   |                                                                                             | Pin a branch in `.neon`        |
| [link](https://neon.com/docs/reference/cli-link)                           |                                                                                             | Link a directory to a project  |
| [completion](https://neon.com/docs/reference/cli-completion)               |                                                                                             | Generate a completion script   |

## Global options

Global options are supported with any Neon CLI command.

| Option                      | Description                                                 | Type    | Default                        |
| :-------------------------- | :---------------------------------------------------------- | :------ | :----------------------------- |
| [-o, --output](#output)     | Set the Neon CLI output format (`json`, `yaml`, or `table`) | string  | table                          |
| [--config-dir](#config-dir) | Path to the Neon CLI configuration directory                | string  | `/home/<user>/.config/neonctl` |
| [--api-key](#api-key)       | Neon API key                                                | string  | ""                             |
| [--analytics](#analytics)   | Manage analytics                                            | boolean | true                           |
| [-v, --version](#version)   | Show the Neon CLI version number                            | boolean | -                              |
| [-h, --help](#help)         | Show the Neon CLI help                                      | boolean | -                              |

- <a id="output"></a>`-o, --output`

  Sets the output format. Supported options are `json`, `yaml`, and `table`. The default is `table`. Table output may be limited. The `json` and `yaml` output formats show all data.

  ```bash
  neonctl me --output json
  ```

- <a id="config-dir"></a>`--config-dir`

  Specifies the path to the `neonctl` configuration directory. To view the default configuration directory containing you `credentials.json` file, run `neonctl --help`. The credentials file is created when you authenticate using the `neonctl auth` command. This option is only necessary if you move your `neonctl` configuration file to a location other than the default.

  ```bash
  neonctl projects list --config-dir /home/dtprice/.config/neonctl
  ```

- <a id="api-key"></a>`--api-key`

  Specifies your Neon API key. You can authenticate using a Neon API key when running a Neon CLI command instead of using `neonctl auth`. For information about obtaining an Neon API key, see [Authentication](https://api-docs.neon.tech/reference/authentication), in the _Neon API Reference_.

  ```bash
  neonctl <command> --api-key <neon_api_key>
  ```

- <a id="analytics"></a>`--analytics`

  Analytics are enabled by default to gather information about the CLI commands and options that are used by our customers. This data collection assists in offering support, and allows for a better understanding of typical usage patterns so that we can improve user experience. Neon does not collect user-defined data, such as project IDs or command payloads. To opt-out of analytics data collection, specify `--no-analytics` or `--analytics false`.

- <a id="version"></a>`-v, --version`

  Shows the Neon CLI version number.

  ```bash
  $ neonctl --version
  1.15.0
  ```

- <a id="help"></a>`-h, --help`

  Shows the `neonctl` command-line help. You can view help for `neonctl`, a `neonctl` command, or a `neonctl` subcommand, as shown in the following examples:

  ```bash
  neonctl --help

  neonctl branches --help

  neonctl branches create --help
  ```

## Contribute

This repo uses [pnpm](https://pnpm.io). The required version is pinned in `.tool-versions` and `package.json`'s `packageManager` field. The simplest way to get the right version is [mise](https://mise.jdx.dev): `mise install` reads `.tool-versions` and installs Node and pnpm. Alternatives: `npm install -g pnpm@9.15.9`, or [Corepack](https://nodejs.org/api/corepack.html) (`corepack enable pnpm`).

To run the CLI locally, execute the build command after making changes:

```shell
pnpm install
pnpm run build
```

To develop continuously:

```shell
pnpm run watch
```

To run commands from the local build, replace the `neonctl` command with `node dist`; for example:

```shell
node dist branches --help
```

## Releasing

Maintainers: see [`RELEASING.md`](./RELEASING.md) for the two-stage publish flow.
