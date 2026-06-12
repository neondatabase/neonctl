import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import chalk from 'chalk';
import prompts, { InitialReturnValue } from 'prompts';
import which from 'which';
import yargs from 'yargs';

import { isCi } from '../env.js';
import { log } from '../log.js';
import { CommonProps } from '../types.js';
import {
  BootstrapTemplate,
  FALLBACK_TEMPLATES,
  fetchFileBytes,
  fetchSymlinkTarget,
  fetchTemplates,
  findTemplate,
  resolveTemplate,
  templateIds,
} from '../utils/bootstrap.js';

type BootstrapProps = CommonProps & {
  directory?: string;
  template?: string;
  force: boolean;
  listTemplates: boolean;
  agent: boolean;
  default: boolean;
  install: boolean;
  git: boolean;
  link: boolean;
};

// ----------------------------------------------------------------------------
// Agent mode (JSON state machine)
// ----------------------------------------------------------------------------

type AgentTemplateOption = {
  id: string;
  title: string;
  description: string;
  services?: string[];
};

/**
 * One follow-up the caller should offer the user after scaffolding. The agent
 * is expected to ask the user, then run `command` from the project directory
 * (the `link` step intentionally chains into `neon link --agent`'s own state
 * machine). Mirrors `link --agent`'s instruction/next_command_template style.
 */
type AgentNextStep = {
  action: 'install_dependencies' | 'initialize_git' | 'link_neon_project';
  instruction: string;
  command: string;
};

type AgentResponse =
  | {
      status: 'needs_template';
      instruction: string;
      options: AgentTemplateOption[];
      next_command_template: string;
    }
  | {
      status: 'needs_directory';
      instruction: string;
      next_command_template: string;
    }
  | {
      status: 'scaffolded';
      directory: string;
      template: { id: string; title: string };
      files_written: number;
      next_steps: AgentNextStep[];
      message: string;
    }
  | { status: 'error'; code: string; message: string };

// The directory positional is optional: omitting it in an interactive terminal
// prompts for one. In a non-interactive context a missing directory is an error.
export const command = 'bootstrap [directory]';
export const describe = 'Scaffold a new project from a Neon starter template';

export const builder = (argv: yargs.Argv) =>
  argv
    .usage('$0 bootstrap [directory] [options]')
    .positional('directory', {
      describe:
        'Directory to scaffold into. Use "." for the current directory. Omit to be prompted.',
      type: 'string',
    })
    .options({
      template: {
        describe:
          'Template to use (skips the interactive picker). Run with --list-templates to see available templates.',
        type: 'string',
      },
      'list-templates': {
        alias: ['list', 'ls'],
        describe: 'List available templates and exit.',
        type: 'boolean',
        default: false,
      },
      force: {
        describe:
          'Scaffold into the target directory even if it is not empty (colliding files are overwritten).',
        type: 'boolean',
        default: false,
      },
      agent: {
        describe:
          'Emit a JSON state-machine response designed for AI agents instead of prompting. The output is a single JSON object with a discriminated `status` field describing the next step.',
        type: 'boolean',
        default: false,
      },
      default: {
        alias: 'y',
        describe:
          'Quick start: scaffold the default template (or --template) and run the usual setup (install dependencies, git init) without prompting. Linking is left to you since it needs a project choice.',
        type: 'boolean',
        default: false,
      },
      install: {
        describe:
          'Install dependencies after scaffolding. In interactive mode this is offered as a prompt; use --no-install to skip without being asked.',
        type: 'boolean',
        default: true,
      },
      git: {
        describe:
          'Initialize a git repository after scaffolding. In interactive mode this is offered as a prompt; use --no-git to skip without being asked.',
        type: 'boolean',
        default: true,
      },
      link: {
        describe:
          'Run `neon link` in the scaffolded directory after installing. In interactive mode this is offered as a prompt; use --no-link to skip without being asked.',
        type: 'boolean',
        default: true,
      },
    })
    .example(
      '$0 bootstrap my-app',
      'Create ./my-app from an interactively chosen template',
    )
    .example(
      '$0 bootstrap . --template hono',
      'Scaffold the Hono template into the current directory',
    )
    .example(
      '$0 bootstrap my-app --default',
      'Quick start: scaffold the default template and run setup without prompting',
    )
    .example(
      '$0 bootstrap my-app --template hono --agent',
      'Scaffold without prompting and emit the JSON state machine for AI agents',
    )
    .strict();

