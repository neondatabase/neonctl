import { expect } from 'vitest';

export default function (req, res) {
  // Differentiate replace vs merge by inspecting the body.
  // --replace path: only the explicitly passed fields appear in settings.
  // merge path:    fields previously fetched from GET also appear.
  if (req.body.settings && req.body.settings.db_max_rows === 250) {
    // --replace test sends ONLY db_max_rows
    expect(req.body).toEqual({
      settings: { db_max_rows: 250 },
    });
  } else {
    // merge test asserts these are present, then we'll lock down further
    // when implementing merge (Task 7)
    expect(req.body.settings).toBeDefined();
  }
  res.status(200).send({});
}
