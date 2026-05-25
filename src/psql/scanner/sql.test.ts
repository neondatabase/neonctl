/**
 * Differential test corpus for the SQL scanner.
 *
 * Each entry has either:
 *  - `expectedSplits`     : the list of statement strings that `splitStatements()` should
 *                           return for the input. Includes terminating `;` where present.
 *  - `expectedFinalKind`  : the `ScanResult.kind` after consuming the entire input in a
 *                           single `scanSql()` call (used for unterminated-state tests).
 *  - `expectedPromptStatus`: optional check on PROMPT2 status for `'incomplete'` cases.
 *
 * All cases also exercise the incremental API by character-by-character feeding.
 */
import { describe, expect, test } from 'vitest';

import type { PromptStatus, ScanState } from '../types/scanner.js';
import { initialScanState } from '../types/scanner.js';

import { scanSql, splitStatements } from './sql.js';

type CorpusCase = {
  name: string;
  input: string;
  expectedSplits?: string[];
  expectedFinalKind?: 'semicolon' | 'backslash' | 'incomplete' | 'eof';
  expectedPromptStatus?: PromptStatus;
};

const corpus: CorpusCase[] = [
  // --- Trivia ---
  { name: 'empty', input: '', expectedSplits: [], expectedFinalKind: 'eof' },
  {
    name: 'whitespace only',
    input: '   \t\n  ',
    expectedSplits: ['   \t\n  '],
    expectedFinalKind: 'eof',
  },
  {
    name: 'just a line comment',
    input: '-- hello\n',
    expectedSplits: ['-- hello\n'],
    expectedFinalKind: 'eof',
  },
  {
    name: 'just a block comment',
    input: '/* hi */',
    expectedSplits: ['/* hi */'],
    expectedFinalKind: 'eof',
  },

  // --- Simple statements ---
  {
    name: 'one bare statement',
    input: 'SELECT 1;',
    expectedSplits: ['SELECT 1;'],
  },
  {
    name: 'two bare statements',
    input: 'SELECT 1; SELECT 2;',
    expectedSplits: ['SELECT 1;', ' SELECT 2;'],
  },
  {
    name: 'three with mixed whitespace',
    input: 'A;\nB;\n\tC;',
    expectedSplits: ['A;', '\nB;', '\n\tC;'],
  },
  {
    name: 'no terminator final residue is kept',
    input: 'SELECT 1; SELECT 2',
    expectedSplits: ['SELECT 1;', ' SELECT 2'],
  },

  // --- String quoting ---
  {
    name: 'semicolon inside single-quoted string',
    input: "SELECT '; '; SELECT 1;",
    expectedSplits: ["SELECT '; ';", ' SELECT 1;'],
  },
  {
    name: 'doubled single-quote is literal',
    input: "SELECT 'it''s'; SELECT 2;",
    expectedSplits: ["SELECT 'it''s';", ' SELECT 2;'],
  },
  {
    name: 'semicolon inside double-quoted identifier',
    input: 'SELECT "a;b"; SELECT 2;',
    expectedSplits: ['SELECT "a;b";', ' SELECT 2;'],
  },
  {
    name: 'doubled double-quote is literal',
    input: 'SELECT "a""b"; SELECT 2;',
    expectedSplits: ['SELECT "a""b";', ' SELECT 2;'],
  },
  {
    name: 'extended string with \\n keeps boundary outside',
    input: "E'\\n'; SELECT 1;",
    expectedSplits: ["E'\\n';", ' SELECT 1;'],
  },
  {
    name: 'extended string with escaped quote does not close early',
    input: "E'it\\'s'; SELECT 2;",
    expectedSplits: ["E'it\\'s';", ' SELECT 2;'],
  },
  {
    name: 'bare \\ inside non-extended string is literal',
    input: "SELECT '\\'; SELECT 2;",
    expectedSplits: ["SELECT '\\';", ' SELECT 2;'],
  },
  {
    name: 'bit-string literal B prefix',
    input: "SELECT B'1010'; SELECT 1;",
    expectedSplits: ["SELECT B'1010';", ' SELECT 1;'],
  },
  {
    name: 'hex-string literal X prefix',
    input: "SELECT X'deadbeef'; SELECT 1;",
    expectedSplits: ["SELECT X'deadbeef';", ' SELECT 1;'],
  },
  {
    name: 'lowercase e extended string',
    input: "SELECT e'a\\nb'; SELECT 1;",
    expectedSplits: ["SELECT e'a\\nb';", ' SELECT 1;'],
  },
  {
    name: 'identifier ending in E followed by quote is not extended',
    input: "SELECT THREE'foo';",
    // The E here is part of an identifier; the quote starts a *standard* string.
    expectedSplits: ["SELECT THREE'foo';"],
  },

  // --- Comments ---
  {
    name: 'line comment with semicolon inside',
    input: '-- comment; not a boundary\nSELECT 1;',
    expectedSplits: ['-- comment; not a boundary\nSELECT 1;'],
  },
  {
    name: 'block comment with semicolon inside',
    input: '/* has ; inside */ SELECT 1;',
    expectedSplits: ['/* has ; inside */ SELECT 1;'],
  },
  {
    name: 'nested block comments',
    input: '/* outer /* inner */ still in */ SELECT 1;',
    expectedSplits: ['/* outer /* inner */ still in */ SELECT 1;'],
  },
  {
    name: 'deeply nested block comments',
    input: '/* a /* b /* c */ b */ a */ SELECT 1;',
    expectedSplits: ['/* a /* b /* c */ b */ a */ SELECT 1;'],
  },

  // --- Parens ---
  {
    name: 'semicolon inside parens is ignored',
    input: 'SELECT (1; 2);',
    expectedSplits: ['SELECT (1; 2);'],
  },
  {
    name: 'nested parens balanced',
    input: 'SELECT ((a; b); c); SELECT 2;',
    expectedSplits: ['SELECT ((a; b); c);', ' SELECT 2;'],
  },
  {
    name: 'extra close paren is benign',
    input: 'SELECT 1); SELECT 2;',
    expectedSplits: ['SELECT 1);', ' SELECT 2;'],
  },

  // --- Dollar quoting ---
  {
    name: 'dollar quote with empty tag',
    input: '$$ hello; world $$;',
    expectedSplits: ['$$ hello; world $$;'],
  },
  {
    name: 'dollar quote with named tag',
    input: '$tag$ hello; $other$ no; $tag$;',
    expectedSplits: ['$tag$ hello; $other$ no; $tag$;'],
  },
  {
    name: 'dollar quoted CREATE FUNCTION body',
    input:
      'CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $body$\nBEGIN\n  RETURN 1;\nEND;\n$body$;',
    expectedSplits: [
      'CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $body$\nBEGIN\n  RETURN 1;\nEND;\n$body$;',
    ],
  },
  {
    name: 'dollar quote with $ in tag is not allowed; lex stops at first $',
    input: '$a$b$c$;',
    // `$a$` opens; `b` content; `$c$` is a non-matching close → consume `$` and continue;
    // never closes — incomplete.
    expectedFinalKind: 'incomplete',
  },
  {
    name: 'lone $ then digit is param, not dollar-quote',
    input: 'SELECT $1; SELECT 2;',
    expectedSplits: ['SELECT $1;', ' SELECT 2;'],
  },

  // --- Multi-line ---
  {
    name: 'multi-line single statement',
    input: 'SELECT 1\nFROM tbl\nWHERE a = b;',
    expectedSplits: ['SELECT 1\nFROM tbl\nWHERE a = b;'],
  },
  {
    name: 'CRLF line endings tolerated',
    input: 'SELECT 1;\r\nSELECT 2;',
    expectedSplits: ['SELECT 1;', '\r\nSELECT 2;'],
  },

  // --- Backslash commands ---
  {
    name: 'backslash command standalone',
    input: '\\d',
    expectedSplits: ['\\d'],
  },
  {
    name: 'backslash command then SQL',
    input: '\\d table\nSELECT 1;',
    // First boundary is the backslash; then "\nSELECT 1;" is the next statement.
    expectedSplits: ['\\d table', '\nSELECT 1;'],
  },
  {
    name: 'backslash with whitespace before is still top-of-buffer',
    input: '   \\dt',
    expectedSplits: ['   \\dt'],
  },
  {
    name: 'backslash inside SQL is part of the SQL, not a command',
    input: 'SELECT 1 \\d',
    // No `;` — the `\d` is part of the buffered SQL (literal backslash + d).
    expectedFinalKind: 'eof',
  },
  {
    name: '\\; forces semicolon into buffer (no dispatch)',
    // The `\;` does NOT terminate; the whole line is one statement.
    // splitStatements returns the original input slice (so the backslash is
    // preserved in the round-trip); a separate test below verifies that the
    // *dispatched* SQL (from scanSql().sql) has the backslash dropped, which
    // matches upstream's `\;` semantics of forcing a literal semicolon into
    // the query buffer.
    input: 'SELECT 1 \\; SELECT 2;',
    expectedSplits: ['SELECT 1 \\; SELECT 2;'],
  },
  {
    name: '\\? help command',
    input: '\\?',
    expectedSplits: ['\\?'],
  },
  {
    name: 'backslash command with underscore (\\lo_import)',
    input: '\\lo_import /path/to/file',
    expectedSplits: ['\\lo_import /path/to/file'],
  },
  {
    name: 'backslash command with underscore (\\bind_named)',
    input: '\\bind_named foo 1 2',
    expectedSplits: ['\\bind_named foo 1 2'],
  },
  {
    name: 'backslash command with + modifier (\\dt+)',
    input: '\\dt+',
    expectedSplits: ['\\dt+'],
  },
  {
    name: '\\d+ verbose form',
    input: '\\d+ public.users',
    expectedSplits: ['\\d+ public.users'],
  },

  // --- Unterminated / incomplete states ---
  {
    name: 'unterminated single quote',
    input: "SELECT 'abc",
    expectedFinalKind: 'incomplete',
    expectedPromptStatus: 'continue',
  },
  {
    name: 'unterminated extended string',
    input: "E'abc",
    expectedFinalKind: 'incomplete',
    expectedPromptStatus: 'continue',
  },
  {
    name: 'unterminated double quote',
    input: 'SELECT "abc',
    expectedFinalKind: 'incomplete',
    expectedPromptStatus: 'continue',
  },
  {
    name: 'unterminated paren list',
    input: 'SELECT (1, 2,',
    expectedFinalKind: 'incomplete',
    expectedPromptStatus: 'paren',
  },
  {
    name: 'unterminated dollar quote',
    input: '$$ hello',
    expectedFinalKind: 'incomplete',
    expectedPromptStatus: 'continue',
  },
  {
    name: 'unterminated tagged dollar quote',
    input: '$tag$ body without close',
    expectedFinalKind: 'incomplete',
    expectedPromptStatus: 'continue',
  },
  {
    name: 'unterminated block comment',
    input: '/* hello',
    expectedFinalKind: 'incomplete',
    expectedPromptStatus: 'comment',
  },
  {
    name: 'unterminated nested block comment',
    input: '/* outer /* inner */',
    expectedFinalKind: 'incomplete',
    expectedPromptStatus: 'comment',
  },
  {
    name: 'no terminator but clean buffer (eof, not incomplete)',
    input: 'SELECT 1',
    expectedFinalKind: 'eof',
  },

  // --- Misc tricky shapes ---
  {
    name: 'semicolons in nested $$ inside parens still ignored',
    input: '(SELECT $$ x; y $$); SELECT 1;',
    expectedSplits: ['(SELECT $$ x; y $$);', ' SELECT 1;'],
  },
  {
    name: 'string concatenation across lines is not folded but boundaries OK',
    input: "SELECT 'a'\n  'b';",
    // We treat these as two distinct strings (no quotecontinue lookahead). The
    // intervening whitespace contains no `;`, so this still resolves to one
    // statement boundary.
    expectedSplits: ["SELECT 'a'\n  'b';"],
  },
  {
    name: 'double-dash inside string',
    input: "SELECT '-- not a comment'; SELECT 1;",
    expectedSplits: ["SELECT '-- not a comment';", ' SELECT 1;'],
  },
  {
    name: 'slash-star inside string',
    input: "SELECT '/* not a comment */'; SELECT 1;",
    expectedSplits: ["SELECT '/* not a comment */';", ' SELECT 1;'],
  },
  {
    name: 'extended string with hex escape',
    input: "E'\\x41B'; SELECT 1;",
    expectedSplits: ["E'\\x41B';", ' SELECT 1;'],
  },
  {
    name: 'extended string with unicode escape',
    input: "E'\\u00e9'; SELECT 1;",
    expectedSplits: ["E'\\u00e9';", ' SELECT 1;'],
  },
  {
    name: 'extended string with octal escape',
    input: "E'\\101'; SELECT 1;",
    expectedSplits: ["E'\\101';", ' SELECT 1;'],
  },
  {
    name: 'block comment immediately closes',
    input: '/**/ SELECT 1;',
    expectedSplits: ['/**/ SELECT 1;'],
  },
  {
    name: 'two consecutive empty statements',
    input: ';;',
    expectedSplits: [';', ';'],
  },
];