export const handler = async (props: BootstrapProps): Promise<void> => {
  if (props.listTemplates) {
    const templates = await fetchTemplates();
    for (const t of templates) {
      const services =
        t.services && t.services.length > 0
          ? ` [${t.services.join(' · ')}]`
          : '';
      process.stdout.write(`${t.id} — ${t.description}${services}\n`);
    }
    return;
  }

  if (props.agent) {
    await runAgentSafely(props);
    return;
  }

  const templates = await resolveTemplateList(props);
  // --default is a non-interactive quick start: it fills in the template and
  // directory and runs setup without asking, so it must not fall into the
  // prompt path even on a TTY.
  const interactive =
    !props.default && Boolean(process.stdout.isTTY) && !isCi();
  const template = await resolveSelectedTemplate(props, interactive, templates);
  const targetDir = await resolveTargetDir(props, interactive, template);
  ensureTargetUsable(targetDir, props.force);
  await scaffold(template, targetDir);
  printScaffolded(template, targetDir);
  await runPostScaffoldSteps(props, targetDir, interactive);
};

/**
 * The template list to choose from. When --template is given we try the
 * built-in fallback list first to avoid a network round-trip, only fetching the
 * remote manifest if the id isn't one of the defaults.
 */
const resolveTemplateList = async (
  props: BootstrapProps,
): Promise<BootstrapTemplate[]> =>
  props.template && findTemplate(FALLBACK_TEMPLATES, props.template)
    ? FALLBACK_TEMPLATES
    : fetchTemplates();

/**
 * The picker label for a template: the title prefixed with the Neon services it
 * uses as a dim badge, e.g. "[Postgres · Functions] Hono API …". The badge is
 * styled with chalk.dim only (never a foreground color) so it survives the
 * cyan/underline `prompts` paints over the focused row — dim resets with the
 * intensity SGR, leaving the row's color and underline intact. The one-line
 * description renders under the title on focus (handled by `prompts`).
 */
const formatTemplateTitle = (template: BootstrapTemplate): string => {
  if (!template.services || template.services.length === 0) {
    return template.title;
  }
  return `${chalk.dim(`[${template.services.join(' · ')}]`)} ${template.title}`;
};

const resolveSelectedTemplate = async (
  props: BootstrapProps,
  interactive: boolean,
  templates: BootstrapTemplate[],
): Promise<BootstrapTemplate> => {
  if (props.template) {
    const template = findTemplate(templates, props.template);
    if (!template) {
      throw new Error(
        `Unknown template "${props.template}". Available templates: ${templateIds(templates)}.`,
      );
    }
    return template;
  }

  // --default with no --template falls back to the first (default) template so
  // a bare `neon bootstrap my-app --default` works end to end.
  if (props.default) {
    const fallback = templates[0];
    if (!fallback) {
      throw new Error('No templates available to scaffold from.');
    }
    return fallback;
  }

  if (!interactive) {
    throw new Error(
      `No template selected. Re-run in an interactive terminal to pick one, or pass --template <id>. Available templates: ${templateIds(templates)}.`,
    );
  }

  const { id } = await prompts({
    onState: onPromptState,
    type: 'select',
    name: 'id',
    message: 'Which template would you like to use?',
    choices: templates.map((template) => ({
      title: formatTemplateTitle(template),
      description: template.description,
      value: template.id,
    })),
    initial: 0,
  });
  const template = findTemplate(templates, id);
  if (!template) {
    throw new Error('No template selected.');
  }
  return template;
};

const resolveTargetDir = async (
  props: BootstrapProps,
  interactive: boolean,
  template: BootstrapTemplate,
): Promise<string> => {
  let dir = props.directory;
  if (dir === undefined) {
    // --default supplies a directory (the template's name) so the quick start
    // needs nothing but a template.
    if (props.default) {
      return resolve(process.cwd(), defaultDirName(template));
    }
    if (!interactive) {
      throw new Error(
        'No target directory given. Pass one, e.g. `neon bootstrap my-app` (or "." for the current directory).',
      );
    }
    const { value } = await prompts({
      onState: onPromptState,
      type: 'text',
      name: 'value',
      message: 'Where should we scaffold your project?',
      initial: defaultDirName(template),
      validate: (input: string) =>
        input && input.trim().length > 0
          ? true
          : 'Enter a directory (use "." for the current directory).',
    });
    dir = String(value).trim();
  }
  return resolve(process.cwd(), dir === '.' ? '' : dir);
};

