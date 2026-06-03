import { expect } from 'vitest';

export default function (req, res) {
  expect(req.headers['content-type']).toMatch(
    /^multipart\/form-data; boundary=/,
  );
  // Safe to read the raw stream: the harness mounts express.json(), which only
  // consumes application/json bodies and passes multipart through untouched.
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
    if (raw.includes('name="environment"')) {
      expect(raw).toContain('{"KEY":"VALUE","A":"B"}');
    }
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
  });
}