describe('scanSql / splitStatements — corpus', () => {
  // Sanity guard: caller MUST provide at least 40 distinct cases.
  test('corpus has >= 40 entries', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(40);
  });

  for (const c of corpus) {
    test(c.name, () => {
      if (c.expectedSplits !== undefined) {
        expect(splitStatements(c.input)).toEqual(c.expectedSplits);
      }
      if (c.expectedFinalKind !== undefined) {
        // Drive the scanner to its terminal result and check the kind.
        const result = scanSql(c.input);
        expect(result.kind).toBe(c.expectedFinalKind);
        if (
          c.expectedPromptStatus !== undefined &&
          result.kind === 'incomplete'
        ) {
          expect(result.promptStatus).toBe(c.expectedPromptStatus);
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Incremental API — feeding input chunk-by-chunk and threading state.
// ---------------------------------------------------------------------------

describe('scanSql — incremental feeding', () => {
  test('backslash command names include underscore (cmd field)', () => {
    const r = scanSql('\\lo_import file.bin');
    expect(r.kind).toBe('backslash');
    if (r.kind === 'backslash') {
      expect(r.cmd).toBe('lo_import');
      expect(r.rest).toBe(' file.bin');
    }
  });

  test('backslash command names include trailing + modifier', () => {
    const r = scanSql('\\dt+');
    expect(r.kind).toBe('backslash');
    if (r.kind === 'backslash') {
      expect(r.cmd).toBe('dt+');
    }
  });

  test('character-by-character feed reaches same boundaries', () => {
    const input = "SELECT 'a;b'; SELECT 2;";
    const splits: string[] = [];
    let buf = '';
    let state: ScanState = initialScanState();
    for (const ch of input) {
      buf += ch;
      // Try to advance: if scanSql returns 'semicolon' or 'backslash', take the
      // boundary, drop the consumed prefix, and continue with the residue.
      // Otherwise leave the buffer to accumulate.
      const r = scanSql(buf, state);
      if (r.kind === 'semicolon' || r.kind === 'backslash') {
        splits.push(buf.slice(0, r.consumed));
        buf = buf.slice(r.consumed);
        state = r.nextState;
      }
      // 'incomplete' / 'eof' → keep going.
    }
    if (buf.length > 0) splits.push(buf);
    expect(splits).toEqual(["SELECT 'a;b';", ' SELECT 2;']);
  });

  test('state survives chunk boundary mid-string', () => {
    // First chunk opens a single-quoted string; second chunk closes it.
    const r1 = scanSql("SELECT 'abc");
    expect(r1.kind).toBe('incomplete');
    if (r1.kind !== 'incomplete') return;
    expect(r1.nextState.inSingleQuote).toBe(true);

    const r2 = scanSql("def'; SELECT 1;", r1.nextState);
    expect(r2.kind).toBe('semicolon');
    if (r2.kind !== 'semicolon') return;
    expect(r2.sql).toBe("def';");
    expect(r2.nextState.inSingleQuote).toBe(false);
  });

  test('state survives chunk boundary mid-block-comment', () => {
    const r1 = scanSql('/* hello ');
    expect(r1.kind).toBe('incomplete');
    if (r1.kind !== 'incomplete') return;
    expect(r1.nextState.inBlockComment).toBe(1);
    expect(r1.promptStatus).toBe('comment');

    const r2 = scanSql('world */ SELECT 1;', r1.nextState);
    expect(r2.kind).toBe('semicolon');
  });

  test('state survives chunk boundary mid-dollar-quote', () => {
    const r1 = scanSql('$tag$ first half ');
    expect(r1.kind).toBe('incomplete');
    if (r1.kind !== 'incomplete') return;
    expect(r1.nextState.dollarTag).toBe('tag');

    const r2 = scanSql('second half $tag$;', r1.nextState);
    expect(r2.kind).toBe('semicolon');
    if (r2.kind !== 'semicolon') return;
    expect(r2.sql).toBe('second half $tag$;');
  });

  test('state survives chunk boundary mid-paren', () => {
    const r1 = scanSql('SELECT (1,');
    expect(r1.kind).toBe('incomplete');
    if (r1.kind !== 'incomplete') return;
    expect(r1.nextState.parenDepth).toBe(1);
    expect(r1.promptStatus).toBe('paren');

    const r2 = scanSql(' 2); SELECT 3;', r1.nextState);
    expect(r2.kind).toBe('semicolon');
  });

  test('state survives chunk boundary mid-nested-block-comment', () => {
    const r1 = scanSql('/* outer /* ');
    expect(r1.kind).toBe('incomplete');
    if (r1.kind !== 'incomplete') return;
    expect(r1.nextState.inBlockComment).toBe(2);

    const r2 = scanSql('inner */ outer */ SELECT 1;', r1.nextState);
    expect(r2.kind).toBe('semicolon');
  });
});

// ---------------------------------------------------------------------------
// Direct scanSql() result-shape tests.
// ---------------------------------------------------------------------------

describe('scanSql — result shapes', () => {
  test('backslash returns cmd and rest separately', () => {
    const r = scanSql('\\d+ public.users\nSELECT 1;');
    expect(r.kind).toBe('backslash');
    if (r.kind !== 'backslash') return;
    expect(r.cmd).toBe('d+');
    expect(r.rest).toBe(' public.users');
  });

  test('semicolon hands back exactly the consumed prefix', () => {
    const r = scanSql('SELECT 1; SELECT 2;');
    expect(r.kind).toBe('semicolon');
    if (r.kind !== 'semicolon') return;
    expect(r.sql).toBe('SELECT 1;');
  });

  test('\\; drops the backslash in the dispatched SQL', () => {
    // splitStatements() returns the verbatim input slice (for round-tripping),
    // but the `sql` field of the underlying scanSql() result reflects the
    // *dispatched* form — backslash dropped, `;` retained.
    const r = scanSql('SELECT 1 \\; SELECT 2;');
    expect(r.kind).toBe('semicolon');
    if (r.kind !== 'semicolon') return;
    expect(r.sql).toBe('SELECT 1 ; SELECT 2;');
    expect(r.consumed).toBe('SELECT 1 \\; SELECT 2;'.length);
  });

  test('eof returns full residue with reset state', () => {
    const r = scanSql('SELECT 1 + 2');
    expect(r.kind).toBe('eof');
    if (r.kind !== 'eof') return;
    expect(r.sql).toBe('SELECT 1 + 2');
    expect(r.nextState.parenDepth).toBe(0);
    expect(r.nextState.inSingleQuote).toBe(false);
  });

  test('incomplete reports promptStatus = "continue" for single quote', () => {
    const r = scanSql("SELECT 'abc");
    expect(r.kind).toBe('incomplete');
    if (r.kind !== 'incomplete') return;
    expect(r.promptStatus).toBe('continue');
    expect(r.nextState.inSingleQuote).toBe(true);
  });

  test('incomplete reports promptStatus = "comment" for block comment', () => {
    const r = scanSql('/* x ');
    expect(r.kind).toBe('incomplete');
    if (r.kind !== 'incomplete') return;
    expect(r.promptStatus).toBe('comment');
    expect(r.nextState.inBlockComment).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// splitStatements integration on a script-shaped input.
// ---------------------------------------------------------------------------

describe('splitStatements — script-shaped inputs', () => {
  test('a small psql script', () => {
    const script = [
      '-- header comment',
      'SET search_path TO public;',
      '\\timing on',
      '',
      'CREATE TABLE t (id int);',
      'INSERT INTO t VALUES (1), (2), (3);',
      '',
      'SELECT * FROM t WHERE id < 3;',
    ].join('\n');
    const parts = splitStatements(script);
    expect(parts.length).toBe(5);
    expect(parts[0]).toContain('SET search_path');
    expect(parts[1]).toContain('\\timing on');
    expect(parts[2]).toContain('CREATE TABLE');
    expect(parts[3]).toContain('INSERT INTO');
    expect(parts[4]).toContain('SELECT * FROM t');
  });

  test('round-tripping concatenated parts reproduces the original input', () => {
    const inputs = [
      'SELECT 1; SELECT 2; SELECT 3;',
      "SELECT '; '; SELECT 1;",
      '$$ hello; world $$;',
      '/* outer /* inner */ still */ SELECT 1;',
      "SELECT (1; 2); SELECT 'x';",
    ];
    for (const input of inputs) {
      const parts = splitStatements(input);
      expect(parts.join('')).toBe(input);
    }
  });
});
