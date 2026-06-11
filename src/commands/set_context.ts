import { log } from '../log.js';
import { builder as linkBuilder, handler as linkHandler } from './link.js';

/**
 * `set-context` is a deprecated alias of `link`. It shares `link`'s flags and
 * behavior exactly (the same resolution, verification, and `.neon` write) and
 * only adds a one-line deprecation warning. The warning goes to stderr via
 * `log`, so it never pollutes stdout or the `--agent` JSON contract. Remove this
 * command in a future major once users have migrated to `link`.
 */
export const command = 'set-context';
export const describe =
  'Deprecated: use `neonctl link`. Set the .neon context.';
export const builder = linkBuilder;

export const handler = async (
  props: Parameters<typeof linkHandler>[0],
): Promise<void> => {
  log.warning(
    '`neonctl set-context` is deprecated and will be removed in a future release. Use `neonctl link` instead — it accepts the same flags.',
  );
  await linkHandler(props);
};
