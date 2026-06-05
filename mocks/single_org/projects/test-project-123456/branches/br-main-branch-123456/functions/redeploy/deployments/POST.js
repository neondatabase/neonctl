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
    expect(raw).toContain('name="zip"; filename="bundle.zip"');
    expect(raw).toContain('PK'); // ZIP local-file-header magic
    expect(raw).toContain('name="memory_mib"');
    expect(raw).toContain('name="runtime"');
    res.status(201).send({
      operation: { id: 'op-1', action: 'deploy_function', status: 'running' },
    });
  });
}
