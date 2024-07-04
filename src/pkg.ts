import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const currPath = join(__dirname, 'package.json');
const parentPath = resolve(__dirname, '..', 'package.json');

const pkgJsonPath = existsSync(currPath)
  ? currPath
  : existsSync(parentPath)
    ? parentPath
    : undefined;

if (!pkgJsonPath) {
  throw new Error('package.json not found');
}

export default JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
