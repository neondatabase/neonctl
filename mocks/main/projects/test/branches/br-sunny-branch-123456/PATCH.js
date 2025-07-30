import { expect } from 'vitest';

export default function (req, res) {
  // branches rename
  if (
    req.body.branch.name &&
    req.body.branch.name !== 'br-sunny-branch-123456'
  ) {
    expect(req.body).toMatchObject({
      branch: {
        name: 'new_test_branch',
      },
    });
    res.send({
      branch: {
        name: 'new_test_branch',
        created_at: '2021-01-01T00:00:00.000Z',
      },
    });
    return;
  }

  // branches set-expiration
  if (req.body.branch.hasOwnProperty('expires_at')) {
    const expiresAt = req.body.branch.expires_at;
    res.send({
      branch: {
        id: 'br-sunny-branch-123456',
        name: 'test_branch',
        created_at: '2021-01-01T00:00:00.000Z',
        expires_at: expiresAt,
        current_state: 'ready',
        default: false,
      },
    });
    return;
  }

  /**
   * @default
   */
  res.status(400).send({ message: 'Unsupported PATCH operation' });
}
