let calls = 0;

// call 1 = pre-deploy snapshot (404, no prior version); call 2+ = a 403 the
// poll loop must NOT swallow — it should surface and fail fast.
export default function (req, res) {
  calls += 1;
  if (calls === 1) return res.status(404).send({ message: 'Not Found' });
  return res.status(403).send({ message: 'Forbidden' });
}
