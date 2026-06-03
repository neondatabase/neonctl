import { describe, expect, it } from 'vitest';

import { applyPattern, processSQLNamePattern } from './processNamePattern.js';

describe('processSQLNamePattern', () => {
  it('returns no conditions for null pattern, no visibility', () => {
    const r = processSQLNamePattern({
      pattern: null,
      namevar: 'c.relname',
    });
    expect(r.schemaConditions).toEqual([]);
    expect(r.nameConditions).toEqual([]);
    expect(r.visibilityConditions).toEqual([]);
    expect(r.params).toEqual([]);
  });

  it('returns visibility condition for null pattern + visibility', () => {
    const r = processSQLNamePattern({
      pattern: null,
      namevar: 'c.relname',
      visibilityrule: 'pg_catalog.pg_table_is_visible(c.oid)',
    });
    expect(r.visibilityConditions).toEqual([
      'pg_catalog.pg_table_is_visible(c.oid)',
    ]);
    expect(r.schemaConditions).toEqual([]);
    expect(r.nameConditions).toEqual([]);
  });

  it('builds simple name regex from bare identifier', () => {
    const r = processSQLNamePattern({
      pattern: 'foo',
      namevar: 'c.relname',
    });
    expect(r.nameConditions).toEqual(['c.relname OPERATOR(pg_catalog.~) $1']);
    expect(r.params).toEqual(['^(foo)$']);
  });

  it('lowercases unquoted name characters', () => {
    const r = processSQLNamePattern({
      pattern: 'FoO',
      namevar: 'c.relname',
    });
    expect(r.params).toEqual(['^(foo)$']);
  });

  it('preserves case inside double quotes', () => {
    const r = processSQLNamePattern({
      pattern: '"FoO"',
      namevar: 'c.relname',
    });
    expect(r.params).toEqual(['^(FoO)$']);
  });

  it('translates * to .*', () => {
    const r = processSQLNamePattern({
      pattern: 'foo*',
      namevar: 'c.relname',
    });
    expect(r.params).toEqual(['^(foo.*)$']);
  });

  it('translates ? to .', () => {
    const r = processSQLNamePattern({
      pattern: 'foo?',
      namevar: 'c.relname',
    });
    expect(r.params).toEqual(['^(foo.)$']);
  });

  it('optimizes away bare * pattern (matches everything)', () => {
    const r = processSQLNamePattern({
      pattern: '*',
      namevar: 'c.relname',
    });
    // Pattern is ^(.*)$ which is the upstream optimization marker.
    expect(r.nameConditions).toEqual([]);
    expect(r.params).toEqual([]);
  });

  it('splits schema.name pattern when schemavar provided', () => {
    const r = processSQLNamePattern({
      pattern: 'public.users',
      namevar: 'c.relname',
      schemavar: 'n.nspname',
    });
    expect(r.nameConditions).toEqual(['c.relname OPERATOR(pg_catalog.~) $1']);
    expect(r.schemaConditions).toEqual(['n.nspname OPERATOR(pg_catalog.~) $2']);
    expect(r.params).toEqual(['^(users)$', '^(public)$']);
  });

  it('handles schema-only pattern (trailing dot or empty name)', () => {
    // "public." → schema=public, name="" → name regex = ^()$. Upstream
    // emits it but our test verifies whatever the contract is.
    const r = processSQLNamePattern({
      pattern: 'public.',
      namevar: 'c.relname',
      schemavar: 'n.nspname',
    });
    expect(r.params[0]).toBe('^()$');
    expect(r.params[1]).toBe('^(public)$');
  });

  it('schema-qualified with wildcards', () => {
    const r = processSQLNamePattern({
      pattern: 'pg_catalog.pg_*',
      namevar: 'c.relname',
      schemavar: 'n.nspname',
    });
    expect(r.params).toEqual(['^(pg_.*)$', '^(pg_catalog)$']);
  });

  it('quoted schema preserves case', () => {
    const r = processSQLNamePattern({
      pattern: '"PG".foo',
      namevar: 'c.relname',
      schemavar: 'n.nspname',
    });
    expect(r.params).toEqual(['^(foo)$', '^(PG)$']);
  });

  it('quoted name with regex specials gets them escaped', () => {
    const r = processSQLNamePattern({
      pattern: '"a.b+c"',
      namevar: 'c.relname',
    });
    expect(r.params).toEqual(['^(a\\.b\\+c)$']);
  });

  it('always escapes $ even outside quotes', () => {
    const r = processSQLNamePattern({
      pattern: 'a$b',
      namevar: 'c.relname',
    });
    expect(r.params).toEqual(['^(a\\$b)$']);
  });

  it('special-cases [] as literal brackets', () => {
    const r = processSQLNamePattern({
      pattern: 'int[]',
      namevar: 't.typname',
    });
    expect(r.params).toEqual(['^(int\\[])$']);
  });

  it('forceLower escapes regex metacharacters outside quotes', () => {
    const r = processSQLNamePattern({
      pattern: 'a.b',
      forceLower: true,
      namevar: 'c.relname',
    });
    // With forceLower, the `.` is now a regex special — but it's still
    // a component separator. So the pattern splits into [a, b] when
    // schemavar is set, or `^(a.b)$` (with `.` as regex meta) when not.
    expect(r.params).toEqual(['^(a.b)$']);
  });

  it('three-part pattern with dbnamevar', () => {
    const r = processSQLNamePattern({
      pattern: 'mydb.public.users',
      namevar: 'c.relname',
      schemavar: 'n.nspname',
      dbnamevar: 'd.datname',
    });
    expect(r.nameConditions).toEqual(['c.relname OPERATOR(pg_catalog.~) $1']);
    // Note: schemaConditions holds both schema and db conditions.
    expect(r.schemaConditions).toEqual([
      'n.nspname OPERATOR(pg_catalog.~) $2',
      'd.datname OPERATOR(pg_catalog.~) $3',
    ]);
    expect(r.params).toEqual(['^(users)$', '^(public)$', '^(mydb)$']);
  });

  it('altnamevar produces OR condition', () => {
    const r = processSQLNamePattern({
      pattern: 'foo',
      namevar: 'p.proname',
      altnamevar: 'pg_catalog.pg_get_function_arguments(p.oid)',
    });
    expect(r.nameConditions).toEqual([
      '(p.proname OPERATOR(pg_catalog.~) $1 OR pg_catalog.pg_get_function_arguments(p.oid) OPERATOR(pg_catalog.~) $1)',
    ]);
    expect(r.params).toEqual(['^(foo)$']);
  });

  it('emits visibility when name pattern lacks a schema part', () => {
    const r = processSQLNamePattern({
      pattern: 'foo',
      namevar: 'c.relname',
      schemavar: 'n.nspname',
      visibilityrule: 'pg_catalog.pg_table_is_visible(c.oid)',
    });
    expect(r.schemaConditions).toEqual([]);
    expect(r.visibilityConditions).toEqual([
      'pg_catalog.pg_table_is_visible(c.oid)',
    ]);
  });

  it('does NOT emit visibility when schema part supplied', () => {
    const r = processSQLNamePattern({
      pattern: 'public.foo',
      namevar: 'c.relname',
      schemavar: 'n.nspname',
      visibilityrule: 'pg_catalog.pg_table_is_visible(c.oid)',
    });
    expect(r.visibilityConditions).toEqual([]);
    expect(r.schemaConditions).toEqual(['n.nspname OPERATOR(pg_catalog.~) $2']);
  });

  it('escapes a literal double-quote inside a quoted run', () => {
    const r = processSQLNamePattern({
      pattern: '"weird""name"',
      namevar: 'c.relname',
    });
    expect(r.params).toEqual(['^(weird"name)$']);
  });

  it('handles mixed quoted/unquoted in one component', () => {
    const r = processSQLNamePattern({
      pattern: 'pg_"X"',
      namevar: 'c.relname',
    });
    // unquoted pg_ stays as `pg_`, quoted X stays as `X`.
    expect(r.params).toEqual(['^(pg_X)$']);
  });

  it('treats excess dots literally when no buffer available', () => {
    // Without schemavar there's only 1 buffer; extra `.` chars become
    // regex `.` (any char).
    const r = processSQLNamePattern({
      pattern: 'a.b.c',
      namevar: 'c.relname',
    });
    expect(r.params).toEqual(['^(a.b.c)$']);
  });

  it('three-part `db.schema.name` splits into 3 components even without a db column (review #23)', () => {
    // With a schema column, up to 3 dotted parts are honoured: name=`users`,
    // schema=`public`, and the leading `mydb` is the cross-db LITERAL (no
    // $param, since no dbnamevar) — surfaced via dbLiteral for the dispatcher
    // to validate against the current DB. The old code capped at 2 and
    // mis-mapped this as schema=`mydb`, name=`public.users`.
    const r = processSQLNamePattern({
      pattern: 'mydb.public.users',
      namevar: 'c.relname',
      schemavar: 'n.nspname',
    });
    expect(r.params).toEqual(['^(users)$', '^(public)$']);
    expect(r.dotCount).toBe(2);
    expect(r.dbLiteral).toBe('mydb');
  });

  it('empty pattern (single empty string) yields ^()$ which is NOT the all-match optimization', () => {
    const r = processSQLNamePattern({
      pattern: '',
      namevar: 'c.relname',
    });
    expect(r.params).toEqual(['^()$']);
  });

  it('pattern that is exactly the * optimization passes through unconstrained', () => {
    const r = processSQLNamePattern({
      pattern: '*',
      namevar: 'c.relname',
      schemavar: 'n.nspname',
      visibilityrule: 'pg_catalog.pg_table_is_visible(c.oid)',
    });
    // `*` with schemavar set: schemaRegex is undefined (only one component), so visibility kicks in.
    expect(r.nameConditions).toEqual([]);
    expect(r.visibilityConditions).toEqual([
      'pg_catalog.pg_table_is_visible(c.oid)',
    ]);
  });

  it('schema with all-match name optimizes name away, keeps schema', () => {
    const r = processSQLNamePattern({
      pattern: 'public.*',
      namevar: 'c.relname',
      schemavar: 'n.nspname',
    });
    expect(r.nameConditions).toEqual([]);
    expect(r.schemaConditions).toEqual(['n.nspname OPERATOR(pg_catalog.~) $1']);
    expect(r.params).toEqual(['^(public)$']);
  });

  it('name with all-match schema optimizes schema away', () => {
    const r = processSQLNamePattern({
      pattern: '*.foo',
      namevar: 'c.relname',
      schemavar: 'n.nspname',
    });
    expect(r.nameConditions).toEqual(['c.relname OPERATOR(pg_catalog.~) $1']);
    expect(r.schemaConditions).toEqual([]);
    expect(r.params).toEqual(['^(foo)$']);
  });
});

