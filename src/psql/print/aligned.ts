import type { ResultSet } from '../types/connection.js';
import type {
  BorderStyle,
  PrintQueryOpts,
  PrintTableOpts,
  Printer,
  Unicode2LineStyle,
} from '../types/printer.js';

import { formatNumericLocale } from './units.js';

/**
 * Aligned tabular printer (psql's default output mode).
 *
 * Mirrors print.c `print_aligned_text` / `print_aligned_vertical`.
 *
 * Supports horizontal (default), expanded/vertical (`\x on`), and
 * wrapped (`\pset format wrapped`) layouts. Borders 0..3 (0 = none,
 * 1 = light internal rules, 2 = full box, 3 = heavy with row rules).
 * Unicode mode (`unicodeBorderLineStyle === 'unicode'`) swaps the
 * ASCII rule glyphs for U+2500-range box-drawing characters.
 */

// ---------------------------------------------------------------------------
// Public helpers: display-width primitives reused by other formats.
// ---------------------------------------------------------------------------

// East-Asian wide / fullwidth ranges from Unicode Standard Annex #11.
// Trimmed to the ranges psql's `ucs_wcwidth` considers width 2.
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2329, 0x232a], // Angle brackets
  [0x2e80, 0x303e], // CJK Radicals, Kangxi, ...
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, etc.
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi Syllables
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe10, 0xfe19], // Vertical forms
  [0xfe30, 0xfe6f], // CJK Compatibility Forms, Small Form Variants
  [0xff00, 0xff60], // Fullwidth Forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f300, 0x1f64f], // Misc Symbols & Pictographs, Emoticons
  [0x1f900, 0x1f9ff], // Supplemental Symbols & Pictographs
  [0x20000, 0x2fffd], // CJK Extension B..F
  [0x30000, 0x3fffd], // CJK Extension G
];

