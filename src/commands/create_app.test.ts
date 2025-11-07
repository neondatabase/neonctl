import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

// Mock dependencies that require package.json
vi.mock('../analytics.js', () => ({
  sendError: vi.fn(),
  trackEvent: vi.fn(),
  closeAnalytics: vi.fn(),
}));

// Mock neon-init
vi.mock('neon-init', () => ({
  init: vi.fn().mockResolvedValue(undefined),
}));

// Mock prompts
vi.mock('prompts', () => ({
  default: vi.fn().mockResolvedValue({
    projectId: 'test-project-id',
    branchId: 'test-branch-id',
    orgId: 'test-org-id',
  }),
}));

// Mock env
vi.mock('../env.js', () => ({
  isCi: vi.fn().mockReturnValue(false),
}));

describe('create-app', () => {
  const testContextFile = resolve(process.cwd(), '.neon-test');

  beforeEach(() => {
    // Clean up test file if it exists
    if (existsSync(testContextFile)) {
      unlinkSync(testContextFile);
    }
  });

  afterEach(() => {
    // Clean up test file after each test
    if (existsSync(testContextFile)) {
      unlinkSync(testContextFile);
    }
  });

  test('should call neon-init when --with-init is provided', async () => {
    const { handler } = await import('./create_app.js');
    const { init } = await import('neon-init');

    await handler({
      _: ['create-app'],
      $0: 'neonctl',
      contextFile: testContextFile,
      projectId: 'test-project',
      branchId: 'test-branch',
      orgId: 'test-org',
      withInit: true,
    });

    // Verify neon-init was called
    expect(init).toHaveBeenCalledOnce();
  });

  test('should not call neon-init by default', async () => {
    const { handler } = await import('./create_app.js');
    const { init } = await import('neon-init');

    // Reset the mock
    vi.mocked(init).mockClear();

    await handler({
      _: ['create-app'],
      $0: 'neonctl',
      contextFile: testContextFile,
      projectId: 'test-project',
      branchId: 'test-branch',
      orgId: 'test-org',
    });

    // Verify neon-init was NOT called
    expect(init).not.toHaveBeenCalled();
  });

  test('should create .neon file with provided flags', async () => {
    const { handler } = await import('./create_app.js');

    await handler({
      _: ['create-app'],
      $0: 'neonctl',
      contextFile: testContextFile,
      projectId: 'test-project-id',
      branchId: 'test-branch-id',
      orgId: 'test-org-id',
    });

    // Verify .neon file was created
    expect(existsSync(testContextFile)).toBe(true);

    // Verify content
    const content = JSON.parse(readFileSync(testContextFile, 'utf-8'));
    expect(content).toEqual({
      projectId: 'test-project-id',
      branchId: 'test-branch-id',
      orgId: 'test-org-id',
    });
  });

  test('should create .neon file with prompted values', async () => {
    const { handler } = await import('./create_app.js');
    const prompts = (await import('prompts')).default;

    // Mock prompts to return test values
    vi.mocked(prompts).mockResolvedValueOnce({
      projectId: 'prompted-project-id',
      branchId: 'prompted-branch-id',
      orgId: 'prompted-org-id',
    });

    await handler({
      _: ['create-app'],
      $0: 'neonctl',
      contextFile: testContextFile,
    });

    // Verify .neon file was created
    expect(existsSync(testContextFile)).toBe(true);

    // Verify content
    const content = JSON.parse(readFileSync(testContextFile, 'utf-8'));
    expect(content).toEqual({
      projectId: 'prompted-project-id',
      branchId: 'prompted-branch-id',
      orgId: 'prompted-org-id',
    });
  });

  test('should skip .neon file generation in CI without flags', async () => {
    const { handler } = await import('./create_app.js');
    const { isCi } = await import('../env.js');

    // Mock CI environment
    vi.mocked(isCi).mockReturnValueOnce(true);

    await handler({
      _: ['create-app'],
      $0: 'neonctl',
      contextFile: testContextFile,
    });

    // Verify .neon file was NOT created
    expect(existsSync(testContextFile)).toBe(false);
  });

  test('should create .neon file in CI with all flags', async () => {
    const { handler } = await import('./create_app.js');
    const { isCi } = await import('../env.js');

    // Mock CI environment
    vi.mocked(isCi).mockReturnValueOnce(true);

    await handler({
      _: ['create-app'],
      $0: 'neonctl',
      contextFile: testContextFile,
      projectId: 'ci-project-id',
      branchId: 'ci-branch-id',
      orgId: 'ci-org-id',
    });

    // Verify .neon file was created
    expect(existsSync(testContextFile)).toBe(true);

    // Verify content
    const content = JSON.parse(readFileSync(testContextFile, 'utf-8'));
    expect(content).toEqual({
      projectId: 'ci-project-id',
      branchId: 'ci-branch-id',
      orgId: 'ci-org-id',
    });
  });
});
