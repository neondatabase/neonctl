import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toMatchObject({
    auth_provider: 'better_auth',
  });

  res.send({
    auth_provider: 'better_auth',
    auth_provider_project_id: 'test-auth-project-id',
    pub_client_key: 'pk_test_123',
    secret_server_key: 'sk_test_456',
    jwks_url: 'https://auth.test.neon.tech/.well-known/jwks.json',
    schema_name: 'neon_auth',
    table_name: 'users_sync',
    base_url: 'https://auth.test.neon.tech',
  });
}