// Combining marks: width 0. From Unicode general categories Mn/Me/Cf
// and the zero-width controls upstream treats as width 0.
const ZERO_RANGES: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f], // Combining Diacritical Marks
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x05bf, 0x05bf],
  [0x05c1, 0x05c2],
  [0x05c4, 0x05c5],
  [0x05c7, 0x05c7],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x06df, 0x06e4],
  [0x06e7, 0x06e8],
  [0x06ea, 0x06ed],
  [0x0711, 0x0711],
  [0x0730, 0x074a],
  [0x07a6, 0x07b0],
  [0x07eb, 0x07f3],
  [0x0816, 0x0819],
  [0x081b, 0x0823],
  [0x0825, 0x0827],
  [0x0829, 0x082d],
  [0x0859, 0x085b],
  [0x08d3, 0x08e1],
  [0x08e3, 0x0902],
  [0x093a, 0x093a],
  [0x093c, 0x093c],
  [0x0941, 0x0948],
  [0x094d, 0x094d],
  [0x0951, 0x0957],
  [0x0962, 0x0963],
  [0x0981, 0x0981],
  [0x09bc, 0x09bc],
  [0x09c1, 0x09c4],
  [0x09cd, 0x09cd],
  [0x09e2, 0x09e3],
  [0x09fe, 0x09fe],
  [0x0a01, 0x0a02],
  [0x0a3c, 0x0a3c],
  [0x0a41, 0x0a42],
  [0x0a47, 0x0a48],
  [0x0a4b, 0x0a4d],
  [0x0a51, 0x0a51],
  [0x0a70, 0x0a71],
  [0x0a75, 0x0a75],
  [0x0a81, 0x0a82],
  [0x0abc, 0x0abc],
  [0x0ac1, 0x0ac5],
  [0x0ac7, 0x0ac8],
  [0x0acd, 0x0acd],
  [0x0ae2, 0x0ae3],
  [0x0afa, 0x0aff],
  [0x0b01, 0x0b01],
  [0x0b3c, 0x0b3c],
  [0x0b3f, 0x0b3f],
  [0x0b41, 0x0b44],
  [0x0b4d, 0x0b4d],
  [0x0b55, 0x0b56],
  [0x0b62, 0x0b63],
  [0x0b82, 0x0b82],
  [0x0bc0, 0x0bc0],
  [0x0bcd, 0x0bcd],
  [0x0c00, 0x0c00],
  [0x0c04, 0x0c04],
  [0x0c3e, 0x0c40],
  [0x0c46, 0x0c48],
  [0x0c4a, 0x0c4d],
  [0x0c55, 0x0c56],
  [0x0c62, 0x0c63],
  [0x0c81, 0x0c81],
  [0x0cbc, 0x0cbc],
  [0x0cbf, 0x0cbf],
  [0x0cc6, 0x0cc6],
  [0x0ccc, 0x0ccd],
  [0x0ce2, 0x0ce3],
  [0x0d00, 0x0d01],
  [0x0d3b, 0x0d3c],
  [0x0d41, 0x0d44],
  [0x0d4d, 0x0d4d],
  [0x0d62, 0x0d63],
  [0x0dca, 0x0dca],
  [0x0dd2, 0x0dd4],
  [0x0dd6, 0x0dd6],
  [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e],
  [0x0eb1, 0x0eb1],
  [0x0eb4, 0x0ebc],
  [0x0ec8, 0x0ecd],
  [0x0f18, 0x0f19],
  [0x0f35, 0x0f35],
  [0x0f37, 0x0f37],
  [0x0f39, 0x0f39],
  [0x0f71, 0x0f7e],
  [0x0f80, 0x0f84],
  [0x0f86, 0x0f87],
  [0x0f8d, 0x0f97],
  [0x0f99, 0x0fbc],
  [0x0fc6, 0x0fc6],
  [0x1037, 0x1037],
  [0x1039, 0x103a],
  [0x108d, 0x108d],
  [0x135d, 0x135f],
  [0x1712, 0x1714],
  [0x1732, 0x1734],
  [0x1752, 0x1753],
  [0x1772, 0x1773],
  [0x17b4, 0x17b5],
  [0x17b7, 0x17bd],
  [0x17c6, 0x17c6],
  [0x17c9, 0x17d3],
  [0x17dd, 0x17dd],
  [0x180b, 0x180d],
  [0x1885, 0x1886],
  [0x18a9, 0x18a9],
  [0x1920, 0x1922],
  [0x1927, 0x1928],
  [0x1932, 0x1932],
  [0x1939, 0x193b],
  [0x1a17, 0x1a18],
  [0x1a1b, 0x1a1b],
  [0x1a56, 0x1a56],
  [0x1a58, 0x1a5e],
  [0x1a60, 0x1a60],
  [0x1a62, 0x1a62],
  [0x1a65, 0x1a6c],
  [0x1a73, 0x1a7c],
  [0x1a7f, 0x1a7f],
  [0x1ab0, 0x1abd],
  [0x1b00, 0x1b03],
  [0x1b34, 0x1b34],
  [0x1b36, 0x1b3a],
  [0x1b3c, 0x1b3c],
  [0x1b42, 0x1b42],
  [0x1b6b, 0x1b73],
  [0x1b80, 0x1b81],
  [0x1ba2, 0x1ba5],
  [0x1ba8, 0x1ba9],
  [0x1bab, 0x1bad],
  [0x1be6, 0x1be6],
  [0x1be8, 0x1be9],
  [0x1bed, 0x1bed],
  [0x1bef, 0x1bf1],
  [0x1c2c, 0x1c33],
  [0x1c36, 0x1c37],
  [0x1cd0, 0x1cd2],
  [0x1cd4, 0x1ce0],
  [0x1ce2, 0x1ce8],
  [0x1ced, 0x1ced],
  [0x1cf4, 0x1cf4],
  [0x1cf8, 0x1cf9],
  [0x1dc0, 0x1df9],
  [0x1dfb, 0x1dff],
  [0x200b, 0x200f], // zero-width space, ZWNJ, ZWJ, LRM, RLM
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x20d0, 0x20f0],
  [0x2cef, 0x2cf1],
  [0x2d7f, 0x2d7f],
  [0x2de0, 0x2dff],
  [0x302a, 0x302d],
  [0x3099, 0x309a],
  [0xa66f, 0xa672],
  [0xa674, 0xa67d],
  [0xa69e, 0xa69f],
  [0xa6f0, 0xa6f1],
  [0xa802, 0xa802],
  [0xa806, 0xa806],
  [0xa80b, 0xa80b],
  [0xa825, 0xa826],
  [0xa8c4, 0xa8c5],
  [0xa8e0, 0xa8f1],
  [0xa926, 0xa92d],
  [0xa947, 0xa951],
  [0xa980, 0xa982],
  [0xa9b3, 0xa9b3],
  [0xa9b6, 0xa9b9],
  [0xa9bc, 0xa9bd],
  [0xa9e5, 0xa9e5],
  [0xaa29, 0xaa2e],
  [0xaa31, 0xaa32],
  [0xaa35, 0xaa36],
  [0xaa43, 0xaa43],
  [0xaa4c, 0xaa4c],
  [0xaa7c, 0xaa7c],
  [0xaab0, 0xaab0],
  [0xaab2, 0xaab4],
  [0xaab7, 0xaab8],
  [0xaabe, 0xaabf],
  [0xaac1, 0xaac1],
  [0xaaec, 0xaaed],
  [0xaaf6, 0xaaf6],
  [0xabe5, 0xabe5],
  [0xabe8, 0xabe8],
  [0xabed, 0xabed],
  [0xfb1e, 0xfb1e],
  [0xfe00, 0xfe0f], // variation selectors
  [0xfe20, 0xfe2f], // combining half-marks
  [0xfeff, 0xfeff], // BOM
  [0xfff9, 0xfffb],
  [0x101fd, 0x101fd],
  [0x102e0, 0x102e0],
  [0x10376, 0x1037a],
  [0x10a01, 0x10a03],
  [0x10a05, 0x10a06],
  [0x10a0c, 0x10a0f],
  [0x10a38, 0x10a3a],
  [0x10a3f, 0x10a3f],
  [0x10ae5, 0x10ae6],
  [0xe0100, 0xe01ef],
];