const defaultDirName = (template: BootstrapTemplate): string =>
  template.source.subdir.split('/').pop() || template.id;

/**
 * A bad user-supplied input that an agent (or human) can correct: an unknown
 * template id or a non-empty target directory. Carries an `agentCode` so
 * `--agent` mode reports a precise `status: error` code instead of a generic
 * INTERNAL_ERROR, while the human path just surfaces the clear `message`.
 */
class BootstrapInputError extends Error {
  readonly agentCode: string;
  constructor(message: string, agentCode: string) {
    super(message);
    this.name = 'BootstrapInputError';
    this.agentCode = agentCode;
  }
}

const ensureTargetUsable = (dir: string, force: boolean): void => {
  if (!existsSync(dir)) {
    return;
  }
  if (!statSync(dir).isDirectory()) {
    throw new BootstrapInputError(
      `Target ${dir} already exists and is not a directory.`,
      'TARGET_NOT_DIRECTORY',
    );
  }
  // A lone `.git` is ignored so you can scaffold into a freshly `git init`ed
  // (otherwise empty) directory without reaching for --force.
  const contents = readdirSync(dir).filter((name) => name !== '.git');
  if (contents.length > 0 && !force) {
    throw new BootstrapInputError(
      `Target directory ${dir} is not empty. Use --force to scaffold into it anyway (colliding files will be overwritten), or choose an empty directory.`,
      'TARGET_NOT_EMPTY',
    );
  }
};

const scaffold = async (
  template: BootstrapTemplate,
  targetDir: string,
): Promise<number> => {
  log.info('Fetching template "%s" from GitHub…', template.id);
  const { commitSha, entries } = await resolveTemplate(template);

  mkdirSync(targetDir, { recursive: true });
  log.info('Scaffolding %d files into %s…', entries.length, targetDir);

  await mapWithConcurrency(entries, 8, async (entry) => {
    const dest = join(targetDir, entry.path);
    mkdirSync(dirname(dest), { recursive: true });
    if (entry.kind === 'symlink') {
      const target = await fetchSymlinkTarget(
        template,
        commitSha,
        entry.repoPath,
      );
      writeSymlink(dest, target);
    } else {
      const bytes = await fetchFileBytes(template, commitSha, entry.repoPath);
      writeFileSync(dest, bytes);
      if (entry.executable) {
        chmodSync(dest, 0o755);
      }
    }
  });
  return entries.length;
};

const writeSymlink = (dest: string, target: string): void => {
  if (isSymlink(dest)) {
    rmSync(dest, { force: true });
  }
  try {
    symlinkSync(target, dest);
  } catch (err) {
    // Windows refuses symlinks without elevated rights / developer mode. The
    // template still works for most tooling if we drop a regular file holding
    // the link target, so we degrade gracefully instead of failing the copy.
    if (errnoCode(err) === 'EPERM' || process.platform === 'win32') {
      log.warning(
        'Could not create symlink %s -> %s; wrote it as a regular file instead.',
        dest,
        target,
      );
      writeFileSync(dest, target);
      return;
    }
    throw err;
  }
};

// ----------------------------------------------------------------------------
// Post-scaffold steps (install dependencies, git init, link to a Neon project)
// ----------------------------------------------------------------------------

/**
 * After a human scaffold, offer the things you almost always do next: install
 * dependencies, initialize a git repo, and link the directory to a Neon
 * project. In an interactive terminal each is a y/n prompt (skippable up front
 * with --no-install / --no-git / --no-link); `--default` runs install + git
 * without asking; otherwise we just print the manual steps so nothing runs
 * behind the user's back. Agent mode never reaches here — it returns these as
 * structured `next_steps` instead (see {@link runAgent}).
 */
