export default function (req, res) {
  res.send({
    enabled: req.body.enabled,
    webhook_url: req.body.webhook_url || '',
    enabled_events: req.body.enabled_events || [],
    timeout_seconds: req.body.timeout_seconds || 5,
  });
}