const inRange = (
  cp: number,
  ranges: readonly (readonly [number, number])[],
): boolean => {
  // Binary search; ranges are sorted by start.
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const entry = ranges[mid];
    if (cp < entry[0]) hi = mid - 1;
    else if (cp > entry[1]) lo = mid + 1;
    else return true;
  }
  return false;
};

/**
 * Visible terminal width of one Unicode code point.
 *
 * - C0/DEL control codes -> 0 (we don't try to render them; psql's
 *   `pg_wcwidth` returns -1 here, but treating them as 0 matches the
 *   way the value already passes through the rendering pipeline).
 * - Zero-width combining marks / format chars -> 0.
 * - East-Asian Wide / Fullwidth -> 2.
 * - Everything else -> 1.
 */
const codePointWidth = (cp: number): number => {
  if (cp === 0) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (inRange(cp, ZERO_RANGES)) return 0;
  if (inRange(cp, WIDE_RANGES)) return 2;
  return 1;
};

/**
 * Compute the visible terminal width of a string. Iterates code points
 * (not UTF-16 code units), so surrogate pairs count once. Newlines and
 * tabs are passed through; callers should split by '\n' first when they
 * need per-line width — matches `pg_wcssize`.
 */
export const displayWidth = (text: string): number => {
  let width = 0;
  for (const ch of text) {
    width += codePointWidth(ch.codePointAt(0) ?? 0);
  }
  return width;
};

/**
 * Pad `text` so its visible width is exactly `width`. Truncates the
 * pre-existing string if it already exceeds `width` (caller is
 * responsible for fitting; we do not truncate by default).
 *
 * For `center`, an odd remainder biases right (matches psql, which
 * uses `nbspace / 2` for the left pad and `(nbspace + 1) / 2` for the
 * right).
 */
export const padToWidth = (
  text: string,
  width: number,
  alignment: 'left' | 'right' | 'center',
): string => {
  const w = displayWidth(text);
  if (w >= width) return text;
  const pad = width - w;
  if (alignment === 'left') return text + ' '.repeat(pad);
  if (alignment === 'right') return ' '.repeat(pad) + text;
  const leftPad = pad >> 1;
  const rightPad = pad - leftPad;
  return ' '.repeat(leftPad) + text + ' '.repeat(rightPad);
};

// ---------------------------------------------------------------------------
// Type heuristics & cell formatting (shared with vertical mode).
// ---------------------------------------------------------------------------

// PG type OIDs that should render right-aligned. From upstream
// `column_type_alignment` / `print_aligned_text`'s `align[]` build.
const RIGHT_ALIGNED_OIDS = new Set<number>([
  20, // int8
  21, // int2
  23, // int4
  700, // float4
  701, // float8
  1700, // numeric
  1186, // interval
  790, // money
  26, // oid
]);

const isRightAlignedField = (oid: number): boolean =>
  RIGHT_ALIGNED_OIDS.has(oid);