const runPostScaffoldSteps = async (
  props: BootstrapProps,
  targetDir: string,
  interactive: boolean,
): Promise<void> => {
  const detected = detectPackageManager();

  if (props.default) {
    await runDefaultSteps(props, targetDir, detected ?? 'npm');
    return;
  }

  if (!interactive) {
    printNextSteps(targetDir, detected ?? 'npm', {
      installed: false,
      suggestLink: true,
    });
    return;
  }

  // The package manager used for the install (and shown in the closing hint).
  // When we couldn't infer it from the invocation we ask, so a globally
  // installed `neon` doesn't silently force npm on a bun/pnpm user.
  let pm: PackageManager = detected ?? 'npm';
  let installed = false;
  if (props.install && (await confirm(installPrompt(detected)))) {
    pm = detected ?? (await selectPackageManager());
    installed = await runCommand(pm, ['install'], targetDir);
  }

  if (
    props.git &&
    !isGitRepo(targetDir) &&
    (await confirm('Initialize a git repository?'))
  ) {
    await initGitRepo(targetDir);
  }

  // `neon link` pulls env vars, which loads this project's neon.ts — and that
  // evaluation needs the dependencies installed. So when deps weren't installed
  // and the scaffold ships a neon.ts, skip the link prompt (it would just fail)
  // and tell the user how to finish by hand.
  if (props.link) {
    if (!installed && hasNeonConfig(targetDir)) {
      log.info(
        "Skipping the Neon link step: `neon link` reads this project's neon.ts " +
          `to pull env vars, which needs its dependencies. Run \`${pm} install\`, ` +
          'then `neon link`.',
      );
    } else if (
      await confirm('Link this project to a Neon project now? (runs neon link)')
    ) {
      await runNeonLink(props, targetDir);
      // link prints its own summary (and pulls env), so end with just the run hint.
      printNextSteps(targetDir, pm, { installed, suggestLink: false });
      return;
    }
  }

  printNextSteps(targetDir, pm, { installed, suggestLink: true });
};

const installPrompt = (detected: PackageManager | undefined): string =>
  detected ? `Install dependencies with ${detected}?` : 'Install dependencies?';

/**
 * `--default` quick start: run install + git init without prompting, honoring
 * --no-install / --no-git. Linking is intentionally skipped — it needs an
 * org/project choice we can't make non-interactively — so we point at it in the
 * closing hint instead.
 */
const runDefaultSteps = async (
  props: BootstrapProps,
  targetDir: string,
  pm: PackageManager,
): Promise<void> => {
  log.info('Quick start (--default): running setup without prompting.');
  let installed = false;
  if (props.install) {
    installed = await runCommand(pm, ['install'], targetDir);
  }
  if (props.git && !isGitRepo(targetDir)) {
    await initGitRepo(targetDir);
  }
  printNextSteps(targetDir, pm, { installed, suggestLink: true });
};

const isGitRepo = (dir: string): boolean => existsSync(join(dir, '.git'));

// Config filenames the runtime loads (mirrors @neondatabase/config). A scaffold
// that ships one makes `neon link`'s env pull evaluate it — which needs deps.
const NEON_CONFIG_FILENAMES = ['neon.ts', 'neon.mts', 'neon.js', 'neon.mjs'];

const hasNeonConfig = (dir: string): boolean =>
  NEON_CONFIG_FILENAMES.some((name) => existsSync(join(dir, name)));

/**
 * Initialize a git repository in the scaffolded directory. Just `git init` — we
 * deliberately don't auto-commit, both to avoid failing on a machine with no
 * git identity configured and to leave the first commit to the user.
 */
const initGitRepo = async (dir: string): Promise<void> => {
  await runCommand('git', ['init'], dir);
};

const confirm = async (message: string): Promise<boolean> => {
  const { value } = await prompts({
    onState: onPromptState,
    type: 'confirm',
    name: 'value',
    message,
    initial: true,
  });
  return value === true;
};

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

// npm first so it's the default/preselected choice; the rest follow in rough
// popularity order.
const PACKAGE_MANAGERS: PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun'];

/**
 * The package manager the CLI was invoked through, read from the
 * `npm_config_user_agent` npm sets for `npm exec`/`npx`, `pnpm dlx`, `yarn
 * dlx`, and `bunx` (so `pnpm dlx neonctl bootstrap` installs with pnpm).
 * Returns undefined when there's nothing to infer from — e.g. a
 * globally-installed `neon`/`neonctl` — so the caller can ask instead of
 * silently assuming npm.
 */
const detectPackageManager = (): PackageManager | undefined => {
  const ua = process.env.npm_config_user_agent ?? '';
  if (ua.startsWith('pnpm')) return 'pnpm';
  if (ua.startsWith('yarn')) return 'yarn';
  if (ua.startsWith('bun')) return 'bun';
  if (ua.startsWith('npm')) return 'npm';
  return undefined;
};

