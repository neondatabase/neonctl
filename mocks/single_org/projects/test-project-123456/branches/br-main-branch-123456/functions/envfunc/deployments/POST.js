import { expect } from 'vitest';

export default function (req, res) {
  expect(req.headers['content-type']).toMatch(
    /^multipart\/form-data; boundary=/,
  );
  let raw = '';
  req.setEncoding('latin1');
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    expect(raw).toContain('name="environment"');
    expect(raw).toContain('{"KEY":"VALUE","A":"B"}');
    res.status(201).send({
      operation: { id: 'op-1', action: 'deploy_function', status: 'running' },
    });
  });
}
