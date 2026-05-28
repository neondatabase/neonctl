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
//
// Upstream libpq looks the OID up against the server-side `pg_type.typcategory`
// (or the legacy hard-coded numeric category) and right-aligns anything with
// category 'N' (numeric). That catches custom domains over numeric types and
// extension-provided numeric/identifier types (`pg_lsn`, `xid8`, …) without a
// hard-coded OID list.
//
// We don't have access to a live catalog at print time, so we maintain a
// curated set of well-known numeric/identifier OIDs that ship with stock PG.
// Custom domains over numeric types and contrib types not listed here will
// fall back to left-alignment — documented limitation.
const RIGHT_ALIGNED_OIDS = new Set<number>([
  20, // int8
  21, // int2
  23, // int4
  26, // oid
  700, // float4
  701, // float8
  790, // money
  1700, // numeric
  1186, // interval
  3220, // pg_lsn  (PG 9.4+ — log sequence numbers, render right-aligned)
  5069, // xid8    (PG 13+ — 64-bit transaction IDs)
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
  // Wrap / newline indicators inside data and header rows. Mirrors
  // upstream `printTextFormat` in `fe_utils/print.c`:
  //   headerNlLeft  - emitted in the leading-gutter slot for header lines
  //                   that are continuations (curr_nl_line > 0).
  //   headerNlRight - emitted in the trailing slot for header columns that
  //                   still have more lines below ("+" for ASCII, "↵" for
  //                   Unicode).
  //   nlLeft / nlRight - same idea for data rows.
  //   wrapLeft / wrapRight - emitted instead of nl markers when the
  //                   continuation is from in-cell wrapping (not a `\n`
  //                   split): "." for ASCII, "…" for Unicode.
  //   wrapRightBorder - when true (ASCII / Unicode), the trailing
  //                   marker is always emitted even at border=0 / on the
  //                   last column. When false (old-ascii), markers are
  //                   suppressed at the table edge for border=0.
  //   midvruleNl / midvruleWrap / midvruleBlank - in old-ascii, the
  //                   column separator on continuation lines changes
  //                   based on the joining cell's wrap state:
  //                   `:` for nl, `;` for wrap, ` ` for blank. ASCII /
  //                   Unicode keep `|` (resp. `│`) for all three.
  headerNlLeft: string;
  headerNlRight: string;
  wrapLeft: string;
  wrapRight: string;
  nlLeft: string;
  nlRight: string;
  wrapRightBorder: boolean;
  midvruleNl: string;
  midvruleWrap: string;
  midvruleBlank: string;
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
  headerNlLeft: ' ',
  headerNlRight: '+',
  wrapLeft: '.',
  wrapRight: '.',
  nlLeft: ' ',
  nlRight: '+',
  wrapRightBorder: true,
  midvruleNl: '|',
  midvruleWrap: '|',
  midvruleBlank: '|',
};

// `pg_asciiformat_old` — the legacy ASCII renderer kept around for
// `\pset linestyle old-ascii`. Two visible quirks vs the modern ASCII
// glyphs:
//   - left-side `+` markers in headers (header_nl_left), no right-side
//     marker on either headers or data, and `wrap_right_border=false`
//     (no trailing marker at the table edge);
//   - the column separator on continuation rows changes — `:` when the
//     joining cell has more `\n`-split lines below, `;` when it has more
//     wrap-split lines, ` ` when the cell is exhausted (`midvrule_blank`).
const OLD_ASCII_GLYPHS: Glyphs = {
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
  headerNlLeft: '+',
  headerNlRight: ' ',
  wrapLeft: ' ',
  wrapRight: ' ',
  nlLeft: ' ',
  nlRight: ' ',
  wrapRightBorder: false,
  midvruleNl: ':',
  midvruleWrap: ';',
  midvruleBlank: ' ',
};

// Light box-drawing glyphs (the only Unicode variant we expose today —
// `unicode_border_linestyle=double` / `unicode_column_linestyle=double` /
// `unicode_header_linestyle=double` are parsed by `cmd_format.ts` but the
// shared `Unicode2LineStyle` slot in `PrintTableOpts` only carries
// `ascii | unicode`, so all three settings collapse onto these "single"
// glyphs. Adding the double variant requires extending the type to keep
// `single`/`double` distinct (or carrying a separate side-channel field) —
// out of scope for this pass.
//
// Codepoints (verified against upstream `unicode_style` in print.c):
//   U+2500 ─ Box Drawings Light Horizontal           (hrule)
//   U+2502 │ Box Drawings Light Vertical             (vrule)
//   U+250C ┌ Box Drawings Light Down and Right       (topLeft)
//   U+252C ┬ Box Drawings Light Down and Horizontal  (topMid)
//   U+2510 ┐ Box Drawings Light Down and Left        (topRight)
//   U+251C ├ Box Drawings Light Vertical and Right   (midLeft)
//   U+253C ┼ Box Drawings Light Vertical and Horiz.  (midMid)
//   U+2524 ┤ Box Drawings Light Vertical and Left    (midRight)
//   U+2514 └ Box Drawings Light Up and Right         (botLeft)
//   U+2534 ┴ Box Drawings Light Up and Horizontal    (botMid)
//   U+2518 ┘ Box Drawings Light Up and Left          (botRight)
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
  // U+21B5 ↵ "Downwards Arrow with Corner Leftwards" — newline marker.
  // U+2026 … "Horizontal Ellipsis" — in-cell wrap marker.
  // Matches `unicode_style` in upstream `fe_utils/print.c`.
  headerNlLeft: ' ',
  headerNlRight: '↵',
  wrapLeft: '…',
  wrapRight: '…',
  nlLeft: ' ',
  nlRight: '↵',
  wrapRightBorder: true,
  midvruleNl: '│',
  midvruleWrap: '│',
  midvruleBlank: '│',
};

