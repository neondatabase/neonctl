import type { ResolvedBranchConfig } from '@neondatabase/config';
import type { PulledBranchConfig } from '@neondatabase/config-runtime';
import { describe, expect, it } from 'vitest';

import { formatDurationSeconds, toNeonConfigView } from './config_format.js';

describe('formatDurationSeconds', () => {
  it('renders clean unit boundaries, preferring the largest unit', () => {
    expect(formatDurationSeconds(604800)).toBe('1w'); // 7 days collapses to 1 week
    expect(formatDurationSeconds(3 * 24 * 60 * 60)).toBe('3d');
    expect(formatDurationSeconds(3600)).toBe('1h');
    expect(formatDurationSeconds(300)).toBe('5m');
    expect(formatDurationSeconds(2 * 7 * 24 * 60 * 60)).toBe('2w');
  });

  it('falls back to seconds when no clean unit matches', () => {
    expect(formatDurationSeconds(90)).toBe('90s');
  });
});

describe('toNeonConfigView', () => {
  const base: ResolvedBranchConfig = {
    authEnabled: false,
    dataApiEnabled: false,
  };

  it('omits disabled services and an empty branch/preview', () => {
    expect(toNeonConfigView(base, undefined)).toEqual({});
  });

  it('surfaces enabled services as `true` only', () => {
    const view = toNeonConfigView(
      { authEnabled: true, dataApiEnabled: true },
      undefined,
    );
    expect(view).toEqual({ auth: true, dataApi: true });
  });

  it('renders the branch tuning section, with ttl as a duration string', () => {
    const view = toNeonConfigView(
      {
        authEnabled: false,
        dataApiEnabled: false,
        parent: 'main',
        ttlSeconds: 604800,
        protected: true,
        postgres: { computeSettings: { autoscalingLimitMaxCu: 2 } },
      },
      undefined,
    );
    expect(view.branch).toEqual({
      parent: 'main',
      ttl: '1w',
      protected: true,
      postgres: { computeSettings: { autoscalingLimitMaxCu: 2 } },
    });
  });

  it('projects preview functions/buckets into slug/name-keyed records', () => {
    const preview: PulledBranchConfig['preview'] = {
      functions: [{ slug: 'hello', name: 'Hello' }],
      buckets: [{ name: 'uploads', access: 'public_read' }],
      credentials: [],
    };
    const view = toNeonConfigView(base, preview);
    expect(view.preview).toEqual({
      functions: { hello: { name: 'Hello' } },
      buckets: { uploads: { access: 'public_read' } },
    });
  });

  it('projects issued credentials (secret-free) into the preview view', () => {
    const preview: PulledBranchConfig['preview'] = {
      functions: [],
      buckets: [],
      credentials: [
        {
          tokenId: 'dc52e816-839c-462d-a7d5-f26ed768f65a',
          tokenIdShort: 'dc52e816839c',
          name: 'app',
          scopes: ['storage:read', 'storage:write'],
          principalType: 'user',
          createdAt: '2026-06-10T17:12:01Z',
          lastUsedAt: '2026-06-10T18:00:00Z',
        },
      ],
    };
    expect(toNeonConfigView(base, preview).preview).toEqual({
      credentials: [
        {
          id: 'dc52e816839c',
          name: 'app',
          scopes: ['storage:read', 'storage:write'],
          lastUsedAt: '2026-06-10T18:00:00Z',
        },
      ],
    });
  });

  it('omits an all-empty preview', () => {
    const preview: PulledBranchConfig['preview'] = {
      functions: [],
      buckets: [],
      credentials: [],
    };
    expect(toNeonConfigView(base, preview).preview).toBeUndefined();
  });
});
