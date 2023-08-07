import yargs from 'yargs';

export const showHelp = async (argv: yargs.Argv) => {
  const help = (await argv.getHelp()) + '\n';
  process.stderr.write(help);
  process.exit(0);
};

export const showHelpMiddleware =
  (argv: yargs.Argv, ignoreSubCmdPresence?: boolean) =>
  async (args: yargs.Arguments) => {
    if ((!ignoreSubCmdPresence && args._.length === 1) || args.help) {
      await showHelp(argv);
    }
  };
