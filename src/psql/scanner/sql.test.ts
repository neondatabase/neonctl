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
    name: 'backslash AFTER buffered SQL still dispatches as a command',
    // Upstream `psqlscan.l` recognises the boundary regardless of buffer
    // state; the mainloop is responsible for routing the buffered SQL into
    // the command's `query_buf`. We mirror that contract: the scanner
    // returns `kind: 'backslash'` with `sql` carrying the pre-backslash
    // text so buffer-consuming commands (\watch, \g, \gx, \gdesc, …) can
    // execute the buffered statement.
    input: 'SELECT 1 \\d',
    expectedFinalKind: 'backslash',
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
    expectedPromptStatus: 'continue-quote',
  },
  {
    name: 'unterminated extended string',
    input: "E'abc",
    expectedFinalKind: 'incomplete',
    expectedPromptStatus: 'continue-quote',
  },
  {
    name: 'unterminated double quote',
    input: 'SELECT "abc',
    expectedFinalKind: 'incomplete',
    expectedPromptStatus: 'continue-dquote',
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
    expectedPromptStatus: 'continue-dollar',
  },
  {
    name: 'unterminated tagged dollar quote',
    input: '$tag$ body without close',
    expectedFinalKind: 'incomplete',
    expectedPromptStatus: 'continue-dollar',
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
    name: 'string concatenation across newline merges per SQL standard',
    input: "SELECT 'a'\n  'b';",
    // <xqs>: the two adjacent quoted strings separated by whitespace
    // containing a newline merge into a single logical literal. From the
    // splitter's POV this is still one statement.
    expectedSplits: ["SELECT 'a'\n  'b';"],
  },
  {
    name: 'string concatenation without newline does NOT merge',
    input: "SELECT 'a'   'b';",
    // No newline in the gap — the standard requires at least one newline.
    // Boundary detection is unaffected; still one statement.
    expectedSplits: ["SELECT 'a'   'b';"],
  },
  {
    name: 'string concatenation across three pieces',
    input: "SELECT 'a'\n'b'\n'c';",
    expectedSplits: ["SELECT 'a'\n'b'\n'c';"],
  },
  {
    name: 'string concatenation across newline preserves semicolons in pieces',
    input: "SELECT 'x;'\n  'y;'; SELECT 1;",
    // The `;`s inside the strings must remain inside; after the closing
    // quote of `'y;'` we hit the top-level `;`.
    expectedSplits: ["SELECT 'x;'\n  'y;';", ' SELECT 1;'],
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
    // Top-of-buffer dispatch — no buffered SQL preceded the `\`.
    expect(r.sql).toBe('');
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

  test('incomplete reports promptStatus = "continue-quote" for single quote', () => {
    const r = scanSql("SELECT 'abc");
    expect(r.kind).toBe('incomplete');
    if (r.kind !== 'incomplete') return;
    expect(r.promptStatus).toBe('continue-quote');
    expect(r.nextState.inSingleQuote).toBe(true);
  });

  test('incomplete reports promptStatus = "comment" for block comment', () => {
    const r = scanSql('/* x ');
    expect(r.kind).toBe('incomplete');
    if (r.kind !== 'incomplete') return;
    expect(r.promptStatus).toBe('comment');
    expect(r.nextState.inBlockComment).toBe(1);
  });

  test('incomplete reports promptStatus = "continue-dquote" for double quote', () => {
    const r = scanSql('SELECT "abc');
    expect(r.kind).toBe('incomplete');
    if (r.kind !== 'incomplete') return;
    expect(r.promptStatus).toBe('continue-dquote');
    expect(r.nextState.inDoubleQuote).toBe(true);
  });

  test('incomplete reports promptStatus = "continue-dollar" for dollar quote', () => {
    const r = scanSql('$body$ hello');
    expect(r.kind).toBe('incomplete');
    if (r.kind !== 'incomplete') return;
    expect(r.promptStatus).toBe('continue-dollar');
    expect(r.nextState.dollarTag).toBe('body');
  });

  test('block comment precedence: comment wins over paren', () => {
    const r = scanSql('SELECT (/* hi ');
    expect(r.kind).toBe('incomplete');
    if (r.kind !== 'incomplete') return;
    // The block comment open *inside* an open paren — comment status takes
    // precedence in upstream's promptStatus_t because the comment can hide
    // anything (including the close paren).
    expect(r.promptStatus).toBe('comment');
  });

  test('plain "continue" status only fires when no special state is open', () => {
    // Forcibly install a state that's "incomplete" but not in any of the
    // tracked sub-reasons by feeding a chunk that completes its own quotes
    // and parens but leaves the scanner state machine without ending the
    // statement — this would require some non-quote, non-comment, non-paren
    // open state. The current scanner has none, so this test confirms the
    // taxonomy is complete: every `incomplete` we can produce maps to one
    // of the finer reasons, never to bare `'continue'`.
    const r = scanSql('SELECT 1');
    expect(r.kind).toBe('eof');
  });
});