/** The package managers actually on PATH, in {@link PACKAGE_MANAGERS} order. */
const installedPackageManagers = (): PackageManager[] =>
  PACKAGE_MANAGERS.filter((pm) => which.sync(pm, { nothrow: true }) !== null);

/**
 * Ask which package manager to install with when we couldn't infer one from the
 * invocation. Offers the managers actually installed (npm preselected); with
 * one or none installed there's nothing to choose, so it returns that one (or
 * npm) without prompting. A cancelled prompt falls back to npm.
 */
const selectPackageManager = async (): Promise<PackageManager> => {
  const installed = installedPackageManagers();
  if (installed.length <= 1) {
    return installed[0] ?? 'npm';
  }
  const { pm } = await prompts({
    onState: onPromptState,
    type: 'select',
    name: 'pm',
    message: 'Which package manager should we use?',
    choices: installed.map((manager) => ({
      title: manager,
      value: manager,
    })),
    initial: Math.max(0, installed.indexOf('npm')),
  });
  return pm ?? 'npm';
};

/**
 * Run a command inheriting our stdio so the user sees install / link output
 * live and can answer any prompts the child raises. Resolves to whether it
 * exited cleanly; a non-zero exit is reported but never aborts bootstrap — the
 * scaffold already succeeded, so we let the user retry the step by hand.
 */
const runCommand = (
  cmd: string,
  args: string[],
  cwd: string,
): Promise<boolean> =>
  new Promise((resolvePromise) => {
    // npm/pnpm/yarn ship as .cmd shims on Windows, which need a shell to run.
    const child = spawn(cmd, args, {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', (err) => {
      log.warning(
        'Could not run `%s %s`: %s',
        cmd,
        args.join(' '),
        err instanceof Error ? err.message : String(err),
      );
      resolvePromise(false);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        log.warning('`%s %s` exited with code %d.', cmd, args.join(' '), code);
      }
      resolvePromise(code === 0);
    });
  });

/**
 * Re-invoke this same CLI as `neon link` inside the scaffolded directory, so the
 * new project's `.neon` context (and pulled `.env`) land in the right place and
 * link's own interactive picker drives org/project/branch selection. Re-execing
 * (rather than calling the handler in-process) keeps link running with `cwd` set
 * to the target dir, which is where its env pull writes.
 */
const runNeonLink = async (
  props: BootstrapProps,
  targetDir: string,
): Promise<void> => {
  const args = [process.argv[1], 'link'];
  if (props.apiKey) {
    args.push('--api-key', props.apiKey);
  }
  args.push('--api-host', props.apiHost, '--output', props.output);
  await runCommand(process.execPath, args, targetDir);
};

const printScaffolded = (
  template: BootstrapTemplate,
  targetDir: string,
): void => {
  log.info('');
  log.info(
    'Done. Scaffolded "%s" into %s.',
    template.title,
    isCurrentDir(targetDir) ? 'the current directory' : displayDir(targetDir),
  );
};

/**
 * The closing "Next steps" hint. Skips `cd` for the current directory, omits
 * the install line once deps are in, and only nudges `neon link` when linking
 * wasn't already offered/run — so the user never sees a step they just did.
 */
const printNextSteps = (
  targetDir: string,
  pm: PackageManager,
  opts: { installed: boolean; suggestLink: boolean },
): void => {
  log.info('');
  log.info('Next steps:');
  if (!isCurrentDir(targetDir)) {
    log.info('  cd %s', displayDir(targetDir));
  }
  if (!opts.installed) {
    log.info('  %s install', pm);
  }
  if (opts.suggestLink) {
    log.info('  neon link');
  }
  log.info('  See the README to run it.');
  log.info('');
};

const runAgentSafely = async (props: BootstrapProps): Promise<void> => {
  try {
    await runAgent(props);
  } catch (err) {
    emitAgent(toAgentError(err));
    process.exit(1);
  }
};

/**
 * The `--agent` flow: resolve what the flags determine and emit one JSON object
 * describing either the next input needed (`needs_template` / `needs_directory`)
 * or the terminal result (`scaffolded`). Unlike interactive mode it never
 * prompts and never runs install/git/link itself — those come back as structured
 * `next_steps` so the agent can confirm with the user and run them (the link
 * step chains into `neon link --agent`).
 */