const renderCell = (
  cell: unknown,
  nullPrint: string,
  numericLocale: boolean,
): string => {
  if (cell === null || cell === undefined) return nullPrint;
  if (typeof cell === 'string') {
    return formatNumericLocale(cell, numericLocale);
  }
  if (typeof cell === 'number' || typeof cell === 'bigint') {
    return formatNumericLocale(cell.toString(), numericLocale);
  }
  if (typeof cell === 'boolean') return cell ? 't' : 'f';
  if (cell instanceof Date) return cell.toISOString();
  if (cell instanceof Uint8Array) {
    let hex = '\\x';
    for (const b of cell) hex += b.toString(16).padStart(2, '0');
    return hex;
  }
  return JSON.stringify(cell);
};

// ---------------------------------------------------------------------------
// Border / line-format glyphs.
// ---------------------------------------------------------------------------

type Glyphs = {
  hrule: string; // horizontal rule character
  vrule: string; // column separator inside the table
  // Corner/junction characters for rule rows.
  topLeft: string;
  topMid: string;
  topRight: string;
  midLeft: string;
  midMid: string;
  midRight: string;
  botLeft: string;
  botMid: string;
  botRight: string;
  // wrap markers in the gutter when border != 0.
  wrapLeft: string;
  wrapRight: string;
  nlLeft: string;
  nlRight: string;
};

const ASCII_GLYPHS: Glyphs = {
  hrule: '-',
  vrule: '|',
  topLeft: '+',
  topMid: '+',
  topRight: '+',
  midLeft: '+',
  midMid: '+',
  midRight: '+',
  botLeft: '+',
  botMid: '+',
  botRight: '+',
  wrapLeft: ' ',
  wrapRight: ' ',
  nlLeft: ' ',
  nlRight: ' ',
};

const UNICODE_GLYPHS: Glyphs = {
  hrule: '─',
  vrule: '│',
  topLeft: '┌',
  topMid: '┬',
  topRight: '┐',
  midLeft: '├',
  midMid: '┼',
  midRight: '┤',
  botLeft: '└',
  botMid: '┴',
  botRight: '┘',
  wrapLeft: ' ',
  wrapRight: ' ',
  nlLeft: ' ',
  nlRight: ' ',
};

const glyphsFor = (style: Unicode2LineStyle): Glyphs =>
  style === 'unicode' ? UNICODE_GLYPHS : ASCII_GLYPHS;

// ---------------------------------------------------------------------------
// Column width computation.
// ---------------------------------------------------------------------------

/**
 * Compute the per-column max-width array used by horizontal layout.
 * Considers header width and every line of every cell value. Returns
 * widths in display-character units.
 *
 * Cells are pre-rendered with `nullPrint` and `numericLocale` already
 * applied so width measurements match what the printer will emit.
 */
export const computeColumnWidths = (
  rs: ResultSet,
  topt: PrintTableOpts,
): number[] => {
  const nullPrint = topt.nullPrint;
  const numericLocale = topt.numericLocale;
  const widths = rs.fields.map((f) => displayWidth(f.name));
  for (const row of rs.rows) {
    for (let i = 0; i < rs.fields.length; i++) {
      const cellText = renderCell(row[i], nullPrint, numericLocale);
      for (const line of cellText.split('\n')) {
        const w = displayWidth(line);
        if (w > widths[i]) widths[i] = w;
      }
    }
  }
  return widths;
};

// ---------------------------------------------------------------------------
// Horizontal rendering.
// ---------------------------------------------------------------------------

type Alignment = 'left' | 'right' | 'center';

type FormattedCell = {
  lines: string[]; // already split, each line is a single display line
  width: number; // max display width across lines
};

const formatCell = (text: string): FormattedCell => {
  const lines = text.split('\n');
  let width = 0;
  for (const l of lines) {
    const w = displayWidth(l);
    if (w > width) width = w;
  }
  return { lines, width };
};

/**
 * Build a horizontal rule line (top, middle, bottom). Layout matches
 * psql:
 *
 *  border 0:  `aa bb` -> `-- --` (no corners, single-space gaps)
 *  border 1:  `-aa-+-bb-` (no outer corners, '+' between columns)
 *  border 2:  `+-aa-+-bb-+` (full box)
 *  border 3:  same as 2 here; row rules between data rows added elsewhere.
 *
 * The hrule covers `width + 2` characters per column when border >= 1
 * (the content padding spaces become hrule chars on rule lines).
 */
