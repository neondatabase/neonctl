import { expect } from 'vitest';

export default function (req, res) {
  if (Object.keys(req.body).length === 0) {
    // cache-refresh test: empty body refreshes schema cache without changing settings.
    expect(req.body).toEqual({});
  } else if (
    req.body.settings &&
    req.body.settings.db_max_rows === 250 &&
    Object.keys(req.body.settings).length === 1
  ) {
    // --replace test sends ONLY db_max_rows
    expect(req.body).toEqual({
      settings: { db_max_rows: 250 },
    });
  } else {
    // merge test: db_max_rows changed by the user; everything else
    // matches the GET fixture's settings.
    expect(req.body).toEqual({
      settings: {
        db_aggregates_enabled: true,
        db_anon_role: 'anonymous',
        db_schemas: ['public', 'analytics'],
        jwt_role_claim_key: '.role',
        db_max_rows: 9999,
      },
    });
  }
  res.status(200).send({});
}
