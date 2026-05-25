/**
 * psql help text — TypeScript port of upstream `src/bin/psql/help.c`.
 *
 * Phase-0 (WP-18). The literal text matches PostgreSQL master; whitespace and
 * line breaks are load-bearing because output is compared against upstream
 * psql. Runtime-dependent fields (current DB name, format toggles, timing,
 * default field/CSV separators, etc.) are accepted via the optional `opts`
 * object so that callers can wire them in without this module reaching into
 * `pset` directly.
 *
 * `helpSQL` is stubbed — the SQL command help table is generated at psql
 * build time from `sql_help.c`/`sql_help.h` and is large enough to warrant a
 * dedicated work package.
 */

/** Default options shared by every help function. Mirrors upstream constants
 * (`DEFAULT_FIELD_SEP`, `DEFAULT_CSV_FIELD_SEP`, `DEFAULT_WATCH_INTERVAL`) and
 * exposes the few runtime values that `slashUsage` needs to render its
 * "currently …" annotations. */
export type HelpOpts = {
  /** Program name (upstream uses argv[0]; defaults to "psql"). */
  progname?: string;
  /** Default field separator for unaligned output. Upstream `DEFAULT_FIELD_SEP`. */
  defaultFieldSep?: string;
  /** Default CSV field separator. Upstream `DEFAULT_CSV_FIELD_SEP`. */
  defaultCsvFieldSep?: string;
  /** Default `\watch` interval. Upstream `DEFAULT_WATCH_INTERVAL`. */
  defaultWatchInterval?: string;
  /** PostgreSQL bug-report address. Upstream `PACKAGE_BUGREPORT`. */
  packageBugReport?: string;
  /** Package display name. Upstream `PACKAGE_NAME`. */
  packageName?: string;
  /** Package home page. Upstream `PACKAGE_URL`. */
  packageUrl?: string;
  /** Currently-connected database name (empty/undefined => no connection). */
  currentDb?: string | null;
  /** Whether HTML output mode is on (drives `\H` annotation). */
  htmlMode?: boolean;
  /** Whether tuples-only is on (drives `\t` annotation). */
  tuplesOnly?: boolean;
  /** Expanded output state: false=off, true=on, 'auto'=auto. */
  expanded?: boolean | 'auto';
  /** Whether timing of commands is on (drives `\timing` annotation). */
  timing?: boolean;
  /** Whether to emit Windows-flavoured env-var help (default: false). */
  win32?: boolean;
  /** Whether the binary was built with readline (drives `\s` line). */
  useReadline?: boolean;
};

const DEFAULTS: Required<HelpOpts> = {
  progname: 'psql',
  defaultFieldSep: '|',
  defaultCsvFieldSep: ',',
  defaultWatchInterval: '2',
  packageBugReport: 'pgsql-bugs@lists.postgresql.org',
  packageName: 'PostgreSQL',
  packageUrl: 'https://www.postgresql.org/',
  currentDb: null,
  htmlMode: false,
  tuplesOnly: false,
  expanded: false,
  timing: false,
  win32: false,
  useReadline: true,
};

const resolve = (opts: HelpOpts | undefined): Required<HelpOpts> => ({
  ...DEFAULTS,
  ...opts,
});

const on = (v: boolean): string => (v ? 'on' : 'off');

const expandedLabel = (v: boolean | 'auto'): string =>
  v === 'auto' ? 'auto' : on(v);

/**
 * `psql --help` text — top-level command-line options.
 *
 * TODO(WP-11): respect pager when output is interactive and exceeds screen
 * height. For now we just write the buffer to `out`.
 */