const buildRule = (
  widths: number[],
  border: BorderStyle,
  glyphs: Glyphs,
  position: 'top' | 'middle' | 'bottom',
): string => {
  const { hrule } = glyphs;
  let left: string;
  let mid: string;
  let right: string;
  if (position === 'top') {
    left = glyphs.topLeft;
    mid = glyphs.topMid;
    right = glyphs.topRight;
  } else if (position === 'middle') {
    left = glyphs.midLeft;
    mid = glyphs.midMid;
    right = glyphs.midRight;
  } else {
    left = glyphs.botLeft;
    mid = glyphs.botMid;
    right = glyphs.botRight;
  }

  let out = '';
  if (border === 2 || border === 3) {
    out += left;
  }

  for (let i = 0; i < widths.length; i++) {
    // Per column the rule covers content width plus the two side pads
    // that the data lines have for border >= 1.
    const pad = border === 0 ? 0 : 1;
    out += hrule.repeat(widths[i] + pad * 2);
    if (i < widths.length - 1) {
      if (border === 0) {
        out += ' '; // single space between columns in border 0
      } else {
        out += mid;
      }
    }
  }

  if (border === 2 || border === 3) {
    out += right;
  }
  return out;
};

const renderHorizontal = (
  rs: ResultSet,
  opts: PrintQueryOpts,
  wrapped: boolean,
): string => {
  const topt = opts.topt;
  const border = topt.border;
  const tuplesOnly = topt.tuplesOnly;
  const nullPrint = opts.nullPrint !== '' ? opts.nullPrint : topt.nullPrint;
  const glyphs = glyphsFor(topt.unicodeBorderLineStyle);

  const headers = rs.fields.map((f) => f.name);
  const aligns: Alignment[] = rs.fields.map((f) =>
    isRightAlignedField(f.dataTypeID) ? 'right' : 'left',
  );

  // Pre-render & measure every cell.
  const cellGrid: FormattedCell[][] = rs.rows.map((row) =>
    row.map((cell) =>
      formatCell(renderCell(cell, nullPrint, topt.numericLocale)),
    ),
  );
  const headerCells = headers.map((h) => formatCell(h));

  const colCount = rs.fields.length;
  const widths: number[] = headerCells.map((c) => c.width);
  for (const row of cellGrid) {
    for (let i = 0; i < colCount; i++) {
      if (row[i].width > widths[i]) widths[i] = row[i].width;
    }
  }

  // Wrapped mode shrinks the widest column(s) until total width fits
  // `topt.columns`. Each shrunk column gets multi-line cell rendering
  // via greedy character break.
  if (wrapped) {
    const maxColumns = topt.columns > 0 ? topt.columns : topt.envColumns;
    if (maxColumns > 0) {
      const sepCost = border === 0 ? 1 : 3;
      const sideCost = border === 2 || border === 3 ? 4 : 0;
      let total = sideCost + widths.reduce((a, b) => a + b, 0);
      total += sepCost * Math.max(0, colCount - 1);
      while (total > maxColumns) {
        // Find worst column: largest width that is still > header width.
        let worstCol = -1;
        let worstWidth = -1;
        for (let i = 0; i < colCount; i++) {
          const headerW = headerCells[i].width;
          if (widths[i] > headerW && widths[i] > worstWidth) {
            worstWidth = widths[i];
            worstCol = i;
          }
        }
        if (worstCol === -1) break;
        widths[worstCol]--;
        total--;
      }
    }
  }

  let out = '';
  const newline = '\n';

  if (!tuplesOnly && opts.title) {
    out += opts.title + newline;
  }

  // Top rule: emitted when border == 2 or 3.
  if (!tuplesOnly && (border === 2 || border === 3)) {
    out += buildRule(widths, border, glyphs, 'top') + newline;
  }

  // ------- Header row(s) -------
  if (!tuplesOnly) {
    // Header may be multiline; print each header line as its own row.
    const headerLineCount = Math.max(
      1,
      ...headerCells.map((c) => c.lines.length),
    );
    for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
      out += renderDataLine(
        headerCells.map((c) => c.lines[lineIdx] ?? ''),
        widths,
        aligns.map(() => 'center' as Alignment),
        border,
        glyphs,
        /* leftGutter */ ' ',
      );
      out += newline;
    }
    // Header rule.
    if (border >= 1) {
      out += buildRule(widths, border, glyphs, 'middle') + newline;
    } else {
      // border 0: psql emits a row of '-'s with single-space gaps as
      // the header underline.
      out += buildRule(widths, border, glyphs, 'middle') + newline;
    }
  }

  // ------- Data rows -------
  for (let r = 0; r < cellGrid.length; r++) {
    const row = cellGrid[r];
    // For wrapped mode, each cell may need to be re-broken to fit
    // the (possibly shrunk) column width.
    const colLines: string[][] = row.map((cell, i) => {
      const lines = cell.lines;
      if (!wrapped) return lines;
      // Each source line may itself need breaking down to fit.
      const out: string[] = [];
      for (const line of lines) {
        out.push(...wrapLine(line, widths[i]));
      }
      return out;
    });
    const lineCount = Math.max(1, ...colLines.map((l) => l.length));
    for (let li = 0; li < lineCount; li++) {
      const lineCells = colLines.map((l) => l[li] ?? '');
      const gutters = colLines.map((l) =>
        li > 0 && li < l.length ? '.' : ' ',
      );
      // In wrapped mode the leftmost gutter for continuation lines is
      // a '.', for non-continuation it's a space.
      const leftGutter = gutters[0] ?? ' ';
      out += renderDataLine(
        lineCells,
        widths,
        aligns,
        border,
        glyphs,
        leftGutter,
      );
      out += newline;
    }
    // Heavy borders (border == 3) insert a rule between rows.
    if (border === 3 && r < cellGrid.length - 1) {
      out += buildRule(widths, border, glyphs, 'middle') + newline;
    }
  }

  // Bottom rule when border 2/3.
  if (!tuplesOnly && (border === 2 || border === 3)) {
    out += buildRule(widths, border, glyphs, 'bottom') + newline;
  }

  // Footer: (N rows)
  if (!tuplesOnly && topt.defaultFooter) {
    const n = rs.rows.length;
    out += `(${String(n)} ${n === 1 ? 'row' : 'rows'})` + newline;
  }

  if (!tuplesOnly && opts.footers) {
    for (const f of opts.footers) out += f + newline;
  }

  return out;
};

