import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toHaveProperty('enabled');
  expect(req.body).toHaveProperty('require_email_verification');
  res.send({
    enabled: req.body.enabled ?? true,
    email_verification_method: req.body.email_verification_method ?? 'link',
    require_email_verification: req.body.require_email_verification ?? false,
    auto_sign_in_after_verification:
      req.body.auto_sign_in_after_verification ?? true,
    send_verification_email_on_sign_up:
      req.body.send_verification_email_on_sign_up ?? true,
    send_verification_email_on_sign_in:
      req.body.send_verification_email_on_sign_in ?? false,
    disable_sign_up: req.body.disable_sign_up ?? false,
  });
}
