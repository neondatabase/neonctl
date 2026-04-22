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

  // --- Config: Email and Password ---

  test('email-password get', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'config',
      'email-password',
      'get',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
    ]);
  });

  test('email-password update', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'config',
      'email-password',
      'update',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
      '--enabled',
      '--require-email-verification',
    ]);
  });

  // --- Config: Email Provider ---

  test('email-provider get', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'config',
      'email-provider',
      'get',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
    ]);
  });

  test('email-provider update', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'config',
      'email-provider',
      'update',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
      '--type',
      'shared',
    ]);
  });

  test('email-provider test', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'config',
      'email-provider',
      'test',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
      '--recipient-email',
      'user@test.com',
      '--host',
      'smtp.test.com',
      '--port',
      '587',
      '--username',
      'smtp-user',
      '--password',
      'smtp-pass',
      '--sender-email',
      'noreply@test.com',
      '--sender-name',
      'Test App',
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

  // --- Config: Organization ---

  test('organization get', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'config',
      'organization',
      'get',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
    ]);
  });

  test('organization update', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'config',
      'organization',
      'update',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
      '--enabled',
      '--limit',
      '10',
    ]);
  });

  // --- Config: Webhook ---

  test('webhook get', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'config',
      'webhook',
      'get',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
    ]);
  });

  test('webhook update', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'config',
      'webhook',
      'update',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
      '--enabled',
      '--url',
      'https://hooks.test.com/webhook',
      '--enabled-events',
      'user.created',
    ]);
  });

  // --- Plugins ---

  test('plugins list', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'plugins',
      'list',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
    ]);
  });

  test('plugins get', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'plugins',
      'get',
      'organization',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
    ]);
  });

  test('plugins update', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'plugins',
      'update',
      'organization',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
      '--json',
      '{"enabled": true, "organization_limit": 10}',
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