/**
 * Render one display-line of a horizontal row.
 *
 * Layout per psql:
 *   border 0:  `<cell1> <cell2> <cell3>`  (no padding spaces, no rules)
 *   border 1:  ` <cell1> | <cell2> | <cell3>` (no outer rules, but each cell
 *              has a 1-char gutter on both sides — the leading gutter on
 *              the first cell can be `.` to mark a continuation line).
 *   border 2:  `| <cell1> | <cell2> | <cell3> |` (full box).
 *
 * `leftGutter` is the single-character marker before the first cell
 * content (a space normally, '.' for wrapped-continuation lines).
 */
const renderDataLine = (
  cells: string[],
  widths: number[],
  aligns: Alignment[],
  border: BorderStyle,
  glyphs: Glyphs,
  leftGutter: string,
): string => {
  const { vrule } = glyphs;
  let out = '';

  if (border === 2 || border === 3) {
    out += vrule + leftGutter;
  } else if (border === 1) {
    out += leftGutter;
  }
  // border == 0: nothing on the left.

  for (let i = 0; i < cells.length; i++) {
    out += padToWidth(cells[i], widths[i], aligns[i]);
    if (i < cells.length - 1) {
      if (border === 0) {
        out += ' ';
      } else {
        out += ' ' + vrule + ' ';
      }
    }
  }

  if (border === 2 || border === 3) {
    out += ' ' + vrule;
  } else if (border === 1) {
    // Trailing gutter after the last cell.
    out += ' ';
  }

  return out;
};

/**
 * Break a single line of text into chunks of at most `width` visible
 * columns. Greedy, code-point-aware. Used by wrapped mode and by
 * vertical mode for value wrapping.
 */
const wrapLine = (line: string, width: number): string[] => {
  if (width <= 0) return [line];
  if (displayWidth(line) <= width) return [line];

  const chunks: string[] = [];
  let buf = '';
  let bufW = 0;
  for (const ch of line) {
    const cw = codePointWidth(ch.codePointAt(0) ?? 0);
    if (bufW + cw > width && buf.length > 0) {
      chunks.push(buf);
      buf = '';
      bufW = 0;
    }
    buf += ch;
    bufW += cw;
  }
  if (buf.length > 0) chunks.push(buf);
  return chunks;
};

