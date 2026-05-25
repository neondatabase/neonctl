// Custom vitest reporter that prints the conformance headline:
//
//   Conformance: 142/180 = 78.9% (38 expected failures across 3 tickets)
//
// Expected failures are detected by inspecting the resolved task name
// (or, when the test surface settles, structured task meta). For now
// we count tests whose passing assertion produced the marker string
// `[expected-failure]` in the test name. Tests fold that marker in
// from regress.spec.ts via `it.each` parameter formatting; the
// reporter just totals.

import type { File, Task, TaskResult } from '@vitest/runner';
import type { Reporter } from 'vitest';
import { log } from './util-log.js';

const EXPECTED_FAILURE_MARKER = '[expected-failure]';

type Counters = {
  pass: number;
  expectedFailure: number;
  fail: number;
  skipped: number;
  tickets: Set<string>;
};

export default class ConformanceReporter implements Reporter {
  onFinished(files?: File[], errors?: unknown[]): void {
    const counters: Counters = {
      pass: 0,
      expectedFailure: 0,
      fail: 0,
      skipped: 0,
      tickets: new Set<string>(),
    };
    if (files) {
      for (const f of files) {
        walk(f, counters);
      }
    }
    const total = counters.pass + counters.expectedFailure;
    const coverage =
      total === 0 ? 0 : Math.round((counters.pass / total) * 10000) / 100;
    const ticketSuffix =
      counters.tickets.size > 0
        ? ` across ${counters.tickets.size} ticket${counters.tickets.size === 1 ? '' : 's'}`
        : '';
    const headline =
      `Conformance: ${counters.pass}/${total} = ${coverage}% ` +
      `(${counters.expectedFailure} expected failure${counters.expectedFailure === 1 ? '' : 's'}${ticketSuffix})`;

    log('---');
    log(headline);
    if (counters.fail > 0) {
      log(`  unexpected failures: ${counters.fail}`);
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
  classify(task.name, task.result, counters);
}

function classify(
  name: string,
  result: TaskResult | undefined,
  counters: Counters,
): void {
  const isExpectedFailure = name.includes(EXPECTED_FAILURE_MARKER);
  // Pull NEON-XXXXX style tickets out of the test name for the headline.
  const ticketMatch = /(NEON-\d+|WP-\d+|#\d+)/g.exec(name);
  if (ticketMatch && isExpectedFailure) {
    counters.tickets.add(ticketMatch[0]);
  }
  if (!result) {
    counters.skipped += 1;
    return;
  }
  switch (result.state) {
    case 'pass':
      if (isExpectedFailure) {
        counters.expectedFailure += 1;
      } else {
        counters.pass += 1;
      }
      break;
    case 'fail':
      counters.fail += 1;
      break;
    case 'skip':
    case 'todo':
      counters.skipped += 1;
      break;
    default:
      // 'run', etc. — treat as skip for accounting.
      counters.skipped += 1;
  }
}
