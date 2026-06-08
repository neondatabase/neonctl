// Custom vitest reporter that prints the conformance headline:
//
//   Conformance: 142/180 passed (12 todo, 4 skipped)
//
// Vitest already counts pass/fail/skip/todo natively; the reporter
// just totals across the tree so we get a single end-of-run summary.

import type { File, Task, TaskResult } from '@vitest/runner';
import type { Reporter } from 'vitest';
import { log } from './util-log.js';

type Counters = {
  pass: number;
  fail: number;
  skipped: number;
  todo: number;
};

export default class ConformanceReporter implements Reporter {
  onFinished(files?: File[], errors?: unknown[]): void {
    const counters: Counters = {
      pass: 0,
      fail: 0,
      skipped: 0,
      todo: 0,
    };
    if (files) {
      for (const f of files) {
        walk(f, counters);
      }
    }
    const total = counters.pass + counters.fail;
    const coverage =
      total === 0 ? 0 : Math.round((counters.pass / total) * 10000) / 100;
    const headline =
      `Conformance: ${counters.pass}/${total} passed ` + `(${coverage}%)`;

    log('---');
    log(headline);
    if (counters.fail > 0) {
      log(`  failures: ${counters.fail}`);
    }
    if (counters.todo > 0) {
      log(`  todo: ${counters.todo}`);
    }
    if (counters.skipped > 0) {
      log(`  skipped: ${counters.skipped}`);
    }
    if (errors && errors.length > 0) {
      log(`  reporter-level errors: ${errors.length}`);
    }
    log('---');
  }
}

function walk(task: Task, counters: Counters): void {
  if (task.type === 'suite') {
    for (const child of task.tasks) {
      walk(child, counters);
    }
    return;
  }
  classify(task.result, counters);
}

function classify(result: TaskResult | undefined, counters: Counters): void {
  if (!result) {
    counters.skipped += 1;
    return;
  }
  switch (result.state) {
    case 'pass':
      counters.pass += 1;
      break;
    case 'fail':
      counters.fail += 1;
      break;
    case 'todo':
      counters.todo += 1;
      break;
    case 'skip':
      counters.skipped += 1;
      break;
    default:
      // 'run', etc. — treat as skip for accounting.
      counters.skipped += 1;
  }
}