const glyphsFor = (style: Unicode2LineStyle): Glyphs => {
  if (style === 'unicode') return UNICODE_GLYPHS;
  if (style === 'old-ascii') return OLD_ASCII_GLYPHS;
  return ASCII_GLYPHS;
};

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

  // Wrapped mode shrinks the worst column until total width fits
  // `topt.columns`. Mirrors upstream `print_aligned_text` in
  // `fe_utils/print.c`: we score each column by
  //
  //   ratio = current_width / average_width + max_width * 0.01
  //
  // and shrink the column with the highest ratio. That picks the column
  // whose individual rows are mostly narrower than the worst-case row
  // (so wrapping costs fewer extra lines than shrinking a uniformly-wide
  // column would). The +max*0.01 bias breaks ties in favour of the
  // overall-widest column, matching the upstream comment "Slightly bias
  // against wider columns. (Increases chance a narrow column will fit
  // in its cell.)".
  //
  // `width_wrap` (== `widths` here) starts as `max_width`. Each loop
  // iteration decrements it by one until the total fits or no column
  // can shrink further (every column is already at its header width).
  if (wrapped) {
    const maxColumns = topt.columns > 0 ? topt.columns : topt.envColumns;
    if (maxColumns > 0) {
      // Average width per column over the data rows (header excluded,
      // matching upstream `width_average` which divides cell_count by
      // col_count). Each cell's width is its max line width (mirrors
      // upstream `pg_wcssize`, which returns the widest line of the
      // possibly-multiline cell).
      const widthAverage: number[] = new Array(colCount).fill(0) as number[];
      const maxWidth: number[] = headerCells.map((c) => c.width);
      if (cellGrid.length > 0) {
        for (const row of cellGrid) {
          for (let i = 0; i < colCount; i++) {
            widthAverage[i] += row[i].width;
            if (row[i].width > maxWidth[i]) maxWidth[i] = row[i].width;
          }
        }
        for (let i = 0; i < colCount; i++) {
          widthAverage[i] /= cellGrid.length;
        }
      }

      // Total fixed overhead. Mirrors upstream `print.c` lines 763-769:
      //   border 0: col_count          (one trailing-marker slot per cell)
      //   border 1: col_count * 3 - 1  (3 slots per cell minus shared sep)
      //   border 2: col_count * 3 + 1  (3 slots per cell plus outer rules)
      // For ASCII / Unicode the trailing marker slot is always emitted
      // (wrap_right_border=true), so the formula matches verbatim.
      const overheadFor = (n: number): number => {
        if (border === 0) return n;
        if (border === 1) return n * 3 - (n > 0 ? 1 : 0);
        return n * 3 + 1;
      };
      const overhead = overheadFor(colCount);
      const totalHeaderWidth =
        overhead + headerCells.reduce((a, c) => a + c.width, 0);
      let total = overhead + widths.reduce((a, b) => a + b, 0);

      // Upstream guards against shrinking when even the headers don't
      // fit — there's no point picking columns to wrap if the rule row
      // is already too wide.
      if (maxColumns >= totalHeaderWidth) {
        while (total > maxColumns) {
          let worstCol = -1;
          let maxRatio = 0;
          for (let i = 0; i < colCount; i++) {
            const headerW = headerCells[i].width;
            // Two preconditions from upstream:
            //   - width_average[i] != 0  (column has some data; avoids /0)
            //   - width_wrap[i] > width_header[i]  (header is the floor;
            //     can't shrink below it without overlapping the header).
            if (widthAverage[i] > 0 && widths[i] > headerW) {
              const ratio = widths[i] / widthAverage[i] + maxWidth[i] * 0.01;
              if (ratio > maxRatio) {
                maxRatio = ratio;
                worstCol = i;
              }
            }
          }
          if (worstCol === -1) break;
          widths[worstCol]--;
          total--;
        }
      }
    }
  }

  let out = '';
  const newline = '\n';

  // Compute total table width once: needed for title centring (and only
  // there at the moment). Mirrors upstream `width_total` from
  // print.c lines 935-950: when the title is narrower than the table,
  // centre it; otherwise left-align (no padding).
  let widthTotal = 0;
  if (!tuplesOnly && topt.title) {
    const overhead =
      border === 0
        ? widths.length
        : border === 1
          ? widths.length * 3 - (widths.length > 0 ? 1 : 0)
          : widths.length * 3 + 1;
    widthTotal = overhead + widths.reduce((a, b) => a + b, 0);
    const titleW = displayWidth(topt.title);
    if (titleW >= widthTotal) {
      out += topt.title + newline;
    } else {
      const pad = (widthTotal - titleW) >> 1;
      out += ' '.repeat(pad) + topt.title + newline;
    }
  }

  // Top rule: emitted when border == 2 or 3.
  if (!tuplesOnly && (border === 2 || border === 3)) {
    out += buildRule(widths, border, glyphs, 'top') + newline;
  }

  // ------- Header row(s) -------
  if (!tuplesOnly) {
    // For wrapped mode the header column may itself need wrapping if its
    // own width exceeds the (possibly shrunk) column width. Upstream
    // `print_aligned_text` only computes header line breaks based on `\n`
    // splits — header text that's wider than the column wraps onto the
    // next display line via the same wrap loop as the data path. We
    // mirror that by passing the header text through `wrapLine` in
    // wrapped mode (and through the simple `\n` split for plain mode).
    const headerColLines: string[][] = headerCells.map((c, i) => {
      if (!wrapped) return c.lines;
      const out: string[] = [];
      for (const line of c.lines) {
        out.push(...wrapLine(line, widths[i]));
      }
      return out;
    });
    const headerLineCount = Math.max(1, ...headerColLines.map((l) => l.length));
    for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
      // Per-column wrap state for this physical header line:
      //   `wrap`   the cell has more content to emit on the next line
      //            via in-cell wrapping (wrap_left/wrap_right marker)
      //   `nl`     the cell has more `\n`-split content below
      //            (header_nl_left/header_nl_right marker)
      //   `none`   the cell is done (already emitted its last line)
      const cellWrapPrev: ('wrap' | 'nl' | 'none')[] = headerColLines.map(
        (l) => (lineIdx > 0 && lineIdx < l.length ? 'nl' : 'none'),
      );
      const cellWrapNext: ('wrap' | 'nl' | 'none')[] = headerColLines.map(
        (l) => (lineIdx < l.length - 1 ? 'nl' : 'none'),
      );
      out += renderHeaderLine(
        headerColLines.map((l) => l[lineIdx] ?? ''),
        widths,
        border,
        glyphs,
        cellWrapPrev,
        cellWrapNext,
        lineIdx === 0,
      );
      out += newline;
    }
    // Header rule.
    out += buildRule(widths, border, glyphs, 'middle') + newline;
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
    // We also need to know, per column, which output lines originated as
    // wrap continuations (vs. `\n` splits) so the markers can pick the
    // correct glyph: `.` (wrap_left/right) when wrapped from an
    // over-width source line, `+` (nl_left/right) when split by a literal
    // newline in the cell content.
    //
    // We classify by walking the original cell.lines: each source line
    // expands to N display lines (N >= 1) via `wrapLine`. The first
    // expansion is "nl" (or the very first line of the cell, which has
    // no marker), the rest are "wrap" continuations of the same source
    // line.
    const colLineKinds: ('start' | 'wrap' | 'nl')[][] = row.map((cell, i) => {
      const kinds: ('start' | 'wrap' | 'nl')[] = [];
      const lines = cell.lines;
      for (let si = 0; si < lines.length; si++) {
        const chunks = wrapped ? wrapLine(lines[si], widths[i]) : [lines[si]];
        for (let ci = 0; ci < chunks.length; ci++) {
          if (si === 0 && ci === 0) kinds.push('start');
          else if (ci === 0) kinds.push('nl');
          else kinds.push('wrap');
        }
      }
      return kinds;
    });
    const lineCount = Math.max(1, ...colLines.map((l) => l.length));

    for (let li = 0; li < lineCount; li++) {
      // For each column, determine the wrap state for THIS output line.
      // The LEFT marker is selected by `cellWrapPrev[j]`: what kind of
      // continuation made this line exist (the `kind` of the current
      // line — `wrap` or `nl` — only matters when li > 0).
      // The RIGHT marker is selected by `cellWrapNext[j]`: the kind of
      // the NEXT line (li + 1), which tells us whether this cell is
      // still emitting more content.
      const cellWrapPrev: ('wrap' | 'nl' | 'none')[] = colLineKinds.map(
        (kinds, j) => {
          if (li === 0 || li >= colLines[j].length) return 'none';
          return kinds[li] === 'wrap' ? 'wrap' : 'nl';
        },
      );
      const cellWrapNext: ('wrap' | 'nl' | 'none')[] = colLineKinds.map(
        (kinds, j) => {
          const nextIdx = li + 1;
          if (nextIdx >= colLines[j].length) return 'none';
          return kinds[nextIdx] === 'wrap' ? 'wrap' : 'nl';
        },
      );
      out += renderDataLine(
        colLines.map((l) => l[li] ?? ''),
        widths,
        aligns,
        border,
        glyphs,
        cellWrapPrev,
        cellWrapNext,
        li === 0,
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

  // Footer: (N rows) + trailing blank line. Upstream's
  // `print_aligned_text` emits `printTableAddFooter()` and then
  // `printTableCleanup()` adds a separator `\n`. Verified against
  // vanilla psql 18: `SELECT 1; SELECT 2;` emits each result followed
  // by `(1 row)\n\n` so consecutive queries are visually separated.
  //
  // Footer handling mirrors `footers_with_default` (print.c lines
  // 397-413): user footers SUPPRESS the default `(N rows)` row counter.
  // The default is only emitted when there are no user footers AND
  // `defaultFooter` is true. This matters for `\d` output, which
  // attaches user footers ("Access method: ...", "Owned by: ...") and
  // doesn't want the row counter to interleave between the data rows
  // and the footers.
  const hasUserFooters = !!opts.footers && opts.footers.length > 0;
  if (!tuplesOnly && topt.defaultFooter && !hasUserFooters) {
    const n = rs.rows.length;
    out += `(${String(n)} ${n === 1 ? 'row' : 'rows'})` + newline;
  }

  if (!tuplesOnly && opts.footers) {
    for (const f of opts.footers) out += f + newline;
  }

  // Trailing blank line between query results. Upstream `print.c`
  // line 1196 emits `fputc('\n', fout)` UNCONDITIONALLY (not guarded by
  // `opt_tuples_only`) when `stop_table` is set — so `\pset tuples_only
  // on` queries still get a single blank separator before the next
  // command. Verified against vanilla psql 18.
  out += newline;

  return out;
};

type WrapState = 'wrap' | 'nl' | 'none';

/**
 * Pick the column-separator glyph between two adjacent cells. ASCII and
 * Unicode collapse `midvruleNl` / `midvruleWrap` / `midvruleBlank` onto the
 * base `vrule`, so the alt-glyph branches only matter for `old-ascii`,
 * which uses `:` for `\n` continuations, `;` for wrap continuations, and
 * `" "` when the joining column is exhausted but the line still exists
 * because of a wrap/continuation elsewhere in the row.
 *
 * Upstream picks the midvrule from the column *to the right of the
 * separator* (`right`) — if that column is past-end, the separator
 * collapses to `midvruleBlank` regardless of the left column's state.
 *
 * `firstLine = true` short-circuits to the base `vrule` — upstream
 * only consults the midvrule table once at least one continuation has
 * been emitted, so the first display line of every row always uses
 * the regular vrule even if a column will wrap on the next line.
 */
const pickMidvrule = (
  glyphs: Glyphs,
  // Left col's state at this line (cellWrapPrev[i]) — unused by the
  // upstream rule but kept in the signature for clarity at call sites.
  _left: WrapState,
  right: WrapState,
  firstLine: boolean,
): string => {
  if (firstLine) return glyphs.vrule;
  if (right === 'wrap') return glyphs.midvruleWrap;
  if (right === 'nl') return glyphs.midvruleNl;
  return glyphs.midvruleBlank;
};

/**
 * Right-marker glyph for a data row's cell. Mirrors the `wrap[j]`-driven
 * fputs at upstream `print.c` lines 1151-1156:
 *   PRINT_LINE_WRAP_WRAP    → format->wrap_right  (`.` ascii, `…` unicode)
 *   PRINT_LINE_WRAP_NEWLINE → format->nl_right    (`+` ascii, `↵` unicode)
 *   PRINT_LINE_WRAP_NONE    → " " (only when not at the trailing edge
 *                                  without border)
 */
const dataRightMarker = (
  state: WrapState,
  glyphs: Glyphs,
  isLast: boolean,
  border: BorderStyle,
): string => {
  if (state === 'wrap') return glyphs.wrapRight;
  if (state === 'nl') return glyphs.nlRight;
  // state === 'none': trailing edge — only emit a space when there's
  // something AFTER us (another column to follow, or the right border
  // of a border=2/3 box). For the LAST cell on a borderless row, nothing.
  if (isLast && border !== 2 && border !== 3) return '';
  return ' ';
};

/**
 * Left-marker glyph for a data row's cell. Mirrors `wrap[j]` at upstream
 * `print.c` lines 1066-1073:
 *   PRINT_LINE_WRAP_WRAP    → format->wrap_left  (`.` ascii, `…` unicode)
 *   PRINT_LINE_WRAP_NEWLINE → format->nl_left    (" " for both ascii/unicode)
 *   PRINT_LINE_WRAP_NONE    → " "
 *
 * Only emitted when border != 0 (the leading-gutter slot). For border=0
 * upstream skips this entirely (no leading marker).
 */
const dataLeftMarker = (state: WrapState, glyphs: Glyphs): string => {
  if (state === 'wrap') return glyphs.wrapLeft;
  if (state === 'nl') return glyphs.nlLeft;
  return ' ';
};

/**
 * Render one display-line of a header row. Centered cells, fixed
 * `header_nl_*` markers on continuation lines.
 *
 * Layout (with ASCII glyphs):
 *   border 0:  `<c1centered>[H]<c2centered>[H]` — `wrap_right_border=true`
 *              means the trailing slot still gets emitted even at table
 *              edge. `H` = `header_nl_right` ("+") when the next line in
 *              this column has more content, else " ".
 *   border 1:  ` <c1centered>[H]| <c2centered>[H]`
 *              (leading gutter, header_nl_right marker between content and
 *              separator, optional trailing " " on the very last cell)
 *   border 2:  `| <c1centered>[H]| <c2centered>[H]|` (full box)
 */
const renderHeaderLine = (
  cells: string[],
  widths: number[],
  border: BorderStyle,
  glyphs: Glyphs,
  // What kind of continuation produced THIS line (curr_nl_line > 0 in
  // upstream): determines the leading marker on this side of the cell.
  // Per-col `cellWrapPrev[i]` only drives the trailing marker now; the
  // leading-gutter decision uses `firstLine` (curr_nl_line == 0).
  cellWrapPrev: WrapState[],
  // What kind of continuation follows on the NEXT line: determines
  // the trailing marker for this cell.
  cellWrapNext: WrapState[],
  // True on the very first display line of the header (curr_nl_line == 0
  // in upstream). Upstream emits `header_nl_left` for ALL non-first cells
  // whenever curr_nl_line > 0 — even for cells that are themselves
  // exhausted on that line — so the choice can't be made per-column.
  firstLine: boolean,
): string => {
  const { vrule } = glyphs;
  let out = '';

  if (border === 2 || border === 3) out += vrule;

  for (let i = 0; i < cells.length; i++) {
    const isLast = i === cells.length - 1;
    // Leading gutter / wrap marker. Upstream `print.c` line 981-984:
    //   if (opt_border != 0 || (!format->wrap_right_border && i > 0))
    //     fputs(curr_nl_line ? format->header_nl_left : " ", fout);
    // For ASCII (wrap_right_border=true): emitted iff border != 0.
    // For old-ascii (wrap_right_border=false): emitted for non-first
    // cells too at border=0 — the inter-column slot doubles as the
    // leading-gutter slot of col[i].
    if (border !== 0 || (!glyphs.wrapRightBorder && i > 0)) {
      out += firstLine ? ' ' : glyphs.headerNlLeft;
    }

    // Header cells are always centered and padded to full width
    // (upstream emits `%-*s%s%-*s` regardless of position — no
    // skip-padding-on-last-cell quirk on header rows).
    out += padToWidth(cells[i], widths[i], 'center');

    // Trailing marker. Upstream `print.c` line 1003-1005:
    //   if (opt_border != 0 || format->wrap_right_border)
    //     fputs(!header_done[i] ? format->header_nl_right : " ", fout);
    // For ASCII this is always emitted (wrap_right_border=true), so
    // multi-line headers get `+` between content and the column
    // separator AND on the trailing edge of the last column. For
    // OLD-ASCII (wrap_right_border=false) this slot is skipped at
    // border=0 — the inter-column space comes from the NEXT cell's
    // leading-gutter emit on the next loop iteration.
    if (border !== 0 || glyphs.wrapRightBorder) {
      out += cellWrapNext[i] !== 'none' ? glyphs.headerNlRight : ' ';
    }

    // Column divider (not on the last column). For border 0 ASCII the
    // trailing-marker slot above already consumes the inter-column gap.
    // For border 0 OLD-ASCII the next iteration emits the leading-gutter
    // slot, so no extra space is needed here either.
    if (!isLast && border !== 0) {
      out += vrule;
    }
  }

  if (border === 2 || border === 3) out += vrule;
  return out;
};

/**
 * Render one display-line of a data row.
 *
 * Mirrors upstream `print_aligned_text` (print.c lines 1047-1180): one
 * loop body, per-column emit `[left-marker] <content> [right-marker]
 * [column-divider]`, then `[right-border]`. Padding is applied when:
 *   - the cell is not the last column (finalspaces=true in upstream),
 *   - OR `wrap[j]` is set (cell continues, so marker needs an aligned
 *     position).
 *
 * Right-aligned columns always pad on the left (spaces first), but per
 * upstream they get a trailing right-margin pad only at border=2 (the
 * `finalspaces` branch). For border 0/1 right-aligned columns we follow
 * the same rule: padding before content, no trailing pad on the last
 * column when there's no continuation.
 */
const renderDataLine = (
  cells: string[],
  widths: number[],
  aligns: Alignment[],
  border: BorderStyle,
  glyphs: Glyphs,
  // For each column, the "wrap state" carried over from the previous
  // physical line (drives the LEFT marker — `wrap[j]` in upstream's
  // pre-content fputs).
  cellWrapPrev: WrapState[],
  // For each column, the wrap state determined by THIS line's content
  // and whatever follows on the NEXT line (drives the RIGHT marker and
  // the column divider glyph).
  cellWrapNext: WrapState[],
  // True only on the first display line of a row. Used by old-ascii to
  // keep the regular `|` separator on the row's first line (the alt
  // midvrules only kick in once at least one continuation has been
  // emitted).
  firstLine: boolean,
): string => {
  const { vrule } = glyphs;
  let out = '';

  if (border === 2 || border === 3) out += vrule;

  for (let i = 0; i < cells.length; i++) {
    const isLast = i === cells.length - 1;

    // Left marker. Border 0 has no leading-gutter slot for non-first
    // cells under ASCII (wrap_right_border=true); under OLD-ASCII the
    // leading-gutter slot doubles as the inter-column space for i > 0
    // (upstream `print.c` line 1066-1073).
    if (border !== 0) {
      out += dataLeftMarker(cellWrapPrev[i], glyphs);
    } else if (!glyphs.wrapRightBorder && i > 0) {
      out += dataLeftMarker(cellWrapPrev[i], glyphs);
    }

    // Decide whether to pad this cell. Upstream `print.c` lines 1141-1148:
    //   left-aligned cells pad iff `finalspaces || wrap[j] != NONE`.
    //   right-aligned cells always pad on the left side regardless.
    // `finalspaces` = (border == 2 || not last column).
    const finalspaces = border === 2 || border === 3 || !isLast;
    const needsTrailingPad = finalspaces || cellWrapNext[i] !== 'none';
    if (aligns[i] === 'right') {
      // Right-aligned cells always get full padding on the left so
      // content right-aligns. Trailing pad only when finalspaces (or
      // wrap, to keep marker aligned).
      out += padToWidth(cells[i], widths[i], 'right');
    } else if (needsTrailingPad) {
      out += padToWidth(cells[i], widths[i], 'left');
    } else {
      // Last cell, no wrap state — emit raw content (no trailing pad).
      out += cells[i];
    }

    // Right marker. Upstream `print.c` lines 1150-1156:
    //   - WRAP   → wrap_right
    //   - NEWLINE→ nl_right
    //   - NONE   → space (only when not last col / border=2)
    // For OLD-ASCII at border 0 the inter-column trailing slot of
    // non-last cells is owned by the *next* iteration's leading-gutter
    // emit (single space either way). For the very last column, upstream
    // still emits a trailing char when the cell is on a continuation
    // (`cellWrapNext != none`) so wrapped cells keep their trailing
    // column position aligned with the first line.
    if (border !== 0 || glyphs.wrapRightBorder) {
      out += dataRightMarker(cellWrapNext[i], glyphs, isLast, border);
    } else if (isLast && cellWrapNext[i] !== 'none') {
      out += dataRightMarker(cellWrapNext[i], glyphs, isLast, border);
    }

    // Column divider. Upstream lines 1158-1169: in old-ascii the
    // midvrule between col[i] and col[i+1] swaps to a continuation
    // glyph when *either* adjacent cell is on a wrap/nl continuation
    // (midvrule_nl=":", midvrule_wrap=";", midvrule_blank=" "). For
    // ASCII / Unicode all three midvrule_* equal the regular vrule, so
    // the branch collapses to `vrule`.
    if (!isLast && border !== 0) {
      out += pickMidvrule(
        glyphs,
        cellWrapPrev[i],
        cellWrapPrev[i + 1],
        firstLine,
      );
    }
  }

  if (border === 2 || border === 3) out += vrule;
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
  // `old-ascii` swaps several emission decisions (leading-slot at border<2,
  // suppressed data trailing marker, alternate midvrule glyph on
  // continuation lines). Track once at the top so the per-line code stays
  // readable.
  const oldAscii = topt.unicodeBorderLineStyle === 'old-ascii';

  const headers = rs.fields.map((f) => f.name);

  // Width of the name column = max header line width (multi-line headers
  // count per-line; upstream `pg_wcssize` returns the widest line).
  let nameWidth = 0;
  let hmultiline = false;
  for (const h of headers) {
    for (const line of h.split('\n')) {
      const w = displayWidth(line);
      if (w > nameWidth) nameWidth = w;
    }
    if (h.includes('\n')) hmultiline = true;
  }

  // Width of the value column = max value width across all rows.
  let valueWidth = 0;
  let dmultiline = false;
  const cellGrid: string[][] = rs.rows.map((row) =>
    row.map((cell) => renderCell(cell, nullPrint, topt.numericLocale)),
  );
  for (const row of cellGrid) {
    for (const v of row) {
      if (v.includes('\n')) dmultiline = true;
      for (const line of v.split('\n')) {
        const w = displayWidth(line);
        if (w > valueWidth) valueWidth = w;
      }
    }
  }

  // Compute dwidth — the value-column width used for both the record
  // header padding and the per-cell value wrap. Mirrors upstream
  // `print_aligned_vertical` in `fe_utils/print.c` lines 1463-1583: the
  // value column shrinks to fit `output_columns` (with a hard floor
  // enforced via `min_width` and `rwidth`) when `\pset format wrapped`
  // AND `\pset columns N` is in effect. Runs for all borders 0/1/2.
  //
  // The `swidth` table below mirrors the upstream branches:
  //   border 0: 1 (gutter)  +1 if hmultiline
  //                         +1 if dmultiline (border<2 && !oldAscii)
  //   border 1: 3 (` | `)   +1 if hmultiline && oldAscii (left newline marker)
  //                         +1 if dmultiline (border<2 && !oldAscii)
  //   border 2: 7 (outer vrules + spacers; no dmultiline bump)
  //
  // `rwidth` is the natural label width (`* RECORD N` + digit count).
  // The two-pass loop turns `dmultiline` on the first iteration if a
  // wrap is needed, then recomputes with the bumped swidth. We
  // implement that as a single pass over the two possible swidths.
  const wrappedMode = topt.format === 'wrapped';
  let dwidth = valueWidth;
  if (wrappedMode) {
    const outputColumns = topt.columns > 0 ? topt.columns : topt.envColumns;
    if (outputColumns > 0) {
      let baseSwidth: number;
      if (border === 0) baseSwidth = 1 + (hmultiline ? 1 : 0);
      else if (border === 1) baseSwidth = 3 + (hmultiline && oldAscii ? 1 : 0);
      else baseSwidth = 7;
      // dmultiline adds a marker column only when border < 2 and not old-ascii
      // (old-ascii suppresses the data trailing marker entirely at border<2).
      const dmAddOk = border < 2 && !oldAscii;
      const swidthInit = baseSwidth + (dmAddOk && dmultiline ? 1 : 0);
      const swidthAfterWrap = baseSwidth + (dmAddOk ? 1 : 0);

      // rwidth = label-width floor: `* RECORD N`(9), `-[ RECORD  ]`(12),
      // or `+-[ RECORD  ]-+`(15), each plus digit count for N.
      const labelOverhead = border === 0 ? 9 : border === 1 ? 12 : 15;
      const nrows = cellGrid.length;
      const rwidth =
        labelOverhead +
        (nrows > 0 ? 1 + Math.floor(Math.log10(Math.max(1, nrows))) : 0);

      const compute = (swidth: number): number => {
        let width = nameWidth + swidth + valueWidth;
        if (width < rwidth) width = rwidth;
        let minWidth = nameWidth + swidth + 3;
        if (minWidth < rwidth) minWidth = rwidth;
        if (outputColumns >= width) return width - nameWidth - swidth;
        if (outputColumns < minWidth) return minWidth - nameWidth - swidth;
        return outputColumns - nameWidth - swidth;
      };

      // First pass with the natural swidth.
      let newDwidth = compute(swidthInit);
      // If wrap is needed (newDwidth < natural) AND dmultiline wasn't
      // already true AND we're at border<2, upstream toggles dmultiline
      // on and re-runs with swidth+1.
      if (newDwidth < valueWidth && !dmultiline && dmAddOk) {
        newDwidth = compute(swidthAfterWrap);
        dmultiline = true;
      }
      // Clamp: never grow the data column beyond the natural value
      // width (matches `dwidth = newdwidth` in upstream).
      dwidth = newDwidth < valueWidth ? newDwidth : valueWidth;
    }
  }

  let out = '';
  const newline = '\n';

  if (!tuplesOnly && topt.title) {
    out += topt.title + newline;
  }

  if (rs.rows.length === 0) {
    // Expanded mode on empty result: upstream emits the "(0 rows)"
    // footer (same wording as horizontal mode) followed by the trailing
    // blank-line separator, NOT a special "(No rows)" string. Verified
    // against vanilla psql 18: `\\pset expanded on` then `select 1
    // where false;` emits `(0 rows)\n\n`.
    if (!tuplesOnly) out += '(0 rows)' + newline;
    if (!tuplesOnly && opts.footers) {
      for (const f of opts.footers) out += f + newline;
    }
    if (!tuplesOnly) out += newline;
    return out;
  }

  // Decide whether multi-line markers should be emitted on header/data
  // continuations. Mirrors upstream `print_aligned_vertical` predicates
  // at print.c lines 1679-1689 (header right marker) and 1747-1763 (data
  // trailing marker):
  //   non-old-ascii: header marker iff `border > 0 || hmultiline`
  //                  data marker   iff `border > 1 || dmultiline`
  //   old-ascii:     header right marker emitted iff `border > 0`
  //                  data right marker  emitted iff `border > 1`
  //                  (old-ascii relies on header_nl_LEFT for header
  //                  continuations and never emits the data right marker
  //                  at border<2 — it uses the alt midvrule glyph instead.)
  const emitHeaderMarker = oldAscii ? border > 0 : border > 0 || hmultiline;
  const emitDataMarker = oldAscii ? border > 1 : border > 1 || dmultiline;
  // Leading-slot for header column. Upstream `print_aligned_vertical`
  // line 1655-1657 emits the slot at `border==2 || (hmultiline &&
  // oldAscii)`. Old-ascii routes the continuation marker through the
  // leading gutter (`+` in `headerNlLeft`) instead of the trailing slot.
  const emitHeaderLeftSlot = border > 1 || (hmultiline && oldAscii);
  // Record-header label width. Upstream line 1610-1613 bumps `lhwidth`
  // by 1 at border<2 with hmultiline && oldAscii — the extra column is
  // the same `+` newline-indicator slot the data lines reserve.
  const lhwidth =
    border < 2 && hmultiline && oldAscii ? nameWidth + 1 : nameWidth;

  for (let r = 0; r < cellGrid.length; r++) {
    if (!tuplesOnly) {
      out += renderRecordHeader(
        r + 1,
        lhwidth,
        dwidth,
        border,
        glyphs,
        r === 0,
      );
      out += newline;
    } else if (r > 0 || border === 2 || border === 3) {
      // tuples_only: upstream `print_aligned_vertical` line 1619-1621
      // still emits the inter-record separator (with the `* Record N`
      // label suppressed) for r>0, and the top rule at border=2/3 for
      // the very first record. Reuses the same record-header path with
      // `record=0` to suppress the label glyph.
      out += renderRecordHeader(0, lhwidth, dwidth, border, glyphs, r === 0);
      out += newline;
    }
    for (let c = 0; c < headers.length; c++) {
      const headerLines = headers[c].split('\n');
      const dataLines = cellGrid[r][c].split('\n');

      out += renderVerticalCell(
        headerLines,
        dataLines,
        nameWidth,
        dwidth,
        border,
        glyphs,
        hmultiline,
        emitHeaderMarker,
        emitDataMarker,
        emitHeaderLeftSlot,
        oldAscii,
      );
    }
  }

  if (!tuplesOnly && (border === 2 || border === 3)) {
    out +=
      glyphs.botLeft +
      glyphs.hrule.repeat(nameWidth + 2) +
      glyphs.botMid +
      glyphs.hrule.repeat(dwidth + 2) +
      glyphs.botRight +
      newline;
  }

  // Footer + trailing blank-line handling mirrors upstream
  // `print_aligned_vertical` (print.c lines 1804-1822):
  //   - At border < 2, emit a blank line BEFORE the user footers
  //     (separates the last data line from the footer block).
  //   - At border >= 2, the bottom rule already provides the separator
  //     so no extra blank is emitted before footers.
  //   - Always emit a trailing blank line at the very end —
  //     `fputc('\n', fout)` on line 1821 is UNCONDITIONAL (not gated by
  //     `opt_tuples_only`), so tuples_only mode still gets a single
  //     separator before the next command.
  //   - Expanded mode never emits a `(N rows)` default footer; the
  //     trailing blank is the only output between consecutive results.
  const hasUserFooters = !!opts.footers && opts.footers.length > 0;
  if (!tuplesOnly && hasUserFooters && border < 2) {
    out += newline;
  }
  if (!tuplesOnly && opts.footers) {
    for (const f of opts.footers) out += f + newline;
  }
  out += newline;
  return out;
};

/**
 * Render the `[ RECORD N ]` block header for vertical mode.
 *
 *  border 0:  `* Record N<spaces-to-fill>`  (padded to `nameWidth + valueWidth`)
 *  border 1:  `-[ RECORD N ]<dashes-to-fit>+<dashes-to-fit>`
 *  border 2:  `+-[ RECORD N ]<dashes>+<dashes>+`
 *
 * Mirrors psql `print_aligned_vertical_line`.
 *
 * Layout invariants (verified empirically against vanilla psql 18):
 *
 *  border 1 — data line is `<name padded to nameWidth> | <value>`:
 *    - The `|` column-separator sits at position `nameWidth + 2`.
 *    - Record header `+` mid junction aligns with that `|`, so the
 *      pre-junction (left) span is `nameWidth + 1` chars and the
 *      post-junction (right) span is `valueWidth + 1` chars.
 *    - When `1 + label.length` overflows the pre-junction span but the
 *      label still fits in the full data row width, upstream pads with
 *      hrule chars to the row width and OMITS the mid junction
 *      (`-[ RECORD 1 ]--` for `nameWidth=2, valueWidth=10`).
 *    - When `1 + label.length` overflows the row width too, upstream
 *      emits just the label-prefix with no padding (the label IS the
 *      whole divider line).
 *
 *  border 2 — data line is `| <name> | <value> |`, row width is
 *    `1 + (nameWidth + 2) + 1 + (valueWidth + 2) + 1`:
 *    - Outer corners use the TOP glyph set on the first record
 *      (`topLeft`, `topMid`, `topRight`) and the MID glyph set on
 *      subsequent records (`midLeft`, `midMid`, `midRight`). The bottom
 *      rule (emitted by `renderVertical`) uses the BOT glyphs.
 *    - The `topMid` (or `midMid`) junction sits at position
 *      `leftSegLen + 2` to match the `|` column-separator in the data
 *      row. When `1 + label.length` overflows the left segment, the
 *      junction glyph is dropped and the row is padded entirely with
 *      hrule chars between the outer corners.
 *
 *  border 0 — label is padded with spaces to `nameWidth + valueWidth`.
 *    Labels that exceed `nameWidth + valueWidth` pass through unchanged.
 *
 * `isFirst` only affects border 2 glyph selection; border 0 and 1 share
 * a single set of single-line rule glyphs across all records.
 */
const renderRecordHeader = (
  record: number,
  nameWidth: number,
  valueWidth: number,
  border: BorderStyle,
  glyphs: Glyphs,
  isFirst: boolean,
): string => {
  const { hrule } = glyphs;
  // `record === 0` is the tuples_only "separator-only" sentinel — upstream
  // `print_aligned_vertical_line` (print.c line 1244-1249) gates the
  // label emission on `if (record)`, so passing 0 yields a bare rule
  // with no `* Record N` / `[ RECORD N ]` text. At border=0 that's a
  // blank line padded to width; at border>=1 a continuous hrule run.
  if (record === 0) {
    if (border === 0) {
      return ' '.repeat(nameWidth + valueWidth);
    }
    if (border === 1) {
      const rowWidth = nameWidth + 3 + valueWidth;
      const leftSpan = nameWidth + 1;
      // Mid junction lands at the `|` position in data rows.
      return (
        hrule.repeat(leftSpan) +
        glyphs.midMid +
        hrule.repeat(rowWidth - leftSpan - 1)
      );
    }
    // border 2/3.
    const outerLeft = isFirst ? glyphs.topLeft : glyphs.midLeft;
    const outerRight = isFirst ? glyphs.topRight : glyphs.midRight;
    const outerMid = isFirst ? glyphs.topMid : glyphs.midMid;
    return (
      outerLeft +
      hrule.repeat(nameWidth + 2) +
      outerMid +
      hrule.repeat(valueWidth + 2) +
      outerRight
    );
  }

  if (border === 0) {
    const label = `* Record ${String(record)}`;
    const target = nameWidth + valueWidth;
    if (label.length >= target) return label;
    return label + ' '.repeat(target - label.length);
  }

  const label = `[ RECORD ${String(record)} ]`;

  // border 1: `-[ RECORD N ]---+---------`
  if (border === 1) {
    // Data row width = nameWidth + 3 + valueWidth (`<name padded> | <value>`).
    // Pre-junction span = nameWidth + 1 (name col + gutter space). The
    // `+` mid junction lands at position `nameWidth + 2`, mirroring the
    // `|` in the data lines. Post-junction span = valueWidth + 1.
    const rowWidth = nameWidth + 3 + valueWidth;
    const leftSpan = nameWidth + 1;
    const rightSpan = valueWidth + 1;
    const left = hrule + label;
    if (left.length <= leftSpan) {
      // Label fits in the pre-junction span. Pad left to leftSpan, emit
      // the mid junction (`+`), then rightSpan hrules.
      const leftPadded = left + hrule.repeat(leftSpan - left.length);
      return leftPadded + glyphs.midMid + hrule.repeat(rightSpan);
    }
    if (left.length < rowWidth) {
      // Label overflows the pre-junction span but still fits within the
      // full row. Pad the label-prefix out to the row width with hrule
      // chars and DROP the mid junction (vanilla psql parity).
      return left + hrule.repeat(rowWidth - left.length);
    }
    // Label exceeds the full row width — emit just the label-prefix
    // (no padding, no junction).
    return left;
  }

  // border 2 / 3.
  //
  // Outer corners come from the TOP glyph set on the first record (so
  // the leading rule looks like a normal table top) and from the MID
  // glyph set on subsequent records (so it looks like an inter-row rule).
  // For ASCII these all collapse to `+`; the distinction matters for
  // Unicode (`┌`/`┐`/`┬` vs `├`/`┤`/`┼`).
  const outerLeft = isFirst ? glyphs.topLeft : glyphs.midLeft;
  const outerRight = isFirst ? glyphs.topRight : glyphs.midRight;
  const outerMid = isFirst ? glyphs.topMid : glyphs.midMid;

  // Data row width = 1 + (nameWidth + 2) + 1 + (valueWidth + 2) + 1.
  const leftSegLen = nameWidth + 2;
  const rightSegLen = valueWidth + 2;
  const leftCore = hrule + label;
  if (leftCore.length <= leftSegLen) {
    // Label fits in the left segment. Pad left to leftSegLen, emit the
    // top/mid junction, then rightSegLen hrules, then top/mid right
    // corner.
    const leftPadded = leftCore + hrule.repeat(leftSegLen - leftCore.length);
    return (
      outerLeft + leftPadded + outerMid + hrule.repeat(rightSegLen) + outerRight
    );
  }
  // Label overflows the left segment. Drop the mid junction and pad
  // hrules between the outer corners. When the natural row inner width
  // (= leftSegLen + 1 + rightSegLen) is itself smaller than the label
  // plus a single trailing hrule, the rule grows past the data-row
  // width so the label always has at least one `─`/`-` of breathing
  // room before the closing corner (verified against vanilla psql 18:
  // `\gx` on `SELECT 1 as one, 2 as two \pset border 2` emits
  // `┌─[ RECORD 1 ]─┐` — 14 inner chars vs the 9-char inner data row).
  const innerWidth = Math.max(
    leftSegLen + 1 + rightSegLen,
    leftCore.length + 1,
  );
  return (
    outerLeft +
    leftCore +
    hrule.repeat(innerWidth - leftCore.length) +
    outerRight
  );
};

/**
 * Render one cell (header + value) of an expanded-mode record.
 *
 * Mirrors the per-cell loop in upstream `print_aligned_vertical`
 * (print.c lines 1636-1801). Each iteration of the outer loop emits ONE
 * physical output line containing both the header part and the data
 * part. Iteration continues until BOTH the header and data sides are
 * exhausted (so a 3-line header against a 1-line value still emits 3
 * lines, with the data side blank from line 2 onward).
 *
 * Layout per iteration (border=0):
 *   <name padded to nameWidth><header_nl_right or space>
 *   <" " or wrap_left><value chunk (padded to dwidth iff more follows)><wrap_right / nl_right>
 *
 * Layout per iteration (border=1):
 *   <name padded to nameWidth><header_nl_right or space>
 *   <vrule>
 *   <" " or wrap_left><value chunk><wrap_right / nl_right or trailing space>
 *
 * Layout per iteration (border=2): adds outer vrules, always pads the
 * value column to dwidth, and always emits trailing markers.
 *
 * When header is done but data is not, the header side becomes pure
 * whitespace of width `hwidth + opt_border (+ 1 for border-0 hmultiline)`.
 * When data is done but header is not (because hheight > dheight), the
 * data side is just `\n` at border<2, or `<dwidth spaces>  |` at border>=2.
 */
const renderVerticalCell = (
  headerLines: string[],
  dataLines: string[],
  nameWidth: number,
  dwidth: number,
  border: BorderStyle,
  glyphs: Glyphs,
  hmultiline: boolean,
  emitHeaderMarker: boolean,
  emitDataMarker: boolean,
  emitHeaderLeftSlot: boolean,
  oldAscii: boolean,
): string => {
  const { vrule } = glyphs;
  let out = '';

  // Wrap each data line to dwidth. Each entry records whether the chunk
  // started a source line (`isWrapStart`) and whether it ended one
  // (`isWrapEnd`) — needed to pick wrap_left/right vs nl_right markers.
  type DataChunk = {
    text: string;
    width: number;
    isWrapStart: boolean;
    isWrapEnd: boolean;
  };
  const dataChunks: DataChunk[] = [];
  for (const src of dataLines) {
    if (dwidth > 0 && displayWidth(src) > dwidth) {
      const pieces = wrapLine(src, dwidth);
      const lastIdx = pieces.length - 1;
      pieces.forEach((piece, pi) => {
        dataChunks.push({
          text: piece,
          width: displayWidth(piece),
          isWrapStart: pi === 0,
          isWrapEnd: pi === lastIdx,
        });
      });
    } else {
      dataChunks.push({
        text: src,
        width: displayWidth(src),
        isWrapStart: true,
        isWrapEnd: true,
      });
    }
  }

  let hLine = 0;
  let dLine = 0;
  // `offset` mirrors upstream's `offset` variable (print.c line 1638): it
  // tracks how much of the current data line has been emitted so far. A
  // non-zero value at the start of an iteration means we're continuing a
  // wrap (drives midvrule_wrap on old-ascii separator picking). Upstream
  // updates `offset += bytes_to_output` even on the final chunk of a
  // non-empty cell, so the next iteration (when header is still
  // continuing) sees offset > 0.
  let offset = 0;
  let hcomplete = headerLines.length === 0;
  let dcomplete = dataChunks.length === 0;

  while (!hcomplete || !dcomplete) {
    // ---- Left border ----
    if (border === 2 || border === 3) out += vrule;

    // ---- Header part ----
    if (!hcomplete) {
      // Leading slot. Upstream `print.c` lines 1655-1657: emitted at
      // `border==2 || (hmultiline && oldAscii)`. Old-ascii routes the
      // continuation marker through the LEFT side via header_nl_left.
      if (emitHeaderLeftSlot) {
        out += hLine > 0 ? glyphs.headerNlLeft : ' ';
      }

      const text = headerLines[hLine];
      out += padToWidth(text, nameWidth, 'left');

      const hasMore = hLine + 1 < headerLines.length;
      if (hasMore) {
        if (emitHeaderMarker) out += glyphs.headerNlRight;
        hLine++;
      } else {
        if (emitHeaderMarker) out += ' ';
        hcomplete = true;
      }
    } else {
      // Header exhausted but data still has lines. Pad with
      // `nameWidth + border` spaces, +1 at border<2 if hmultiline &&
      // oldAscii (mirrors the lhwidth bump), +1 at border==0 if
      // hmultiline && !oldAscii (mirrors the extra trailing slot the
      // non-old-ascii branch carved out). Upstream print.c lines
      // 1693-1707.
      let swidth = nameWidth + border;
      if (border < 2 && hmultiline && oldAscii) swidth++;
      if (border === 0 && hmultiline && !oldAscii) swidth++;
      out += ' '.repeat(swidth);
    }

    // ---- Separator ----
    // Border > 0 emits the column rule. Upstream `print.c` 1710-1719
    // picks midvrule_wrap (`;` old-ascii) when offset != 0 (mid-wrap or
    // we just finished emitting a non-empty cell), midvrule (`|`) on the
    // very first data line, midvrule_nl (`:` old-ascii) on subsequent
    // data lines. For ASCII/Unicode all three resolve to the same vrule
    // glyph so the branch collapses; for old-ascii the continuation
    // glyph drives the visual distinction.
    if (border > 0) {
      if (offset !== 0) out += glyphs.midvruleWrap;
      else if (dLine === 0) out += vrule;
      else out += glyphs.midvruleNl;
    }

    // ---- Data part ----
    if (!dcomplete) {
      const chunk = dataChunks[dLine];
      // Leading slot: " " on the first chunk of a source line,
      // wrap_left on a wrap continuation. ALWAYS emitted (upstream
      // print.c line 1731 has no border guard).
      out += offset === 0 ? ' ' : glyphs.wrapLeft;
      out += chunk.text;
      // Mirror upstream's `offset += bytes_to_output`: bumped even on
      // the last chunk of a cell, so the next iteration (header still
      // continuing) sees offset > 0 and picks midvrule_wrap.
      offset += chunk.width;

      const isLastChunk = dLine === dataChunks.length - 1;
      const nextChunk = !isLastChunk ? dataChunks[dLine + 1] : null;

      let needsPad = false;
      let markerGlyph = '';
      if (nextChunk && !chunk.isWrapEnd) {
        // Wrap continuation: next chunk continues THIS source line.
        if (emitDataMarker) {
          needsPad = true;
          markerGlyph = glyphs.wrapRight;
        }
        dLine++;
        // Offset stays bumped — next chunk continues the same source line.
      } else if (nextChunk) {
        // Source-line boundary: next chunk starts a new data line.
        if (emitDataMarker) {
          needsPad = true;
          markerGlyph = glyphs.nlRight;
        }
        dLine++;
        offset = 0; // reset for new source line
      } else {
        // End of cell.
        if (border > 1) {
          // Border 2/3: pad to dwidth, trailing space, then vrule.
          needsPad = true;
          markerGlyph = ' ';
        }
        dcomplete = true;
        // Offset stays bumped — header-tail iterations should see
        // midvrule_wrap unless the cell was empty.
      }

      if (needsPad) {
        const pad = dwidth - chunk.width;
        if (pad > 0) out += ' '.repeat(pad);
      }
      out += markerGlyph;

      // ---- Right border ----
      if (border === 2 || border === 3) out += vrule;
    } else {
      // Data exhausted. Border<2 emits no further chars (a bare `\n`).
      // Border>=2 pads the value column then closes with right vrule
      // (upstream: `fprintf(fout, "%*s  %s\n", dwidth, "", rightvrule)`
      // — note the TWO trailing spaces between the dwidth pad and rule).
      if (border === 2 || border === 3) {
        out += ' '.repeat(dwidth) + '  ' + vrule;
      }
    }

    out += '\n';
  }

  return out;
};

// ---------------------------------------------------------------------------
// Mode selection.
// ---------------------------------------------------------------------------

const horizontalTotalWidth = (rs: ResultSet, topt: PrintTableOpts): number => {
  const widths = computeColumnWidths(rs, topt);
  const border = topt.border;
  const n = widths.length;
  // Match upstream `print.c` (lines 763-769) width_total:
  //   border 0: n; border 1: 3n-1; border 2/3: 3n+1.
  let overhead: number;
  if (border === 0) overhead = n;
  else if (border === 1) overhead = n * 3 - (n > 0 ? 1 : 0);
  else overhead = n * 3 + 1;
  return overhead + widths.reduce((a, b) => a + b, 0);
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

  let out = '';
  if (!tuplesOnly && topt.title) {
    // Centre the title above the table, matching the horizontal-path
    // logic (and upstream `print_aligned_text` `width_total` formula).
    // Falling through with no padding when title >= width keeps left-
    // alignment for very wide titles — `\d <wide-named-table>` typical.
    const overhead =
      border === 0
        ? widths.length
        : border === 1
          ? widths.length * 3 - (widths.length > 0 ? 1 : 0)
          : widths.length * 3 + 1;
    const widthTotal = overhead + widths.reduce((a, b) => a + b, 0);
    const titleW = displayWidth(topt.title);
    if (titleW >= widthTotal) {
      out += topt.title + '\n';
    } else {
      out += ' '.repeat((widthTotal - titleW) >> 1) + topt.title + '\n';
    }
  }
  if (!tuplesOnly && (border === 2 || border === 3)) {
    out += buildRule(widths, border, glyphs, 'top') + '\n';
  }
  if (!tuplesOnly) {
    const noneStates: WrapState[] = headerCells.map(() => 'none' as const);
    out +=
      renderHeaderLine(
        headerCells.map((c) => c.lines[0] ?? ''),
        widths,
        border,
        glyphs,
        noneStates,
        noneStates,
        true,
      ) + '\n';
    out += buildRule(widths, border, glyphs, 'middle') + '\n';
  }
  if (!tuplesOnly && (border === 2 || border === 3)) {
    out += buildRule(widths, border, glyphs, 'bottom') + '\n';
  }
  // User footers suppress the default `(0 rows)` row counter — mirrors
  // upstream `footers_with_default` (print.c lines 397-413).
  const hasUserFooters = !!opts.footers && opts.footers.length > 0;
  if (!tuplesOnly && topt.defaultFooter && !hasUserFooters) {
    out += '(0 rows)\n';
  }
  if (!tuplesOnly && opts.footers) {
    for (const f of opts.footers) out += f + '\n';
  }
  // Trailing blank line between query results, mirroring the horizontal /
  // vertical code paths (which append `\n` via `printTableCleanup`).
  // Empty results were previously missing this separator, which made
  // multiple back-to-back `\d`-family queries run together. Emitted
  // unconditionally (matches `fputc('\n', fout)` on print.c line 1196 /
  // 1821 — both are outside the `!opt_tuples_only` guard).
  out += '\n';
  return out;
};
