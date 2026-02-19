import { init } from 'neon-init';
import yargs from 'yargs';
import { sendError } from '../analytics.js';
import { log } from '../log.js';

const AGENT_FLAG_VALUES = ['cursor', 'copilot', 'claude'] as const;

type Editor = 'Cursor' | 'VS Code' | 'Claude CLI';

function parseAgentToEditor(value: string): Editor | null {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case 'cursor':
      return 'Cursor';
    case 'github-copilot':
    case 'copilot':
    case 'vs code':
    case 'vscode':
    case 'vs-code':
      return 'VS Code';
    case 'claude-code':
    case 'claude cli':
    case 'claude-cli':
    case 'claude':
      return 'Claude CLI';
    default:
      return null;
  }
}

export const command = 'init';
export const describe =
  'Initialize a project with Neon using your AI coding assistant';
export const builder = (yargs: yargs.Argv) =>
  yargs
    .option('context-file', {
      hidden: true,
    })
    .option('agent', {
      alias: 'a',
      type: 'string',
      describe: 'Agent to configure (cursor, copilot, code).',
    })
    .strict(false);

export const handler = async (argv: { agent?: string }) => {
  let options: { agent: Editor } | undefined;
  const agentArg = argv.agent;
  if (agentArg !== undefined) {
    const editor = parseAgentToEditor(agentArg);
    if (editor === null) {
      log.error(
        `Invalid --agent value: "${agentArg}". Supported: ${AGENT_FLAG_VALUES.join(', ')}`,
      );
      process.exit(1);
      return;
    }
    options = { agent: editor };
  }
  try {
    await init(options);
  } catch {
    const exitError = new Error(`failed to run neon-init`);
    sendError(exitError, 'NEON_INIT_FAILED');
    process.exit(1);
  }
};
