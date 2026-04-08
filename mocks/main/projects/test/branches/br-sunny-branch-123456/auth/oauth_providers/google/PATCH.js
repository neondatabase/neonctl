export default function (req, res) {
  res.send({
    id: 'google',
    type: 'standard',
    client_id: req.body.client_id || 'updated-client-id',
  });
}
