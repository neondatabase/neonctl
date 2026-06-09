import { afterEach, describe, expect, it } from 'vitest';

import { pickBranchInteractively } from './branch_picker.js';

describe('pickBranchInteractively', () => {
  const originalIsTTY = process.stdout.isTTY;

  afterEach(() => {
    process.stdout.isTTY = originalIsTTY;
  });

  it('throws the caller-supplied message when there is no interactive terminal', async () => {
    // Force the non-interactive condition deterministically (vitest usually pipes stdout,
    // but a developer running this in a real terminal would otherwise hit the prompt).
    process.stdout.isTTY = false;

    await expect(
      pickBranchInteractively([], {
        message: 'Which branch would you like to link?',
        nonInteractiveMessage: 'no TTY: pass a branch explicitly',
      }),
    ).rejects.toThrow('no TTY: pass a branch explicitly');
  });

  it('uses the message verbatim so each command can tailor its guidance', async () => {
    process.stdout.isTTY = false;

    await expect(
      pickBranchInteractively([], {
        message: 'Which branch would you like to check out?',
        nonInteractiveMessage:
          'No branch specified. Pass a branch name or id (e.g. `neonctl checkout main`), ' +
          'or run interactively to pick one from a list.',
      }),
    ).rejects.toThrow(/neonctl checkout main/);
  });
});
