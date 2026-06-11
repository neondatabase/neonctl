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

import prompts, { InitialReturnValue } from 'prompts';
import yargs from 'yargs';

import { isCi } from '../env.js';
import { log } from '../log.js';
import { CommonProps } from '../types.js';
import {
  BootstrapTemplate,
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
};

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
    })
    .example(
      '$0 bootstrap my-app',
      'Create ./my-app from an interactively chosen template',
    )
    .example(
      '$0 bootstrap . --template hono',
      'Scaffold the Hono template into the current directory',
    )
    .strict();

export const handler = async (props: BootstrapProps): Promise<void> => {
  const templates = await fetchTemplates();

  if (props.listTemplates) {
    for (const t of templates) {
      log.info('%s — %s', t.id, t.description);
    }
    return;
  }

  const interactive = Boolean(process.stdout.isTTY) && !isCi();
  const template = await resolveSelectedTemplate(props, interactive, templates);
  const targetDir = await resolveTargetDir(props, interactive, template);
  ensureTargetUsable(targetDir, props.force);
  await scaffold(template, targetDir);
  printNextSteps(template, targetDir);
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
      title: template.title,
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

const ensureTargetUsable = (dir: string, force: boolean): void => {
  if (!existsSync(dir)) {
    return;
  }
  if (!statSync(dir).isDirectory()) {
    throw new Error(`Target ${dir} already exists and is not a directory.`);
  }
  // A lone `.git` is ignored so you can scaffold into a freshly `git init`ed
  // (otherwise empty) directory without reaching for --force.
  const contents = readdirSync(dir).filter((name) => name !== '.git');
  if (contents.length > 0 && !force) {
    throw new Error(
      `Target directory ${dir} is not empty. Use --force to scaffold into it anyway (colliding files will be overwritten), or choose an empty directory.`,
    );
  }
};

const scaffold = async (
  template: BootstrapTemplate,
  targetDir: string,
): Promise<void> => {
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

const printNextSteps = (
  template: BootstrapTemplate,
  targetDir: string,
): void => {
  const rel = relative(process.cwd(), targetDir);
  // Show the bare relative path for the common `bootstrap my-app` case, fall
  // back to the absolute path when the target sits outside the cwd (a deep
  // `../../..` is noise), and special-case the current directory.
  const isCurrent = rel === '';
  const display = isCurrent ? '.' : rel.startsWith('..') ? targetDir : rel;
  log.info('');
  log.info(
    'Done. Scaffolded "%s" into %s.',
    template.title,
    isCurrent ? 'the current directory' : display,
  );
  log.info('');
  log.info('Next steps:');
  if (!isCurrent) {
    log.info('  cd %s', display);
  }
  log.info('  Install dependencies, then see the README to run it.');
  log.info('');
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
