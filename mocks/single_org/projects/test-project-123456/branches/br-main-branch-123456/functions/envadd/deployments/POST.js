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
    expect(raw).toContain('{"KEY":"VALUE"}');
    // env-only redeploy: no bundle/memory/runtime parts.
    expect(raw).not.toContain('name="zip"');
    expect(raw).not.toContain('name="memory_mib"');
    expect(raw).not.toContain('name="runtime"');
    // Start a fresh deploy cycle for the paired GET mock: version 2 begins
    // building now, independent of any state left by an earlier test.
    globalThis.__envadd = { polls: 0, deploying: true };
    res.status(201).send({
      operation: { id: 'op-1', action: 'deploy_function', status: 'running' },
    });
  });
}
