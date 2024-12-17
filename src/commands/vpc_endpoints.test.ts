import { describe } from 'vitest';
import { test } from '../test_utils/fixtures';

describe('vpc-endpoints', () => {
  test('list org VPC endpoints', async ({ testCliCommand }) => {
    await testCliCommand(
      ['vpc', 'endpoint', 'list', '--org-id', '1', '--region-id', 'test'],
      { mockDir: 'single_org' },
    );
  });

  test('list org VPC endpoints implicit org', async ({ testCliCommand }) => {
    await testCliCommand(['vpc', 'endpoint', 'list', '--region-id', 'test'], {
      mockDir: 'single_org',
    });
  });

  test('update org VPC endpoint', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'vpc',
        'endpoint',
        'update',
        'vpc-test',
        '--label',
        'newlabel',
        '--region-id',
        'test',
      ],
      { mockDir: 'single_org' },
    );
  });

  test('delete org VPC endpoint', async ({ testCliCommand }) => {
    await testCliCommand(
      ['vpc', 'endpoint', 'remove', 'vpc-test', '--region-id', 'test'],
      { mockDir: 'single_org' },
    );
  });

  test('get org VPC endpoint status', async ({ testCliCommand }) => {
    await testCliCommand(
      ['vpc', 'endpoint', 'status', 'vpc-test', '--region-id', 'test'],
      { mockDir: 'single_org' },
    );
  });

  test('set org VPC endpoint in azure', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'vpc',
        'endpoint',
        'update',
        'vpc-test',
        '--label',
        'newlabel',
        '--region-id',
        'azure-test',
      ],
      {
        mockDir: 'single_org',
        stderr:
          'INFO: VPC endpoint configuration is not supported for Azure regions',
      },
    );
  });

  test('list project VPC endpoint restrictions', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'vpc',
        'project',
        'list',
        '--region-id',
        'test',
        '--project-id',
        'test-project-123456',
      ],
      { mockDir: 'single_org' },
    );
  });

  test('list project VPC endpoint restrictions with implicit project', async ({
    testCliCommand,
  }) => {
    await testCliCommand(['vpc', 'project', 'list', '--region-id', 'test'], {
      mockDir: 'single_org',
    });
  });

  test('set project VPC endpoint restrictions', async ({ testCliCommand }) => {
    await testCliCommand(
      ['vpc', 'project', 'update', 'vpc-test', '--label', 'newlabel'],
      { mockDir: 'single_org' },
    );
  });

  test('delete project VPC endpoint restrictions', async ({
    testCliCommand,
  }) => {
    await testCliCommand(['vpc', 'project', 'remove', 'vpc-test'], {
      mockDir: 'single_org',
    });
  });
});
