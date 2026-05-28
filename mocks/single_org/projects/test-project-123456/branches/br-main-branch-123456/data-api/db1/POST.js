import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toMatchObject({
    auth_provider: 'neon_auth',
    add_default_grants: true,
    settings: {
      db_schemas: ['public', 'analytics'],
      db_max_rows: 500,
    },
  });
  expect(req.body.skip_auth_schema).toBeUndefined();
  expect(req.body.settings.db_anon_role).toBeUndefined();
  expect(req.body.settings.server_timing_enabled).toBeUndefined();

  res.status(200).send({
    url: 'https://app-test.dataproxy.neon.tech',
  });
}