// ---------------------------------------------------------------------------
// Vertical / expanded rendering.
// ---------------------------------------------------------------------------

const renderVertical = (rs: ResultSet, opts: PrintQueryOpts): string => {
  const topt = opts.topt;
  const border = topt.border;
  const tuplesOnly = topt.tuplesOnly;
  const nullPrint = opts.nullPrint !== '' ? opts.nullPrint : topt.nullPrint;
  const glyphs = glyphsFor(topt.unicodeBorderLineStyle);

  const headers = rs.fields.map((f) => f.name);
  const aligns: Alignment[] = rs.fields.map((f) =>
    isRightAlignedField(f.dataTypeID) ? 'right' : 'left',
  );

  // Width of the name column = max header width.
  let nameWidth = 0;
  for (const h of headers) {
    const w = displayWidth(h);
    if (w > nameWidth) nameWidth = w;
  }

  // Width of the value column = max value width across all rows.
  let valueWidth = 0;
  const cellGrid: string[][] = rs.rows.map((row) =>
    row.map((cell) => renderCell(cell, nullPrint, topt.numericLocale)),
  );
  for (const row of cellGrid) {
    for (const v of row) {
      for (const line of v.split('\n')) {
        const w = displayWidth(line);
        if (w > valueWidth) valueWidth = w;
      }
    }
  }

  let out = '';
  const newline = '\n';

  if (!tuplesOnly && opts.title) {
    out += opts.title + newline;
  }

  if (rs.rows.length === 0) {
    if (!tuplesOnly) out += '(No rows)' + newline;
    if (!tuplesOnly && opts.footers) {
      for (const f of opts.footers) out += f + newline;
    }
    return out;
  }

  for (let r = 0; r < cellGrid.length; r++) {
    if (!tuplesOnly) {
      out += renderRecordHeader(r + 1, nameWidth, valueWidth, border, glyphs);
      out += newline;
    }
    for (let c = 0; c < headers.length; c++) {
      const lines = cellGrid[r][c].split('\n');
      for (let li = 0; li < lines.length; li++) {
        const name = li === 0 ? headers[c] : '';
        out += renderVerticalLine(
          name,
          lines[li],
          nameWidth,
          valueWidth,
          aligns[c],
          border,
          glyphs,
        );
        out += newline;
      }
    }
  }

  if (!tuplesOnly && (border === 2 || border === 3)) {
    out +=
      glyphs.botLeft +
      glyphs.hrule.repeat(nameWidth + 2) +
      glyphs.botMid +
      glyphs.hrule.repeat(valueWidth + 2) +
      glyphs.botRight +
      newline;
  }

  if (!tuplesOnly && topt.defaultFooter) {
    const n = rs.rows.length;
    out += `(${String(n)} ${n === 1 ? 'row' : 'rows'})` + newline;
  }
  if (!tuplesOnly && opts.footers) {
    for (const f of opts.footers) out += f + newline;
  }
  return out;
};

/**
 * Render the `[ RECORD N ]` block header for vertical mode.
 *
 *  border 0:  `* Record N`
 *  border 1:  `-[ RECORD N ]<dashes-to-fit>+<dashes-to-fit>`
 *  border 2:  `+-[ RECORD N ]<dashes>+<dashes>+`
 *
 * The left segment is sized to `nameWidth + 2` characters (matching the
 * data lines' `<space><name><space>` columns), the right segment to
 * `valueWidth + 2`. Mirrors psql `print_aligned_vertical_line`.
 */
const renderRecordHeader = (
  record: number,
  nameWidth: number,
  valueWidth: number,
  border: BorderStyle,
  glyphs: Glyphs,
): string => {
  const { hrule, vrule } = glyphs;
  if (border === 0) {
    return `* Record ${String(record)}`;
  }

  const label = `[ RECORD ${String(record)} ]`;
  const leftSegLen = nameWidth + 2;
  const rightSegLen = valueWidth + 2;

  // border 1: `-[ RECORD N ]---+---------`
  if (border === 1) {
    // The dash-prefix-then-label-then-dashes pattern: a single hrule,
    // then the label, then enough hrule chars to reach leftSegLen.
    let left = hrule + label;
    if (left.length < leftSegLen) {
      left += hrule.repeat(leftSegLen - left.length);
    }
    const right = hrule.repeat(rightSegLen);
    return left + glyphs.midMid + right;
  }

  // border 2/3: `+-[ RECORD N ]---+--------+`
  let left = vrule + hrule + label;
  if (left.length < leftSegLen + 1) {
    left += hrule.repeat(leftSegLen + 1 - left.length);
  }
  const right = hrule.repeat(rightSegLen) + vrule;
  return left + glyphs.midMid + right;
};