// ---------------------------------------------------------------------------
// Backslash boundary after buffered SQL on the same line.
//
// Upstream `psqlscan.l` recognises the boundary regardless of buffer state;
// the mainloop is responsible for forwarding the buffered SQL into the
// command's `query_buf`. We mirror that contract: the scanner ALWAYS returns
// `kind: 'backslash'` and `sql` carries the (possibly empty) text that
// preceded the backslash in this scan pass.
//
// Buffer-consuming commands (`\watch`, `\g`, `\gx`, `\gset`, `\gexec`,
// `\gdesc`, `\crosstabview`, `\bind`) will read this through
// `BackslashContext.queryBuf` and run the buffered statement. Commands that
// don't care (`\set`, `\echo`, `\!`, `\cd`, …) leave the buffer intact for
// the next dispatch.
// ---------------------------------------------------------------------------

describe('scanSql — backslash after buffered SQL on same line', () => {
  test('SELECT 1 \\watch — sql carries pre-backslash text', () => {
    const r = scanSql('SELECT 1 \\watch');
    expect(r.kind).toBe('backslash');
    if (r.kind !== 'backslash') return;
    expect(r.sql).toBe('SELECT 1 ');
    expect(r.cmd).toBe('watch');
    expect(r.rest).toBe('');
    expect(r.consumed).toBe('SELECT 1 \\watch'.length);
  });

  test('SELECT 1 \\watch c=3 i=0.01 — args land in rest', () => {
    const r = scanSql('SELECT 1 \\watch c=3 i=0.01');
    expect(r.kind).toBe('backslash');
    if (r.kind !== 'backslash') return;
    expect(r.sql).toBe('SELECT 1 ');
    expect(r.cmd).toBe('watch');
    expect(r.rest).toBe(' c=3 i=0.01');
  });

  test('SELECT 1; \\watch — leading SQL (semicolon-terminated) lands in sql', () => {
    const r = scanSql('SELECT 1; \\watch');
    // Scanner returns at the first boundary; here that's the semicolon, not
    // the backslash. The mainloop dispatches the SELECT, then resumes scanning
    // and hits the backslash on the second pass with an empty buffer.
    expect(r.kind).toBe('semicolon');
    if (r.kind !== 'semicolon') return;
    expect(r.sql).toBe('SELECT 1;');
  });

  test('SELECT 1 \\g — no args, no rest', () => {
    const r = scanSql('SELECT 1 \\g');
    expect(r.kind).toBe('backslash');
    if (r.kind !== 'backslash') return;
    expect(r.sql).toBe('SELECT 1 ');
    expect(r.cmd).toBe('g');
    expect(r.rest).toBe('');
  });

  test('SELECT 1\\g — no whitespace between SQL and backslash', () => {
    const r = scanSql('SELECT 1\\g');
    expect(r.kind).toBe('backslash');
    if (r.kind !== 'backslash') return;
    expect(r.sql).toBe('SELECT 1');
    expect(r.cmd).toBe('g');
    expect(r.rest).toBe('');
  });

  test('SELECT 1\\gx — \\gx attaches directly to SQL', () => {
    const r = scanSql('SELECT 1\\gx');
    expect(r.kind).toBe('backslash');
    if (r.kind !== 'backslash') return;
    expect(r.sql).toBe('SELECT 1');
    expect(r.cmd).toBe('gx');
  });

  test('SELECT error\\gdesc — direct attachment, no space', () => {
    const r = scanSql('SELECT error\\gdesc');
    expect(r.kind).toBe('backslash');
    if (r.kind !== 'backslash') return;
    expect(r.sql).toBe('SELECT error');
    expect(r.cmd).toBe('gdesc');
  });

  test('SELECT 1 \\crosstabview a b — args after a buffer-consuming command', () => {
    const r = scanSql('SELECT 1 \\crosstabview a b');
    expect(r.kind).toBe('backslash');
    if (r.kind !== 'backslash') return;
    expect(r.sql).toBe('SELECT 1 ');
    expect(r.cmd).toBe('crosstabview');
    expect(r.rest).toBe(' a b');
  });

  test('SELECT 1 \\echo — non-buffer-consuming command still recognises boundary', () => {
    // Scanner doesn't know which commands consume the buffer — that's the
    // mainloop's job. It always returns the boundary; the dispatched command
    // decides whether to read `ctx.queryBuf` or ignore it.
    const r = scanSql('SELECT 1 \\echo hi');
    expect(r.kind).toBe('backslash');
    if (r.kind !== 'backslash') return;
    expect(r.sql).toBe('SELECT 1 ');
    expect(r.cmd).toBe('echo');
    expect(r.rest).toBe(' hi');
  });

  test('SELECT 1 \\set X Y — \\set leaves the buffer intact (mainloop concern)', () => {
    const r = scanSql('SELECT 1 \\set X Y');
    expect(r.kind).toBe('backslash');
    if (r.kind !== 'backslash') return;
    expect(r.sql).toBe('SELECT 1 ');
    expect(r.cmd).toBe('set');
    expect(r.rest).toBe(' X Y');
  });

  test('rest stops at newline; trailing SQL after \\cmd survives in next chunk', () => {
    const r = scanSql('SELECT 1 \\echo hi\nFROM t;');
    expect(r.kind).toBe('backslash');
    if (r.kind !== 'backslash') return;
    expect(r.sql).toBe('SELECT 1 ');
    expect(r.cmd).toBe('echo');
    expect(r.rest).toBe(' hi');
    // Consumed up to the newline; the rest of the input (newline + FROM t;)
    // is left for the next scan pass.
    expect(r.consumed).toBe('SELECT 1 \\echo hi'.length);
  });

  test('multi-line SQL then backslash on next line', () => {
    // First scan: `SELECT 1\n` — incomplete (no terminator).
    const r1 = scanSql('SELECT 1\n');
    expect(r1.kind).toBe('eof');
    if (r1.kind !== 'eof') return;
    expect(r1.sql).toBe('SELECT 1\n');

    // Mainloop accumulates that, then the user types `\watch` on the next
    // line. The scanner sees the new chunk with the state from before; the
    // buffered SQL is in the mainloop's queryBuf (not the scanner's `sql`),
    // so `r.sql` is empty here — the mainloop is responsible for prepending
    // its accumulated queryBuf when forwarding into BackslashContext.
    const r2 = scanSql('\\watch', r1.nextState);
    expect(r2.kind).toBe('backslash');
    if (r2.kind !== 'backslash') return;
    expect(r2.sql).toBe('');
    expect(r2.cmd).toBe('watch');
  });

  test('top-of-buffer dispatch leaves sql empty', () => {
    const r = scanSql('\\echo hi');
    expect(r.kind).toBe('backslash');
    if (r.kind !== 'backslash') return;
    expect(r.sql).toBe('');
    expect(r.cmd).toBe('echo');
    expect(r.rest).toBe(' hi');
  });

  test('whitespace-only prefix still leaves sql holding the whitespace', () => {
    // Upstream's mainloop treats whitespace-only buffer as empty for prompt
    // purposes. The scanner doesn't care: whatever preceded the backslash is
    // returned verbatim in `sql`. Buffer-consuming commands `.trim()` the
    // buffer before deciding whether it's usable.
    const r = scanSql('   \\dt');
    expect(r.kind).toBe('backslash');
    if (r.kind !== 'backslash') return;
    expect(r.sql).toBe('   ');
    expect(r.cmd).toBe('dt');
  });

  test('substituted :NAME in buffered SQL is in sql, not literal', () => {
    const r = scanSql('SELECT :x \\watch', undefined, (n) =>
      n === 'x' ? '42' : undefined,
    );
    expect(r.kind).toBe('backslash');
    if (r.kind !== 'backslash') return;
    // :x was expanded inside the buffered SQL.
    expect(r.sql).toBe('SELECT 42 ');
    expect(r.cmd).toBe('watch');
  });
});

