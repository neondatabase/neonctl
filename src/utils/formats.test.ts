import { test, describe, expect } from 'vitest';

import { looksLikeBranchId, looksLikeLSN, looksLikeTimestamp } from './formats';

describe('branch formats', () => {
  test('branch name', () => {
    expect(looksLikeBranchId('master')).toBe(false);
  });

  test('initial short', () => {
    expect(looksLikeBranchId('br-flower-sunshine-123456')).toBe(true);
  });

  test('update 1, longer version', () => {
    expect(looksLikeBranchId('br-flower-sunshine-12345678')).toBe(true);
  });

  test('update 2, includes region', () => {
    expect(looksLikeBranchId('br-bold-recipe-a13oexw7')).toBe(true);
  });
});

describe('timestamp formats', () => {
  test('valid', () => {
    expect(looksLikeTimestamp('2021-03-13T19:47:33.000Z')).toBe(true);
  });

  test('invalid', () => {
    expect(looksLikeTimestamp('branch_name')).toBe(false);
  });
});

describe('LSN formats', () => {
  test('valid', () => {
    expect(looksLikeLSN('0/1F56000')).toBe(true);
  });

  test('invalid', () => {
    expect(looksLikeLSN('branch_name')).toBe(false);
  });
});