export const usage = (out: NodeJS.WritableStream, opts?: HelpOpts): void => {
  const o = resolve(opts);
  const buf: string[] = [];
  const w = (s: string): void => {
    buf.push(s);
  };

  w(`${o.progname} is the PostgreSQL interactive terminal.\n\n`);
  w('Usage:\n');
  w(`  ${o.progname} [OPTION]... [DBNAME [USERNAME]]\n\n`);

  w('General options:\n');
  w(
    '  -c, --command=COMMAND    run only single command (SQL or internal) and exit\n',
  );
  w('  -d, --dbname=DBNAME      database name to connect to\n');
  w('  -f, --file=FILENAME      execute commands from file, then exit\n');
  w('  -l, --list               list available databases, then exit\n');
  w(
    '  -v, --set=, --variable=NAME=VALUE\n' +
      '                           set psql variable NAME to VALUE\n' +
      '                           (e.g., -v ON_ERROR_STOP=1)\n',
  );
  w('  -V, --version            output version information, then exit\n');
  w('  -X, --no-psqlrc          do not read startup file (~/.psqlrc)\n');
  w(
    '  -1 ("one"), --single-transaction\n' +
      '                           execute as a single transaction (if non-interactive)\n',
  );
  w('  -?, --help[=options]     show this help, then exit\n');
  w('      --help=commands      list backslash commands, then exit\n');
  w('      --help=variables     list special variables, then exit\n');

  w('\nInput and output options:\n');
  w('  -a, --echo-all           echo all input from script\n');
  w('  -b, --echo-errors        echo failed commands\n');
  w('  -e, --echo-queries       echo commands sent to server\n');
  w(
    '  -E, --echo-hidden        display queries that internal commands generate\n',
  );
  w('  -L, --log-file=FILENAME  send session log to file\n');
  w(
    '  -n, --no-readline        disable enhanced command line editing (readline)\n',
  );
  w('  -o, --output=FILENAME    send query results to file (or |pipe)\n');
  w(
    '  -q, --quiet              run quietly (no messages, only query output)\n',
  );
  w('  -s, --single-step        single-step mode (confirm each query)\n');
  w(
    '  -S, --single-line        single-line mode (end of line terminates SQL command)\n',
  );

  w('\nOutput format options:\n');
  w('  -A, --no-align           unaligned table output mode\n');
  w(
    '      --csv                CSV (Comma-Separated Values) table output mode\n',
  );
  w(
    '  -F, --field-separator=STRING\n' +
      `                           field separator for unaligned output (default: "${o.defaultFieldSep}")\n`,
  );
  w('  -H, --html               HTML table output mode\n');
  w(
    '  -P, --pset=VAR[=ARG]     set printing option VAR to ARG (see \\pset command)\n',
  );
  w(
    '  -R, --record-separator=STRING\n' +
      '                           record separator for unaligned output (default: newline)\n',
  );
  w('  -t, --tuples-only        print rows only\n');
  w(
    '  -T, --table-attr=TEXT    set HTML table tag attributes (e.g., width, border)\n',
  );
  w('  -x, --expanded           turn on expanded table output\n');
  w(
    '  -z, --field-separator-zero\n' +
      '                           set field separator for unaligned output to zero byte\n',
  );
  w(
    '  -0, --record-separator-zero\n' +
      '                           set record separator for unaligned output to zero byte\n',
  );

  w('\nConnection options:\n');
  w('  -h, --host=HOSTNAME      database server host or socket directory\n');
  w('  -p, --port=PORT          database server port\n');
  w('  -U, --username=USERNAME  database user name\n');
  w('  -w, --no-password        never prompt for password\n');
  w(
    '  -W, --password           force password prompt (should happen automatically)\n',
  );

  w(
    '\nFor more information, type "\\?" (for internal commands) or "\\help" (for SQL\n' +
      'commands) from within psql, or consult the psql section in the PostgreSQL\n' +
      'documentation.\n\n',
  );
  w(`Report bugs to <${o.packageBugReport}>.\n`);
  w(`${o.packageName} home page: <${o.packageUrl}>\n`);

  out.write(buf.join(''));
};

/**
 * `\?` general output — help for the backslash commands.
 *
 * TODO(WP-11): when `pager` is true and output is interactive, route through
 * the pager. For Phase-0 we ignore `pager` and write straight to `out`.
 */