const renderVerticalLine = (
  name: string,
  value: string,
  nameWidth: number,
  valueWidth: number,
  align: Alignment,
  border: BorderStyle,
  glyphs: Glyphs,
): string => {
  const { vrule } = glyphs;
  const namePadded = padToWidth(name, nameWidth, 'left');
  const valuePadded = padToWidth(value, valueWidth, align);
  if (border === 0) {
    return `${namePadded} ${valuePadded}`;
  }
  if (border === 1) {
    return ` ${namePadded} ${vrule} ${valuePadded}`;
  }
  return `${vrule} ${namePadded} ${vrule} ${valuePadded} ${vrule}`;
};

// ---------------------------------------------------------------------------
// Mode selection.
// ---------------------------------------------------------------------------

const horizontalTotalWidth = (rs: ResultSet, topt: PrintTableOpts): number => {
  const widths = computeColumnWidths(rs, topt);
  const border = topt.border;
  const sepCost = border === 0 ? 1 : 3;
  const sideCost = border === 2 || border === 3 ? 4 : 0;
  let total = sideCost + widths.reduce((a, b) => a + b, 0);
  total += sepCost * Math.max(0, widths.length - 1);
  return total;
};

const chooseExpanded = (rs: ResultSet, topt: PrintTableOpts): boolean => {
  if (topt.expanded === 'on') return true;
  if (topt.expanded === 'auto') {
    const maxColumns = topt.columns > 0 ? topt.columns : topt.envColumns;
    if (maxColumns <= 0) return false;
    return horizontalTotalWidth(rs, topt) > maxColumns;
  }
  return false;
};

// ---------------------------------------------------------------------------
// Public printer.
// ---------------------------------------------------------------------------

export const alignedPrinter: Printer = {
  format: 'aligned',
  printQuery(
    rs: ResultSet,
    opts: PrintQueryOpts,
    out: NodeJS.WritableStream,
  ): Promise<void> {
    const expanded = chooseExpanded(rs, opts.topt);
    const wrapped = opts.topt.format === 'wrapped';

    let text: string;
    if (expanded) {
      text = renderVertical(rs, opts);
    } else if (rs.rows.length === 0) {
      // Empty result: header + (0 rows) only, regardless of border.
      text = renderEmpty(rs, opts);
    } else {
      text = renderHorizontal(rs, opts, wrapped);
    }

    out.write(text);
    return Promise.resolve();
  },
};

const renderEmpty = (rs: ResultSet, opts: PrintQueryOpts): string => {
  // For an empty horizontal result, psql still prints the header row
  // and rule, then the (0 rows) footer.
  const topt = opts.topt;
  const tuplesOnly = topt.tuplesOnly;
  const border = topt.border;
  const glyphs = glyphsFor(topt.unicodeBorderLineStyle);

  const headerCells = rs.fields.map((f) => formatCell(f.name));
  const widths = headerCells.map((c) => c.width);
  const aligns = rs.fields.map(() => 'center' as Alignment);

  let out = '';
  if (!tuplesOnly && opts.title) out += opts.title + '\n';
  if (!tuplesOnly && (border === 2 || border === 3)) {
    out += buildRule(widths, border, glyphs, 'top') + '\n';
  }
  if (!tuplesOnly) {
    out +=
      renderDataLine(
        headerCells.map((c) => c.lines[0] ?? ''),
        widths,
        aligns,
        border,
        glyphs,
        ' ',
      ) + '\n';
    out += buildRule(widths, border, glyphs, 'middle') + '\n';
  }
  if (!tuplesOnly && (border === 2 || border === 3)) {
    out += buildRule(widths, border, glyphs, 'bottom') + '\n';
  }
  if (!tuplesOnly && topt.defaultFooter) {
    out += '(0 rows)\n';
  }
  if (!tuplesOnly && opts.footers) {
    for (const f of opts.footers) out += f + '\n';
  }
  return out;
};
