import { expect } from 'vitest';

export default function (req, res) {
  expect(req.headers['content-type']).toMatch(
    /^multipart\/form-data; boundary=/,
  );
  res.status(201).send({
    deployment: {
      id: 1,
      status: 'pending',
      bundle_sha256: 'stuck123',
      memory_mib: 256,
      runtime: 'nodejs24',
      created_at: '2026-06-03T00:00:00Z',
    },
  });
}
