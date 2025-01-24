import { log } from '../log.js';

type ManagedServiceSpec = {
  name: string;
  type: string;
  maxVCpu: number;
  postgresVersion: number;
  autoSuspend: boolean;
  historyRetentionSeconds: number;
  setupSQL?: string;
};

export function parseManagedServiceSql(input: string): ManagedServiceSpec {
  try {
    // Extract service name and type using regex
    const createRegex =
      /CREATE\s+MANAGED\s+SERVICE\s+(\w+)\s+TYPE=(\w+)\s+SPECIFICATION=\$\$([\s\S]*?)\$\$/i;
    const createMatch = createRegex.exec(input);
    if (!createMatch) {
      throw new Error(
        'Invalid SQL format. Expected: CREATE MANAGED SERVICE <name> TYPE=<type> SPECIFICATION=$$..$$',
      );
    }

    const [, name, type, specBlock] = createMatch;

    if (type !== 'POSTGRES_NEON') {
      throw new Error('Only POSTGRES_NEON type is supported');
    }

    // Parse the YAML-like specification block
    const spec: Partial<ManagedServiceSpec> = {
      name,
      type,
    };

    // Split the spec block into lines and parse each line
    const lines = specBlock.trim().split('\n');

    // Skip the 'spec:' line if present
    const startIndex = lines[0].trim() === 'spec:' ? 1 : 0;

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Extract key and value, handling both ':' and '=' separators
      const lineRegex = /^\s*(\w+)\s*[:=]\s*(.+)$/;
      const match = lineRegex.exec(line);
      if (!match) continue;

      const [, key, value] = match;

      switch (key.toLowerCase()) {
        case 'maxvcpu':
          spec.maxVCpu = parseFloat(value);
          if (isNaN(spec.maxVCpu)) {
            throw new Error('maxVCpu must be a number');
          }
          break;
        case 'postgresversion':
          spec.postgresVersion = parseInt(value, 10);
          if (![14, 15, 16, 17].includes(spec.postgresVersion)) {
            throw new Error('postgresVersion must be one of: 14, 15, 16, 17');
          }
          break;
        case 'autosuspend':
          spec.autoSuspend = value.toLowerCase() === 'true';
          break;
        case 'historyretentionseconds':
          spec.historyRetentionSeconds = parseInt(value, 10);
          if (isNaN(spec.historyRetentionSeconds)) {
            throw new Error('historyRetentionSeconds must be a number');
          }
          break;
        case 'setupsql':
          spec.setupSQL = value.trim();
          break;
        default:
          log.warning(`Unknown specification parameter: ${key}`);
      }
    }

    // Validate required fields
    if (!spec.maxVCpu || !spec.postgresVersion) {
      throw new Error(
        'Missing required fields: maxVCpu and postgresVersion are required',
      );
    }

    return spec as ManagedServiceSpec;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to parse SQL statement: ${error.message}`);
    }
    throw error;
  }
}
