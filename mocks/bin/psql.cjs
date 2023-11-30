#! /usr/bin/env node

// A psql mock that just prints its arguments (as an array in an object) to stdout.
// Node.js script should have an extension (otherwise ERR_UNKNOWN_FILE_EXTENSION is thrown), so we use a symlink psql -> psql.cjs
if (require.main === module) {
  process.stdout.write(
    JSON.stringify({ 'psql-cli-args': process.argv.slice(2) }),
  );
}
