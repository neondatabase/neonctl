// Code copied from `create-next-app`.

import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';

// `isFolderEmpty` checks if a folder is empty and ready to onboard a Next.js package into it.
// It will actually log to stdout as part of its execution.
export function isFolderEmpty(
  root: string,
  name: string,
  writeStdout: (data: string) => void,
): boolean {
  const validFiles = new Set([
    '.DS_Store',
    '.git',
    '.gitattributes',
    '.gitignore',
    '.gitlab-ci.yml',
    '.hg',
    '.hgcheck',
    '.hgignore',
    '.idea',
    '.npmignore',
    '.travis.yml',
    'LICENSE',
    'Thumbs.db',
    'docs',
    'mkdocs.yml',
    'npm-debug.log',
    'yarn-debug.log',
    'yarn-error.log',
    'yarnrc.yml',
    '.yarn',
  ]);

  const conflicts = readdirSync(root).filter(
    (file) =>
      !validFiles.has(file) &&
      // Support IntelliJ IDEA-based editors
      !/\.iml$/.test(file),
  );

  if (conflicts.length > 0) {
    writeStdout(
      `The directory ${chalk.green(
        name,
      )} contains files that could conflict:\n`,
    );
    writeStdout('');
    for (const file of conflicts) {
      try {
        const stats = lstatSync(join(root, file));
        if (stats.isDirectory()) {
          writeStdout(`  ${chalk.blue(file)}/\n`);
        } else {
          writeStdout(`  ${file}\n`);
        }
      } catch {
        writeStdout(`  ${file}\n`);
      }
    }
    writeStdout('\n');
    writeStdout(
      'Either try using a new directory name, or remove the files listed above.\n',
    );
    writeStdout('\n');
    return false;
  }

  return true;
}
