#! /usr/bin/env node

// A npx mock that simulates running neon-init
// It prints the command and arguments to stdout for testing
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args[0] === 'neon-init') {
    process.stdout.write(
      JSON.stringify({
        'npx-command': 'neon-init',
        'neon-init-args': args.slice(1),
      }),
    );
    process.exit(0);
  } else {
    process.stderr.write(`npx: unknown command: ${args[0]}\n`);
    process.exit(1);
  }
}
