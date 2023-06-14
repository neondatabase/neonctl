import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export default JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./package.json', import.meta.url)),
    'utf-8'
  )
);
