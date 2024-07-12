import yargs from 'yargs';
import cliui from 'cliui';
import chalk from 'chalk';

import {
  consumeBlockIfMatches,
  consumeNextMatching,
  drawPointer,
  splitColumns,
} from './utils/ui.js';

// target width for the leftmost column
const SPACE_WIDTH = 20;

const formatHelp = (help: string) => {
  const lines = help.split('\n');
  const result = [] as string[];
  // full command, like `neonctl projects list`
  const topLevelCommand = consumeNextMatching(lines, /^.*/);

  if (topLevelCommand) {
    result.push(
      chalk.bold(
        topLevelCommand.replace('[options]', chalk.reset.green('[options]')),
      ),
    );
    result.push('');
  }

  // commands description block
  // example command to see: neonctl projects
  const commandsBlock = consumeBlockIfMatches(lines, /^Commands:/);
  if (commandsBlock.length > 0) {
    const header = commandsBlock.shift() as string;
    result.push(header);
    const ui = cliui({
      width: 0,
    });
    commandsBlock.forEach((line) => {
      if (/^\s{3,}/.exec(line)) {
        ui.div(
          {
            text: '',
            width: SPACE_WIDTH,
            padding: [0, 0, 0, 0],
          },
          { text: line.trim(), padding: [0, 0, 0, 0] },
        );
        return;
      }

      const [command, description] = splitColumns(line);

      // patch the previous command if it was multiline
      if (!description && ui.rows.length > 1) {
        ui.rows[ui.rows.length - 2][0].text += command;
        return;
      }

      ui.div(chalk.cyan(command));
      ui.div(
        {
          text: chalk.gray(drawPointer(SPACE_WIDTH)),
          width: SPACE_WIDTH,
          padding: [0, 0, 0, 0],
        },
        { text: description, padding: [0, 0, 0, 2] },
      );
    });
    result.push(ui.toString());
    result.push('');
  }

  // positional args block
  // example command to see: neonctl branches rename
  const positionalsBlock = consumeBlockIfMatches(lines, /Positionals:/);
  if (positionalsBlock.length > 0) {
    const header = positionalsBlock.shift() as string;
    result.push(header);
    const ui = cliui({
      width: 0,
    });
    positionalsBlock.forEach((line) => {
      const [positional, description] = splitColumns(line);
      ui.div(
        {
          text: positional,
          width: SPACE_WIDTH,
          padding: [0, 2, 0, 0],
        },
        {
          text: description,
          padding: [0, 0, 0, 0],
        },
      );
    });
    result.push(ui.toString());
    result.push('');
  }

  // command description
  // example command to see: neonctl projects list
  const descritpionBlock = consumeBlockIfMatches(lines, /^(?!.*options:)/i);
  if (descritpionBlock.length > 0) {
    result.push(...descritpionBlock);
    result.push('');
  }

  while (true) {
    // there are two options blocks: global and specific
    // example to see both: neonctl projects create
    const optionsBlock = consumeBlockIfMatches(lines, /.*options:/i);
    if (optionsBlock.length === 0) {
      break;
    }
    result.push(optionsBlock.shift() as string);
    optionsBlock.forEach((line) => {
      const [option, description] = splitColumns(line);
      const ui = cliui({
        width: 0,
      });
      if (option.startsWith('-')) {
        ui.div({
          text: chalk.green(option),
          padding: [0, 0, 0, 0],
        });
        ui.div(
          {
            text: chalk.gray(drawPointer(SPACE_WIDTH)),
            width: SPACE_WIDTH,
            padding: [0, 2, 0, 0],
          },
          {
            text: chalk.rgb(210, 210, 210)(description ?? ''),
            padding: [0, 0, 0, 0],
          },
        );
      } else {
        ui.div(
          {
            padding: [0, 0, 0, 0],
            text: '',
            width: SPACE_WIDTH,
          },
          {
            text: chalk.rgb(210, 210, 210)(option),
            padding: [0, 0, 0, 0],
          },
        );
      }

      result.push(ui.toString());
    });
    result.push('');
  }

  const exampleBlock = consumeBlockIfMatches(lines, /Examples:/);
  if (exampleBlock.length > 0) {
    result.push(exampleBlock.shift() as string);
    const ui = cliui({
      width: 0,
    });
    for (const line of exampleBlock) {
      const [command, description] = splitColumns(line);
      ui.div({
        text: chalk.bold(command),
        padding: [0, 0, 0, 0],
      });
      ui.div({
        text: chalk.reset(description),
        padding: [0, 0, 0, 2],
      });
    }
    result.push(ui.toString());
  }

  return [...result, ...lines];
};

export const showHelp = async (argv: yargs.Argv) => {
  // add wrap to ensure that there are no line breaks
  const help = await argv.getHelp();
  process.stderr.write(formatHelp(help).join('\n') + '\n');
  process.exit(0);
};
