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
