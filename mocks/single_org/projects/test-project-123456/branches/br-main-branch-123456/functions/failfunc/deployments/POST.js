import { expect } from 'vitest';

// The deploy POST returns an operation the CLI ignores; it only needs 2xx.
export default function (req, res) {
  expect(req.headers['content-type']).toMatch(
    /^multipart\/form-data; boundary=/,
  );
  res.status(201).send({
    operation: { id: 'op-1', action: 'deploy_function', status: 'running' },
  });
}