export const slashUsage = (
  out: NodeJS.WritableStream,
  pager: boolean,
  opts?: HelpOpts,
): void => {
  // pager is accepted for API compatibility; pager spawning is WP-11.
  void pager;

  const o = resolve(opts);
  const buf: string[] = [];
  const w = (s: string): void => {
    buf.push(s);
  };

  w('General\n');
  w('  \\copyright             show PostgreSQL usage and distribution terms\n');
  w(
    '  \\crosstabview [COLUMNS] execute query and display result in crosstab\n',
  );
  w(
    '  \\errverbose            show most recent error message at maximum verbosity\n',
  );
  w(
    '  \\g [(OPTIONS)] [FILE]  execute query (and send result to file or |pipe);\n' +
      '                         \\g with no arguments is equivalent to a semicolon\n',
  );
  w(
    '  \\gdesc                 describe result of query, without executing it\n',
  );
  w(
    '  \\gexec                 execute query, then execute each value in its result\n',
  );
  w(
    '  \\gset [PREFIX]         execute query and store result in psql variables\n',
  );
  w('  \\gx [(OPTIONS)] [FILE] as \\g, but forces expanded output mode\n');
  w('  \\q                     quit psql\n');
  w(
    '  \\restrict RESTRICT_KEY\n' +
      '                         enter restricted mode with provided key\n',
  );
  w(
    '  \\unrestrict RESTRICT_KEY\n' +
      '                         exit restricted mode if key matches\n',
  );
  w(
    '  \\watch [[i=]SEC] [c=N] [m=MIN]\n' +
      '                         execute query every SEC seconds, up to N times,\n' +
      '                         stop if less than MIN rows are returned\n',
  );
  w('\n');

  w('Help\n');

  w('  \\? [commands]          show help on backslash commands\n');
  w('  \\? options             show help on psql command-line options\n');
  w('  \\? variables           show help on special variables\n');
  w(
    '  \\h [NAME]              help on syntax of SQL commands, * for all commands\n',
  );
  w('\n');

  w('Query Buffer\n');
  w(
    '  \\e [FILE] [LINE]       edit the query buffer (or file) with external editor\n',
  );
  w(
    '  \\ef [FUNCNAME [LINE]]  edit function definition with external editor\n',
  );
  w('  \\ev [VIEWNAME [LINE]]  edit view definition with external editor\n');
  w('  \\p                     show the contents of the query buffer\n');
  w('  \\r                     reset (clear) the query buffer\n');
  if (o.useReadline) {
    w('  \\s [FILE]              display history or save it to file\n');
  }
  w('  \\w FILE                write query buffer to file\n');
  w('\n');

  w('Input/Output\n');
  w(
    '  \\copy ...              perform SQL COPY with data stream to the client host\n',
  );
  w(
    '  \\echo [-n] [STRING]    write string to standard output (-n for no newline)\n',
  );
  w('  \\i FILE                execute commands from file\n');
  w(
    '  \\ir FILE               as \\i, but relative to location of current script\n',
  );
  w('  \\o [FILE]              send all query results to file or |pipe\n');
  w(
    '  \\qecho [-n] [STRING]   write string to \\o output stream (-n for no newline)\n',
  );
  w(
    '  \\warn [-n] [STRING]    write string to standard error (-n for no newline)\n',
  );
  w('\n');

  w('Conditional\n');
  w('  \\if EXPR               begin conditional block\n');
  w('  \\elif EXPR             alternative within current conditional block\n');
  w(
    '  \\else                  final alternative within current conditional block\n',
  );
  w('  \\endif                 end conditional block\n');
  w('\n');

  w('Informational\n');
  w(
    '  (options: S = show system objects, x = expanded mode, + = additional detail)\n',
  );
  w(
    '  \\d[Sx+]                list tables, views, sequences, and property graphs\n',
  );
  w(
    '  \\d[S+]   NAME          describe table, view, sequence, index, or property graph\n',
  );
  w('  \\da[Sx]  [PATTERN]     list aggregates\n');
  w('  \\dA[x+]  [PATTERN]     list access methods\n');
  w('  \\dAc[x+] [AMPTRN [TYPEPTRN]]  list operator classes\n');
  w('  \\dAf[x+] [AMPTRN [TYPEPTRN]]  list operator families\n');
  w('  \\dAo[x+] [AMPTRN [OPFPTRN]]   list operators of operator families\n');
  w(
    '  \\dAp[x+] [AMPTRN [OPFPTRN]]   list support functions of operator families\n',
  );
  w('  \\db[x+]  [PATTERN]     list tablespaces\n');
  w('  \\dc[Sx+] [PATTERN]     list conversions\n');
  w('  \\dconfig[x+] [PATTERN] list configuration parameters\n');
  w('  \\dC[x+]  [PATTERN]     list casts\n');
  w(
    '  \\dd[Sx]  [PATTERN]     show object descriptions not displayed elsewhere\n',
  );
  w('  \\dD[Sx+] [PATTERN]     list domains\n');
  w('  \\ddp[x]  [PATTERN]     list default privileges\n');
  w('  \\dE[Sx+] [PATTERN]     list foreign tables\n');
  w('  \\des[x+] [PATTERN]     list foreign servers\n');
  w('  \\det[x+] [PATTERN]     list foreign tables\n');
  w('  \\deu[x+] [PATTERN]     list user mappings\n');
  w('  \\dew[x+] [PATTERN]     list foreign-data wrappers\n');
  w(
    '  \\df[anptw][Sx+] [FUNCPTRN [TYPEPTRN ...]]\n' +
      '                         list [only agg/normal/procedure/trigger/window] functions\n',
  );
  w('  \\dF[x+]  [PATTERN]     list text search configurations\n');
  w('  \\dFd[x+] [PATTERN]     list text search dictionaries\n');
  w('  \\dFp[x+] [PATTERN]     list text search parsers\n');
  w('  \\dFt[x+] [PATTERN]     list text search templates\n');
  w('  \\dg[Sx+] [PATTERN]     list roles\n');
  w('  \\dG[Sx+] [PATTERN]     list property graphs\n');
  w('  \\di[Sx+] [PATTERN]     list indexes\n');
  w('  \\dl[x+]                list large objects, same as \\lo_list\n');
  w('  \\dL[Sx+] [PATTERN]     list procedural languages\n');
  w('  \\dm[Sx+] [PATTERN]     list materialized views\n');
  w('  \\dn[Sx+] [PATTERN]     list schemas\n');
  w(
    '  \\do[Sx+] [OPPTRN [TYPEPTRN [TYPEPTRN]]]\n' +
      '                         list operators\n',
  );
  w('  \\dO[Sx+] [PATTERN]     list collations\n');
  w(
    '  \\dp[Sx]  [PATTERN]     list table, view, and sequence access privileges\n',
  );
  w(
    '  \\dP[itnx+] [PATTERN]   list [only index/table] partitioned relations [n=nested]\n',
  );
  w(
    '  \\drds[x] [ROLEPTRN [DBPTRN]]\n' +
      '                         list per-database role settings\n',
  );
  w('  \\drg[Sx] [PATTERN]     list role grants\n');
  w('  \\dRp[x+] [PATTERN]     list replication publications\n');
  w('  \\dRs[x+] [PATTERN]     list replication subscriptions\n');
  w('  \\ds[Sx+] [PATTERN]     list sequences\n');
  w('  \\dt[Sx+] [PATTERN]     list tables\n');
  w('  \\dT[Sx+] [PATTERN]     list data types\n');
  w('  \\du[Sx+] [PATTERN]     list roles\n');
  w('  \\dv[Sx+] [PATTERN]     list views\n');
  w('  \\dx[x+]  [PATTERN]     list extensions\n');
  w('  \\dX[x+]  [PATTERN]     list extended statistics\n');
  w('  \\dy[x+]  [PATTERN]     list event triggers\n');
  w('  \\l[x+]   [PATTERN]     list databases\n');
  w("  \\sf[+]   FUNCNAME      show a function's definition\n");
  w("  \\sv[+]   VIEWNAME      show a view's definition\n");
  w('  \\z[Sx]   [PATTERN]     same as \\dp\n');
  w('\n');

  w('Large Objects\n');
  w('  \\lo_export LOBOID FILE write large object to file\n');
  w(
    '  \\lo_import FILE [COMMENT]\n' +
      '                         read large object from file\n',
  );
  w('  \\lo_list[x+]           list large objects\n');
  w('  \\lo_unlink LOBOID      delete a large object\n');
  w('\n');

  w('Formatting\n');
  w(
    '  \\a                     toggle between unaligned and aligned output mode\n',
  );
  w('  \\C [STRING]            set table title, or unset if none\n');
  w(
    '  \\f [STRING]            show or set field separator for unaligned query output\n',
  );
  w(
    `  \\H                     toggle HTML output mode (currently ${on(o.htmlMode)})\n`,
  );
  w(
    '  \\pset [NAME [VALUE]]   set table output option\n' +
      '                         see "\\? variables" for valid options\n',
  );
  w(
    `  \\t [on|off]            show only rows (currently ${on(o.tuplesOnly)})\n`,
  );
  w(
    '  \\T [STRING]            set HTML <table> tag attributes, or unset if none\n',
  );
  w(
    `  \\x [on|off|auto]       toggle expanded output (currently ${expandedLabel(o.expanded)})\n`,
  );
  w('\n');

  w('Connection\n');
  if (o.currentDb) {
    w(
      '  \\c[onnect] {[DBNAME|- USER|- HOST|- PORT|-] | conninfo}\n' +
        `                         connect to new database (currently "${o.currentDb}")\n`,
    );
  } else {
    w(
      '  \\c[onnect] {[DBNAME|- USER|- HOST|- PORT|-] | conninfo}\n' +
        '                         connect to new database (currently no connection)\n',
    );
  }
  w('  \\conninfo              display information about current connection\n');
  w('  \\encoding [ENCODING]   show or set client encoding\n');
  w('  \\password [USERNAME]   securely change the password for a user\n');
  w('\n');

  w('Operating System\n');
  w('  \\cd [DIR]              change the current working directory\n');
  w('  \\getenv PSQLVAR ENVVAR fetch environment variable\n');
  w('  \\setenv NAME [VALUE]   set or unset environment variable\n');
  w(
    `  \\timing [on|off]       toggle timing of commands (currently ${on(o.timing)})\n`,
  );
  w(
    '  \\! [COMMAND]           execute command in shell or start interactive shell\n',
  );
  w('\n');

  w('Variables\n');
  w('  \\prompt [TEXT] NAME    prompt user to set internal variable\n');
  w(
    '  \\set [NAME [VALUE]]    set internal variable, or list all if no parameters\n',
  );
  w('  \\unset NAME            unset (delete) internal variable\n');
  w('\n');

  w('Extended Query Protocol\n');
  w('  \\bind [PARAM]...       set query parameters\n');
  w(
    '  \\bind_named STMT_NAME [PARAM]...\n' +
      '                         set query parameters for an existing prepared statement\n',
  );
  w(
    '  \\close_prepared STMT_NAME\n' +
      '                         close an existing prepared statement\n',
  );
  w('  \\endpipeline           exit pipeline mode\n');
  w('  \\flush                 flush output data to the server\n');
  w(
    '  \\flushrequest          send request to the server to flush its output buffer\n',
  );
  w(
    '  \\getresults [NUM_RES]  read NUM_RES pending results, or all if no argument\n',
  );
  w('  \\parse STMT_NAME       create a prepared statement\n');
  w(
    '  \\sendpipeline          send an extended query to an ongoing pipeline\n',
  );
  w('  \\startpipeline         enter pipeline mode\n');
  w(
    '  \\syncpipeline          add a synchronisation point to an ongoing pipeline\n',
  );

  out.write(buf.join(''));
};

