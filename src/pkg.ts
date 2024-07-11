import { readFileSync } from 'node:fs';
import packageJson from '../package.json' with { type: 'file' };

export default JSON.parse(readFileSync(packageJson, 'utf-8'));
