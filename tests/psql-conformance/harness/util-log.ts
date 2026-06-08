// stderr logger for the conformance harness.
// We avoid `console.*` because the repo's eslint rule `no-console: 'error'`
// applies to every .ts file in the project.

export function log(msg: string): void {
  process.stderr.write(`[psql-conformance] ${msg}\n`);
}