/**
 * `\?` with a topic argument. Routes to the appropriate help renderer:
 *   - `commands`  → `slashUsage` (backslash commands)
 *   - `options`   → `usage` (CLI options)
 *   - `variables` → `helpVariables`
 */
export const slashUsageHelp = (
  out: NodeJS.WritableStream,
  topic: 'commands' | 'options' | 'variables',
  opts?: HelpOpts,
): void => {
  switch (topic) {
    case 'commands':
      slashUsage(out, false, opts);
      return;
    case 'options':
      usage(out, opts);
      return;
    case 'variables':
      helpVariables(out, opts);
      return;
  }
};

/**
 * `\? variables` output — list of specially treated psql variables, display
 * settings, and environment variables.
 */
export const helpVariables = (
  out: NodeJS.WritableStream,
  opts?: HelpOpts,
): void => {
  const o = resolve(opts);
  const buf: string[] = [];
  const w = (s: string): void => {
    buf.push(s);
  };

  w('List of specially treated variables\n\n');

  w('psql variables:\n');
  w('Usage:\n');
  w(`  ${o.progname} --set=NAME=VALUE\n  or \\set NAME VALUE inside psql\n\n`);

  w(
    '  AUTOCOMMIT\n' +
      '    if set, successful SQL commands are automatically committed\n',
  );
  w(
    '  COMP_KEYWORD_CASE\n' +
      '    determines the case used to complete SQL key words\n' +
      '    [lower, upper, preserve-lower, preserve-upper]\n',
  );
  w('  DBNAME\n    the currently connected database name\n');
  w(
    '  ECHO\n' +
      '    controls what input is written to standard output\n' +
      '    [all, errors, none, queries]\n',
  );
  w(
    '  ECHO_HIDDEN\n' +
      '    if set, display internal queries executed by backslash commands;\n' +
      '    if set to "noexec", just show them without execution\n',
  );
  w('  ENCODING\n    current client character set encoding\n');
  w('  ERROR\n    "true" if last query failed, else "false"\n');
  w(
    '  FETCH_COUNT\n' +
      '    the number of result rows to fetch and display at a time (0 = unlimited)\n',
  );
  w('  HIDE_TABLEAM\n    if set, table access methods are not displayed\n');
  w(
    '  HIDE_TOAST_COMPRESSION\n' +
      '    if set, compression methods are not displayed\n',
  );
  w(
    '  HISTCONTROL\n' +
      '    controls command history [ignorespace, ignoredups, ignoreboth]\n',
  );
  w('  HISTFILE\n    file name used to store the command history\n');
  w(
    '  HISTSIZE\n' +
      '    maximum number of commands to store in the command history\n',
  );
  w('  HOST\n    the currently connected database server host\n');
  w(
    '  IGNOREEOF\n' +
      '    number of EOFs needed to terminate an interactive session\n',
  );
  w('  LASTOID\n    value of the last affected OID\n');
  w(
    '  LAST_ERROR_MESSAGE\n' +
      '  LAST_ERROR_SQLSTATE\n' +
      '    message and SQLSTATE of last error, or empty string and "00000" if none\n',
  );
  w(
    '  ON_ERROR_ROLLBACK\n' +
      "    if set, an error doesn't stop a transaction (uses implicit savepoints)\n",
  );
  w('  ON_ERROR_STOP\n    stop batch execution after error\n');
  w('  PORT\n    server port of the current connection\n');
  w('  PROMPT1\n    specifies the standard psql prompt\n');
  w(
    '  PROMPT2\n' +
      '    specifies the prompt used when a statement continues from a previous line\n',
  );
  w('  PROMPT3\n    specifies the prompt used during COPY ... FROM STDIN\n');
  w('  QUIET\n    run quietly (same as -q option)\n');
  w(
    '  ROW_COUNT\n' +
      '    number of rows returned or affected by last query, or 0\n',
  );
  w(
    '  SERVER_VERSION_NAME\n' +
      '  SERVER_VERSION_NUM\n' +
      "    server's version (in short string or numeric format)\n",
  );
  w(
    '  SHELL_ERROR\n' +
      '    "true" if the last shell command failed, "false" if it succeeded\n',
  );
  w('  SHELL_EXIT_CODE\n    exit status of the last shell command\n');
  w(
    '  SHOW_ALL_RESULTS\n' +
      '    show all results of a combined query (\\;) instead of only the last\n',
  );
  w(
    '  SHOW_CONTEXT\n' +
      '    controls display of message context fields [never, errors, always]\n',
  );
  w(
    '  SINGLELINE\n' +
      '    if set, end of line terminates SQL commands (same as -S option)\n',
  );
  w('  SINGLESTEP\n    single-step mode (same as -s option)\n');
  w('  SQLSTATE\n    SQLSTATE of last query, or "00000" if no error\n');
  w('  USER\n    the currently connected database user\n');
  w(
    '  VERBOSITY\n' +
      '    controls verbosity of error reports [default, verbose, terse, sqlstate]\n',
  );
  w(
    '  VERSION\n' +
      '  VERSION_NAME\n' +
      '  VERSION_NUM\n' +
      "    psql's version (in verbose string, short string, or numeric format)\n",
  );
  w(
    '  WATCH_INTERVAL\n' +
      `    number of seconds \\watch waits between executions (default ${o.defaultWatchInterval})\n`,
  );

  w('\nDisplay settings:\n');
  w('Usage:\n');
  w(
    `  ${o.progname} --pset=NAME[=VALUE]\n  or \\pset NAME [VALUE] inside psql\n\n`,
  );

  w('  border\n    border style (number)\n');
  w('  columns\n    target width for the wrapped format\n');
  w(
    '  csv_fieldsep\n' +
      `    field separator for CSV output format (default "${o.defaultCsvFieldSep}")\n`,
  );
  w(
    '  display_false\n' +
      "    set the string to be printed in place of a boolean 'false'\n",
  );
  w(
    '  display_true\n' +
      "    set the string to be printed in place of a boolean 'true'\n",
  );
  w('  expanded (or x)\n    expanded output [on, off, auto]\n');
  w(
    '  fieldsep\n' +
      `    field separator for unaligned output (default "${o.defaultFieldSep}")\n`,
  );
  w(
    '  fieldsep_zero\n' +
      '    set field separator for unaligned output to a zero byte\n',
  );
  w(
    '  footer\n' +
      '    enable or disable display of the table footer [on, off]\n',
  );
  w(
    '  format\n' +
      '    set output format [unaligned, aligned, wrapped, html, asciidoc, ...]\n',
  );
  w(
    '  linestyle\n' +
      '    set the border line drawing style [ascii, old-ascii, unicode]\n',
  );
  w('  null\n    set the string to be printed in place of a null value\n');
  w(
    '  numericlocale\n' +
      '    enable display of a locale-specific character to separate groups of digits\n',
  );
  w(
    '  pager\n' +
      '    control when an external pager is used [yes, no, always]\n',
  );
  w('  recordsep\n    record (line) separator for unaligned output\n');
  w(
    '  recordsep_zero\n' +
      '    set record separator for unaligned output to a zero byte\n',
  );
  w(
    '  tableattr (or T)\n' +
      '    specify attributes for table tag in html format, or proportional\n' +
      '    column widths for left-aligned data types in latex-longtable format\n',
  );
  w('  title\n    set the table title for subsequently printed tables\n');
  w('  tuples_only\n    if set, only actual table data is shown\n');
  w(
    '  unicode_border_linestyle\n' +
      '  unicode_column_linestyle\n' +
      '  unicode_header_linestyle\n' +
      '    set the style of Unicode line drawing [single, double]\n',
  );
  w(
    '  xheader_width\n' +
      '    set the maximum width of the header for expanded output\n' +
      '    [full, column, page, integer value]\n',
  );

  w('\nEnvironment variables:\n');
  w('Usage:\n');

  if (!o.win32) {
    w(
      `  NAME=VALUE [NAME=VALUE] ${o.progname} ...\n  or \\setenv NAME [VALUE] inside psql\n\n`,
    );
  } else {
    w(
      `  set NAME=VALUE\n  ${o.progname} ...\n  or \\setenv NAME [VALUE] inside psql\n\n`,
    );
  }

  w('  COLUMNS\n    number of columns for wrapped format\n');
  w('  PGAPPNAME\n    same as the application_name connection parameter\n');
  w('  PGDATABASE\n    same as the dbname connection parameter\n');
  w('  PGHOST\n    same as the host connection parameter\n');
  w('  PGPASSFILE\n    password file name\n');
  w('  PGPASSWORD\n    connection password (not recommended)\n');
  w('  PGPORT\n    same as the port connection parameter\n');
  w('  PGUSER\n    same as the user connection parameter\n');
  w(
    '  PSQL_EDITOR, EDITOR, VISUAL\n' +
      '    editor used by the \\e, \\ef, and \\ev commands\n',
  );
  w(
    '  PSQL_EDITOR_LINENUMBER_ARG\n' +
      '    how to specify a line number when invoking the editor\n',
  );
  w(
    '  PSQL_HISTORY\n' +
      '    alternative location for the command history file\n',
  );
  w('  PSQL_PAGER, PAGER\n    name of external pager program\n');
  if (!o.win32) {
    w(
      '  PSQL_WATCH_PAGER\n' +
        '    name of external pager program used for \\watch\n',
    );
  }
  w("  PSQLRC\n    alternative location for the user's .psqlrc file\n");
  w('  SHELL\n    shell used by the \\! command\n');
  w('  TMPDIR\n    directory for temporary files\n');

  out.write(buf.join(''));
};

/**
 * `\h` SQL command help.
 *
 * TODO(WP-future): port the SQL command help table from upstream
 * `src/bin/psql/sql_help.c` / `sql_help.h`. The table is generated at psql
 * build time from the SGML documentation and is large (~hundreds of
 * commands). For Phase-0 this is a stub.
 *
 * @param out         output stream
 * @param topic       SQL command name (e.g. "SELECT"), or null/empty for the
 *                    "available help" overview
 * @param screenWidth column count, used by upstream for the multi-column
 *                    layout of the overview list
 */
export const helpSQL = (
  out: NodeJS.WritableStream,
  topic: string | null,
  screenWidth: number,
): void => {
  // Suppress unused-param warnings; the parameters describe the future API.
  void screenWidth;

  if (!topic || topic.length === 0) {
    out.write(
      'Available help:\n' +
        '  (SQL command help is not yet implemented in the embedded TypeScript psql.)\n',
    );
    return;
  }

  out.write(
    `No help available for "${topic}".\n` +
      'Try \\h with no arguments to see available help.\n',
  );
};
