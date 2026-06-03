import { expect } from 'vitest';

export default function (req, res) {
  // The body is multipart/form-data; express.json() does not parse it, so we
  // assert serialization happened correctly via the Content-Type boundary.
  expect(req.headers['content-type']).toMatch(
    /^multipart\/form-data; boundary=/,
  );
  res.status(201).send({
    deployment: {
      id: 1,
      status: 'pending',
      bundle_sha256: 'abc123',
      memory_mib: 256,
      concurrency: 1,
      runtime: 'nodejs24',
      created_at: '2026-06-03T00:00:00Z',
    },
  });
}
