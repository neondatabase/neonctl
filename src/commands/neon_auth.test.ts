import { describe } from 'vitest';
import { test } from '../test_utils/fixtures';

describe('neon-auth', () => {
  // --- Enable / Status / Disable ---

  test('enable', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'enable',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
    ]);
  });

  test('enable already enabled', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'neon-auth',
        'enable',
        '--project-id',
        'test',
        '--branch',
        'test_branch',
      ],
      { mockDir: 'neon-auth-already-enabled' },
    );
  });

  test('status', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'status',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
    ]);
  });

  test('status not configured', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'neon-auth',
        'status',
        '--project-id',
        'test',
        '--branch',
        'test_branch',
      ],
      { mockDir: 'neon-auth-not-configured' },
    );
  });

  test('disable', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'disable',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
    ]);
  });

  test('disable with delete data', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'neon-auth',
        'disable',
        '--project-id',
        'test',
        '--branch',
        'test_branch',
        '--delete-data',
      ],
      { mockDir: 'neon-auth-delete-data' },
    );
  });

  // --- OAuth Provider ---

  test('oauth-provider list', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'oauth-provider',
      'list',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
    ]);
  });

  test('oauth-provider add', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'oauth-provider',
      'add',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
      '--provider-id',
      'google',
    ]);
  });

  test('oauth-provider update', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'oauth-provider',
      'update',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
      '--provider-id',
      'google',
      '--oauth-client-id',
      'my-client-id',
    ]);
  });

  test('oauth-provider delete', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'oauth-provider',
      'delete',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
      '--provider-id',
      'google',
    ]);
  });

  // --- Domain ---

  test('domain list', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'domain',
      'list',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
    ]);
  });

  test('domain add', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'domain',
      'add',
      'https://myapp.com',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
    ]);
  });

  test('domain delete', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'domain',
      'delete',
      'https://example.com',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
    ]);
  });

  // --- Allow localhost ---

  test('domain allow-localhost get', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'domain',
      'allow-localhost',
      'get',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
    ]);
  });

  test('domain allow-localhost enable', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'domain',
      'allow-localhost',
      'enable',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
    ]);
  });

  test('domain allow-localhost disable', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'domain',
      'allow-localhost',
      'disable',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
    ]);
  });

  // --- User ---

  test('user create', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'user',
      'create',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
      '--email',
      'test@example.com',
      '--name',
      'Test User',
    ]);
  });

  test('user delete', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'user',
      'delete',
      'test-user-id',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
    ]);
  });

  test('user set-role', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'user',
      'set-role',
      'test-user-id',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
      '--roles',
      'admin',
    ]);
  });
});
