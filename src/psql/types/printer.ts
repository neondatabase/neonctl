import type { ResultSet } from './connection.js';

export type OutputFormat =
  | 'aligned'
  | 'unaligned'
  | 'wrapped'
  | 'html'
  | 'asciidoc'
  | 'latex'
  | 'latex-longtable'
  | 'troff-ms'
  | 'csv'
  | 'json';

export type Unicode2BorderStyle = 'single' | 'double';
export type Unicode2LineStyle = 'ascii' | 'unicode';
export type BorderStyle = 0 | 1 | 2 | 3;
/**
 * Expanded-header width — upstream `pset.popt.topt.expanded_header_width_type`
 * + `expanded_header_exact_width`. Stored together as a tagged value so the
 * bulk `\pset` view can render it identically to vanilla ("full", "column",
 * "page", or a positive integer).
 */
export type XheaderWidth = 'full' | 'column' | 'page' | number;

export type PrintTableOpts = {
  format: OutputFormat;
  expanded: 'off' | 'on' | 'auto';
  border: BorderStyle;
  pager: 'off' | 'on' | 'always';
  pagerMinLines: number;
  tuplesOnly: boolean;
  startTable: boolean;
  stopTable: boolean;
  defaultFooter: boolean;
  prior: number;
  encoding: string;
  envColumns: number;
  columns: number;
  unicodeBorderLineStyle: Unicode2LineStyle;
  unicodeColumnLineStyle: Unicode2LineStyle;
  unicodeHeaderLineStyle: Unicode2LineStyle;
  /**
   * `\pset unicode_border_linestyle` (single/double). Independent of
   * `unicodeBorderLineStyle` (ascii/unicode) — the printer consults both:
   * `unicodeBorderLineStyle === 'unicode'` selects the glyph family, this
   * field picks single- vs double-line variants inside it. Mirrors
   * upstream's `popt.topt.unicode_border_linestyle`. Optional so that
   * existing literal-`topt` test fixtures in `print/*` still satisfy the
   * shape — production constructors (`defaultSettings`) always set it.
   */
  unicodeBorderStyle?: Unicode2BorderStyle;
  unicodeColumnStyle?: Unicode2BorderStyle;
  unicodeHeaderStyle?: Unicode2BorderStyle;
  fieldSep: string;
  recordSep: string;
  numericLocale: boolean;
  tableAttr: string | null;
  title: string | null;
  footers: string[] | null;
  translateHeader: boolean;
  translateColumns: boolean[] | null;
  nullPrint: string;
  csvFieldSep: string;
  /**
   * `\pset xheader_width` — controls expanded-format header width. Upstream
   * stores this as `expanded_header_width_type` + `expanded_header_exact_width`;
   * we collapse to a single tagged value. Default `'full'`. Optional for
   * the same reason as `unicodeBorderStyle` — preserves the existing
   * literal-`topt` fixtures in `print/*`.
   */
  xheaderWidth?: XheaderWidth;
};

export type PrintQueryOpts = {
  topt: PrintTableOpts;
  nullPrint: string;
  title: string | null;
  footers: string[] | null;
  translateHeader: boolean;
  translateColumns: boolean[] | null;
  nTranslateColumns: number;
};

export type Printer = {
  format: OutputFormat;
  printQuery(
    rs: ResultSet,
    opts: PrintQueryOpts,
    out: NodeJS.WritableStream,
  ): Promise<void>;
};
