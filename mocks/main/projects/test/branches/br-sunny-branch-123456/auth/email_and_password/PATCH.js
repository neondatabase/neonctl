export default function (req, res) {
  res.send({
    enabled: req.body.enabled ?? true,
    email_verification_method: req.body.email_verification_method ?? 'link',
    require_email_verification: req.body.require_email_verification ?? false,
    auto_sign_in_after_verification: req.body.auto_sign_in_after_verification ?? true,
    send_verification_email_on_sign_up: req.body.send_verification_email_on_sign_up ?? true,
    send_verification_email_on_sign_in: req.body.send_verification_email_on_sign_in ?? false,
    disable_sign_up: req.body.disable_sign_up ?? false,
  });
}