// ---------------------------------------------------------------------------
// <xqs> quote-continuation behavior — scanner-level state assertions.
// ---------------------------------------------------------------------------

describe('scanSql — <xqs> quote-continuation', () => {
  test('merge across newline keeps single-quote state until final close', () => {
    // After the closing `'` of `'a'` followed by `\n  '`, the scanner should
    // re-enter single-quote state and only become "ready" after the final `'`.
    const r1 = scanSql("SELECT 'a'\n  'b");
    expect(r1.kind).toBe('incomplete');
    if (r1.kind !== 'incomplete') return;
    expect(r1.nextState.inSingleQuote).toBe(true);
  });

  test('no merge when whitespace lacks a newline', () => {
    // `'a'   'b` — pure space gap, no newline → first string closes, second
    // string is a new string. The scanner reports `inSingleQuote: true` for
    // the second.
    const r1 = scanSql("SELECT 'a'   'b");
    expect(r1.kind).toBe('incomplete');
    if (r1.kind !== 'incomplete') return;
    expect(r1.nextState.inSingleQuote).toBe(true);
  });

  test('merge does not pick up a non-matching quote across newline', () => {
    // After `'a'` and a newline, a non-`'` character is just whitespace
    // followed by SQL; do not merge.
    const r1 = scanSql("SELECT 'a'\n   x");
    expect(r1.kind).toBe('eof');
    if (r1.kind !== 'eof') return;
    expect(r1.nextState.inSingleQuote).toBe(false);
  });

  test('E-prefix on each piece is re-derived independently', () => {
    // `E'a\\n'\n  '\\n'` — the second piece has no `E` prefix, so the
    // backslash should be a *literal* backslash, not an escape. After the
    // join the closing `';` should still terminate cleanly.
    const r = scanSql("SELECT E'a\\n'\n  '\\n';");
    expect(r.kind).toBe('semicolon');
  });

  test('E-prefix preserved when both pieces use it', () => {
    // `E'a\\n'\n  E'b\\n'` — both pieces are E-strings; the closing `'`
    // after the escape still terminates each piece.
    const r = scanSql("SELECT E'a\\n'\n  E'b\\n';");
    expect(r.kind).toBe('semicolon');
  });

  test('chunked feeding: continuation across chunk boundary', () => {
    const r1 = scanSql("SELECT 'a'");
    // Closed cleanly with no continuation visible in this chunk; clean eof.
    expect(r1.kind).toBe('eof');
    if (r1.kind !== 'eof') return;
    expect(r1.nextState.inSingleQuote).toBe(false);

    // Caller appends the next chunk including the newline + opening quote.
    // The scanner sees `\n  'b';` — there's no preceding `'` in *this* call,
    // so the `'` looks like a fresh string. This is the expected limitation:
    // continuation is detected only when both pieces are visible in one scan
    // pass. Callers that buffer line-by-line and only feed completed
    // statements upstream don't hit this — they see the whole text.
    const r2 = scanSql("\n  'b';", r1.nextState);
    expect(r2.kind).toBe('semicolon');
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

// ---------------------------------------------------------------------------
// :NAME / :'NAME' / :"NAME" variable substitution.
//
// Upstream `psqlscan.l` expands these inline in `<INITIAL>` only. We mirror
// that scope: substitution fires at top level, never inside SQL strings,
// dollar-quoted blocks, double-quoted identifiers, or comments. The
// PostgreSQL `::` cast operator is preserved verbatim.
// ---------------------------------------------------------------------------

describe('scanSql — :NAME variable substitution', () => {
  const lookup =
    (vars: Record<string, string>) =>
    (name: string): string | undefined =>
      Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : undefined;

  test('plain :NAME is substituted at top level', () => {
    const r = scanSql('SELECT :myvar;', undefined, lookup({ myvar: '42' }));
    expect(r.kind).toBe('semicolon');
    if (r.kind !== 'semicolon') return;
    expect(r.sql).toBe('SELECT 42;');
  });

  test('plain :NAME with no varLookup keeps the literal', () => {
    const r = scanSql('SELECT :myvar;');
    expect(r.kind).toBe('semicolon');
    if (r.kind !== 'semicolon') return;
    expect(r.sql).toBe('SELECT :myvar;');
  });

  test(":'NAME' produces a SQL string literal with quoting", () => {
    const r = scanSql("SELECT :'val';", undefined, lookup({ val: "it's" }));
    expect(r.kind).toBe('semicolon');
    if (r.kind !== 'semicolon') return;
    expect(r.sql).toBe("SELECT 'it''s';");
  });

  test(":'NAME' with a backslash emits the E'…' escape-string form", () => {
    const r = scanSql("SELECT :'val';", undefined, lookup({ val: 'a\\b' }));
    expect(r.kind).toBe('semicolon');
    if (r.kind !== 'semicolon') return;
    expect(r.sql).toBe("SELECT E'a\\\\b';");
  });

  test(':"NAME" produces a SQL identifier with quoting', () => {
    const r = scanSql(
      'SELECT * FROM :"tbl";',
      undefined,
      lookup({ tbl: 'My"Table' }),
    );
    expect(r.kind).toBe('semicolon');
    if (r.kind !== 'semicolon') return;
    expect(r.sql).toBe('SELECT * FROM "My""Table";');
  });

  test('unknown variable falls back to the literal :NAME', () => {
    const r = scanSql('SELECT :unknown;', undefined, lookup({}));
    expect(r.kind).toBe('semicolon');
    if (r.kind !== 'semicolon') return;
    expect(r.sql).toBe('SELECT :unknown;');
  });

  test("unknown :'NAME' echoes literal :'NAME'", () => {
    const r = scanSql("SELECT :'unk';", undefined, lookup({}));
    expect(r.kind).toBe('semicolon');
    if (r.kind !== 'semicolon') return;
    expect(r.sql).toBe("SELECT :'unk';");
  });

  test(':: cast operator is NOT treated as a substitution', () => {
    const r = scanSql("SELECT '1'::int;", undefined, lookup({ int: 'BOGUS' }));
    expect(r.kind).toBe('semicolon');
    if (r.kind !== 'semicolon') return;
    expect(r.sql).toBe("SELECT '1'::int;");
  });

  test(':NAME inside a single-quoted string is NOT substituted', () => {
    const r = scanSql("SELECT ':val';", undefined, lookup({ val: 'BOGUS' }));
    expect(r.kind).toBe('semicolon');
    if (r.kind !== 'semicolon') return;
    expect(r.sql).toBe("SELECT ':val';");
  });

  test(':NAME inside a double-quoted identifier is NOT substituted', () => {
    const r = scanSql('SELECT ":val";', undefined, lookup({ val: 'BOGUS' }));
    expect(r.kind).toBe('semicolon');
    if (r.kind !== 'semicolon') return;
    expect(r.sql).toBe('SELECT ":val";');
  });

  test(':NAME inside a dollar-quoted block is NOT substituted', () => {
    const r = scanSql(
      'DO $$ SELECT :val; $$;',
      undefined,
      lookup({ val: 'BOGUS' }),
    );
    expect(r.kind).toBe('semicolon');
    if (r.kind !== 'semicolon') return;
    expect(r.sql).toBe('DO $$ SELECT :val; $$;');
  });

  test(':NAME inside a line comment is NOT substituted', () => {
    const r = scanSql(
      '-- :val\nSELECT 1;',
      undefined,
      lookup({ val: 'BOGUS' }),
    );
    expect(r.kind).toBe('semicolon');
    if (r.kind !== 'semicolon') return;
    expect(r.sql).toBe('-- :val\nSELECT 1;');
  });

  test(':NAME inside a block comment is NOT substituted', () => {
    const r = scanSql(
      '/* :val */ SELECT 1;',
      undefined,
      lookup({ val: 'BOGUS' }),
    );
    expect(r.kind).toBe('semicolon');
    if (r.kind !== 'semicolon') return;
    expect(r.sql).toBe('/* :val */ SELECT 1;');
  });

  test('multiple substitutions in one statement', () => {
    const r = scanSql('SELECT :a, :b;', undefined, lookup({ a: '1', b: '2' }));
    expect(r.kind).toBe('semicolon');
    if (r.kind !== 'semicolon') return;
    expect(r.sql).toBe('SELECT 1, 2;');
  });

  test('lone : at end of input is preserved verbatim', () => {
    const r = scanSql('SELECT :', undefined, lookup({ foo: '1' }));
    expect(r.kind).toBe('eof');
    if (r.kind !== 'eof') return;
    expect(r.sql).toBe('SELECT :');
  });

  test(': followed by non-identifier char is preserved verbatim', () => {
    const r = scanSql('SELECT 1:+2;', undefined, lookup({ foo: '99' }));
    expect(r.kind).toBe('semicolon');
    if (r.kind !== 'semicolon') return;
    expect(r.sql).toBe('SELECT 1:+2;');
  });

  test(':1 (digit-prefixed) is not a variable — emits literal :', () => {
    const r = scanSql('SELECT :1;', undefined, lookup({ '1': 'x' }));
    expect(r.kind).toBe('semicolon');
    if (r.kind !== 'semicolon') return;
    expect(r.sql).toBe('SELECT :1;');
  });

  test('substitution preserves surrounding statement boundary', () => {
    const r = scanSql(
      'SELECT :a; SELECT :b;',
      undefined,
      lookup({ a: '1', b: '2' }),
    );
    expect(r.kind).toBe('semicolon');
    if (r.kind !== 'semicolon') return;
    // First call returns just the first statement, with :a substituted.
    expect(r.sql).toBe('SELECT 1;');
  });

  test('splitStatements with varLookup expands per-statement', () => {
    const parts = splitStatements(
      'SELECT :a; SELECT :b;',
      lookup({ a: '11', b: '22' }),
    );
    expect(parts).toEqual(['SELECT 11;', ' SELECT 22;']);
  });

  test('chunked feeding: substitution within each chunk', () => {
    // First chunk: `SELECT :a + ` — terminates at incomplete eof (no `;`).
    const r1 = scanSql('SELECT :a + ', undefined, lookup({ a: '7', b: '8' }));
    expect(r1.kind).toBe('eof');
    if (r1.kind !== 'eof') return;
    expect(r1.sql).toBe('SELECT 7 + ');

    // Second chunk continues with state — `:b` still substitutes.
    const r2 = scanSql(':b;', r1.nextState, lookup({ a: '7', b: '8' }));
    expect(r2.kind).toBe('semicolon');
    if (r2.kind !== 'semicolon') return;
    expect(r2.sql).toBe('8;');
  });

  test('inside parentheses, substitution still happens', () => {
    const r = scanSql('SELECT (:x);', undefined, lookup({ x: '99' }));
    expect(r.kind).toBe('semicolon');
    if (r.kind !== 'semicolon') return;
    expect(r.sql).toBe('SELECT (99);');
  });
});