const runAgent = async (props: BootstrapProps): Promise<void> => {
  if (!props.template) {
    const templates = await fetchTemplates();
    emitAgent({
      status: 'needs_template',
      instruction: `Ask the user which template to scaffold, then re-run the next_command_template with the chosen --template value${
        props.directory ? '' : ' and a target directory'
      }.`,
      options: templates.map((template) => ({
        id: template.id,
        title: template.title,
        description: template.description,
        ...(template.services ? { services: template.services } : {}),
      })),
      next_command_template: `neon bootstrap --agent ${
        props.directory ? shellArg(props.directory) : '<directory>'
      } --template <template_id>`,
    });
    return;
  }

  const templates = await resolveTemplateList(props);
  const template = findTemplate(templates, props.template);
  if (!template) {
    throw new BootstrapInputError(
      `Unknown template "${props.template}". Available templates: ${templateIds(templates)}.`,
      'UNKNOWN_TEMPLATE',
    );
  }

  if (props.directory === undefined) {
    emitAgent({
      status: 'needs_directory',
      instruction:
        'Ask the user which directory to scaffold into (use "." for the current directory), then re-run the next_command_template with it.',
      next_command_template: `neon bootstrap --agent <directory> --template ${shellArg(
        template.id,
      )}`,
    });
    return;
  }

  const targetDir = resolve(
    process.cwd(),
    props.directory === '.' ? '' : props.directory,
  );
  ensureTargetUsable(targetDir, props.force);
  const filesWritten = await scaffold(template, targetDir);

  const dir = displayDir(targetDir);
  const runIn = isCurrentDir(targetDir) ? '' : `cd ${shellArg(dir)} && `;
  emitAgent({
    status: 'scaffolded',
    directory: targetDir,
    template: { id: template.id, title: template.title },
    files_written: filesWritten,
    next_steps: [
      {
        action: 'install_dependencies',
        instruction:
          'Ask the user whether to install dependencies, then run this in the project directory.',
        command: `${runIn}npm install`,
      },
      {
        action: 'initialize_git',
        instruction:
          'Ask the user whether to initialize a git repository in the project directory.',
        command: `${runIn}git init`,
      },
      {
        action: 'link_neon_project',
        instruction:
          'Ask the user whether to link the project to a Neon project now. This runs the link state machine — follow its JSON output for the next step.',
        command: `${runIn}neon link --agent`,
      },
    ],
    message: `Scaffolded "${template.title}" (${filesWritten} files) into ${dir}. Offer the next_steps to the user: install dependencies, initialize git, then link a Neon project.`,
  });
};

const emitAgent = (response: AgentResponse): void => {
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
};

const toAgentError = (
  err: unknown,
): Extract<AgentResponse, { status: 'error' }> => {
  if (err instanceof BootstrapInputError) {
    return { status: 'error', code: err.agentCode, message: err.message };
  }
  if (err instanceof Error) {
    return { status: 'error', code: 'INTERNAL_ERROR', message: err.message };
  }
  return { status: 'error', code: 'INTERNAL_ERROR', message: String(err) };
};

// ----------------------------------------------------------------------------
// Path display helpers
// ----------------------------------------------------------------------------

const isCurrentDir = (targetDir: string): boolean =>
  relative(process.cwd(), targetDir) === '';

/**
 * The path to show the user: the bare relative path for the common
 * `bootstrap my-app` case, the absolute path when the target sits outside the
 * cwd (a deep `../../..` is noise), and "." for the current directory.
 */
const displayDir = (targetDir: string): string => {
  const rel = relative(process.cwd(), targetDir);
  if (rel === '') {
    return '.';
  }
  return rel.startsWith('..') ? targetDir : rel;
};

const mapWithConcurrency = async <T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> => {
  const queue = [...items];
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      await fn(next);
    }
  };
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    () => worker(),
  );
  await Promise.all(workers);
};

const isSymlink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

const errnoCode = (err: unknown): string | undefined => {
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof err.code === 'string'
  ) {
    return err.code;
  }
  return undefined;
};

const shellArg = (value: string): string => {
  if (/^[A-Za-z0-9._:/-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
};

const onPromptState = (state: {
  value: InitialReturnValue;
  aborted: boolean;
  exited: boolean;
}) => {
  if (state.aborted) {
    process.stdout.write('\x1B[?25h');
    process.stdout.write('\n');
    process.exit(1);
  }
};