describe('applyPattern', () => {
  const placeholder = 'true /* TODO(WP-20): pattern matching */';

  it('returns sql unchanged if no placeholder present', () => {
    const r = applyPattern('SELECT 1;', {
      schemaConditions: [],
      nameConditions: [],
      visibilityConditions: [],
      params: [],
      dotCount: 0,
      dbLiteral: null,
    });
    expect(r.sql).toBe('SELECT 1;');
    expect(r.params).toEqual([]);
  });

  it('returns sql unchanged if placeholder present but no conditions', () => {
    const sql = `WHERE ${placeholder}`;
    const r = applyPattern(sql, {
      schemaConditions: [],
      nameConditions: [],
      visibilityConditions: [],
      params: [],
      dotCount: 0,
      dbLiteral: null,
    });
    expect(r.sql).toBe(sql);
  });

  it('substitutes single occurrence with conditions', () => {
    const sql = `SELECT * FROM t WHERE ${placeholder} ORDER BY 1;`;
    const r = applyPattern(sql, {
      schemaConditions: [],
      nameConditions: ['c.relname OPERATOR(pg_catalog.~) $1'],
      visibilityConditions: [],
      params: ['^(foo)$'],
      dotCount: 0,
      dbLiteral: null,
    });
    expect(r.sql).toBe(
      'SELECT * FROM t WHERE (c.relname OPERATOR(pg_catalog.~) $1) ORDER BY 1;',
    );
    expect(r.params).toEqual(['^(foo)$']);
  });

  it('renumbers parameters across multiple placeholders', () => {
    const sql = `WHERE ${placeholder} OR ${placeholder}`;
    const r = applyPattern(sql, {
      schemaConditions: [],
      nameConditions: ['c.relname OPERATOR(pg_catalog.~) $1'],
      visibilityConditions: [],
      params: ['^(foo)$'],
      dotCount: 0,
      dbLiteral: null,
    });
    expect(r.sql).toBe(
      'WHERE (c.relname OPERATOR(pg_catalog.~) $1) OR (c.relname OPERATOR(pg_catalog.~) $2)',
    );
    expect(r.params).toEqual(['^(foo)$', '^(foo)$']);
  });

  it('respects baseParams when renumbering', () => {
    const sql = `WHERE ${placeholder}`;
    const r = applyPattern(
      sql,
      {
        schemaConditions: [],
        nameConditions: ['c.relname OPERATOR(pg_catalog.~) $1'],
        visibilityConditions: [],
        params: ['^(foo)$'],
        dotCount: 0,
        dbLiteral: null,
      },
      ['extra'],
    );
    expect(r.sql).toBe('WHERE (c.relname OPERATOR(pg_catalog.~) $2)');
    expect(r.params).toEqual(['extra', '^(foo)$']);
  });
});
