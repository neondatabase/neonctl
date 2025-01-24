import { describe, it, expect } from 'vitest';
import { parseManagedServiceSql } from './sql_parser.js';

describe('parseManagedServiceSql', () => {
  const validSql = `CREATE MANAGED SERVICE mydb TYPE=POSTGRES_NEON SPECIFICATION=$$ spec:
  maxVCpu: 8
  postgresVersion: 17
  autoSuspend: True
  historyRetentionSeconds: 0
  setupSQL = setupSQL.sql
$$`;

  it('parses valid SQL statement correctly', () => {
    const result = parseManagedServiceSql(validSql);
    expect(result).toEqual({
      name: 'mydb',
      type: 'POSTGRES_NEON',
      maxVCpu: 8,
      postgresVersion: 17,
      autoSuspend: true,
      historyRetentionSeconds: 0,
      setupSQL: 'setupSQL.sql',
    });
  });

  it('throws error for invalid type', () => {
    const invalidType = validSql.replace('POSTGRES_NEON', 'INVALID_TYPE');
    expect(() => parseManagedServiceSql(invalidType)).toThrow(
      'Only POSTGRES_NEON type is supported',
    );
  });

  it('throws error for missing required fields', () => {
    const missingFields = `CREATE MANAGED SERVICE mydb TYPE=POSTGRES_NEON SPECIFICATION=$$ spec:
  autoSuspend: True
  historyRetentionSeconds: 0
$$`;
    expect(() => parseManagedServiceSql(missingFields)).toThrow(
      'Missing required fields',
    );
  });

  it('throws error for invalid SQL format', () => {
    const invalidSql = 'INVALID SQL STATEMENT';
    expect(() => parseManagedServiceSql(invalidSql)).toThrow(
      'Invalid SQL format',
    );
  });

  it('handles specification without spec: prefix', () => {
    const noSpecPrefix = `CREATE MANAGED SERVICE mydb TYPE=POSTGRES_NEON SPECIFICATION=$$
  maxVCpu: 8
  postgresVersion: 17
  autoSuspend: True
  historyRetentionSeconds: 0
$$`;
    const result = parseManagedServiceSql(noSpecPrefix);
    expect(result.maxVCpu).toBe(8);
    expect(result.postgresVersion).toBe(17);
  });

  it('validates postgres version', () => {
    const invalidVersion = validSql.replace('17', '13');
    expect(() => parseManagedServiceSql(invalidVersion)).toThrow(
      'postgresVersion must be one of: 14, 15, 16, 17',
    );
  });
});
