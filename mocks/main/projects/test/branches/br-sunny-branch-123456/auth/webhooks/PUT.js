import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toHaveProperty('enabled');
  expect(req.body).toHaveProperty('webhook_url');
  res.send({
    enabled: req.body.enabled,
    webhook_url: req.body.webhook_url || '',
    enabled_events: req.body.enabled_events || [],
    timeout_seconds: req.body.timeout_seconds || 5,
  });
}
