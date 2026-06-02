import { describe, expect, test } from 'vitest';

import { applyStartupArgs, parseStartupArgs } from './startup.js';
import type { ParsedArgs, ParseError } from './startup.js';
import { createVarStore } from './variables.js';
import { defaultSettings } from './settings.js';
import type { ConnectOptions } from '../types/connection.js';

const ok = (r: ParsedArgs | ParseError): ParsedArgs => {
  if ('kind' in r) {
    throw new Error(`expected ParsedArgs, got error: ${r.message}`);
  }
  return r;
};

const err = (r: ParsedArgs | ParseError): ParseError => {
  if (!('kind' in r)) {
    throw new Error('expected ParseError, got ParsedArgs');
  }
  return r;
};

describe('parseStartupArgs — actions', () => {
  test('-c "SELECT 1" appends a command action', () => {
    const a = ok(parseStartupArgs(['-c', 'SELECT 1']));
    expect(a.actions).toEqual([{ kind: 'command', sql: 'SELECT 1' }]);
  });

  test('--command=SQL appends a command action', () => {
    const a = ok(parseStartupArgs(['--command=SELECT 2']));
    expect(a.actions).toEqual([{ kind: 'command', sql: 'SELECT 2' }]);
  });

  test('-f and -c preserve order', () => {
    const a = ok(parseStartupArgs(['-f', 'a.sql', '-c', 'b']));
    expect(a.actions).toEqual([
      { kind: 'file', path: 'a.sql' },
      { kind: 'command', sql: 'b' },
    ]);
  });

  test('multiple -c -f -c interleave in order', () => {
    const a = ok(parseStartupArgs(['-c', 'A', '-f', 'b.sql', '-c', 'C']));
    expect(a.actions).toEqual([
      { kind: 'command', sql: 'A' },
      { kind: 'file', path: 'b.sql' },
      { kind: 'command', sql: 'C' },
    ]);
  });

  test('--file=path appends a file action', () => {
    const a = ok(parseStartupArgs(['--file=script.sql']));
    expect(a.actions).toEqual([{ kind: 'file', path: 'script.sql' }]);
  });
});

describe('parseStartupArgs — connection target', () => {
  test('--host / -p / -U / DBNAME positional', () => {
    const a = ok(
      parseStartupArgs(['--host', 'foo', '-p', '5433', '-U', 'me', 'mydb']),
    );
    expect(a.host).toBe('foo');
    expect(a.port).toBe(5433);
    expect(a.user).toBe('me');
    expect(a.positional).toEqual(['mydb']);
  });

  test('-d DBNAME overrides positional', () => {
    const a = ok(parseStartupArgs(['-d', 'explicit', 'fromPositional']));
    expect(a.database).toBe('explicit');
    expect(a.positional).toEqual(['fromPositional']);
  });

  test('-w sets promptPassword=false; -W sets promptPassword=true', () => {
    expect(ok(parseStartupArgs(['-w'])).promptPassword).toBe(false);
    expect(ok(parseStartupArgs(['-W'])).promptPassword).toBe(true);
  });

  test('long-form --username and --port and --dbname work', () => {
    const a = ok(
      parseStartupArgs(['--username', 'alice', '--port=6543', '--dbname=db1']),
    );
    expect(a.user).toBe('alice');
    expect(a.port).toBe(6543);
    expect(a.database).toBe('db1');
  });

  test('invalid port returns invalid-value error', () => {
    const e = err(parseStartupArgs(['-p', 'not-a-port']));
    expect(e.kind).toBe('invalid-value');
  });

  test('port out of range returns invalid-value', () => {
    expect(err(parseStartupArgs(['-p', '0'])).kind).toBe('invalid-value');
    expect(err(parseStartupArgs(['-p', '70000'])).kind).toBe('invalid-value');
  });
});

describe('parseStartupArgs — variables', () => {
  test('-v NAME=VAL and --set NAME=VAL aggregate in order', () => {
    const a = ok(parseStartupArgs(['-v', 'X=1', '--set', 'Y=2']));
    expect(a.variables).toEqual([
      { name: 'X', value: '1' },
      { name: 'Y', value: '2' },
    ]);
  });

  test('--variable=NAME=VALUE works (long with `=`)', () => {
    const a = ok(parseStartupArgs(['--variable=Z=3']));
    expect(a.variables).toEqual([{ name: 'Z', value: '3' }]);
  });

  test('-v NAME without value emits empty (delete)', () => {
    const a = ok(parseStartupArgs(['-v', 'FOO']));
    expect(a.variables).toEqual([{ name: 'FOO', value: '' }]);
  });

  test('--on-error-stop also sets ON_ERROR_STOP variable', () => {
    const a = ok(parseStartupArgs(['--on-error-stop']));
    expect(a.onErrorStop).toBe(true);
    expect(a.variables.some((v) => v.name === 'ON_ERROR_STOP')).toBe(true);
  });
});

describe('parseStartupArgs — formatting flags', () => {
  test('-A -t --csv -x flags combine', () => {
    const a = ok(parseStartupArgs(['-A', '-t', '--csv', '-x']));
    expect(a.noAlign).toBe(true);
    expect(a.tuplesOnly).toBe(true);
    expect(a.csvOutput).toBe(true);
    expect(a.expanded).toBe(true);
  });

  test('-H sets htmlMode', () => {
    expect(ok(parseStartupArgs(['-H'])).htmlMode).toBe(true);
  });

  test('-q --quiet sets quiet', () => {
    expect(ok(parseStartupArgs(['-q'])).quiet).toBe(true);
    expect(ok(parseStartupArgs(['--quiet'])).quiet).toBe(true);
  });

  test('-a echoAll', () => {
    expect(ok(parseStartupArgs(['-a'])).echoAll).toBe(true);
  });

  test('-e --echo-queries', () => {
    expect(ok(parseStartupArgs(['-e'])).echoQueries).toBe(true);
    expect(ok(parseStartupArgs(['--echo-queries'])).echoQueries).toBe(true);
  });

  test('-E echoHidden on; --echo-hidden=noexec sets noexec', () => {
    expect(ok(parseStartupArgs(['-E'])).echoHidden).toBe('on');
    expect(ok(parseStartupArgs(['--echo-hidden=noexec'])).echoHidden).toBe(
      'noexec',
    );
    expect(ok(parseStartupArgs(['--echo-hidden'])).echoHidden).toBe('on');
  });

  test('-F sets fieldSep; -R sets recordSep', () => {
    const a = ok(parseStartupArgs(['-F', ',', '-R', '|']));
    expect(a.fieldSep).toBe(',');
    expect(a.recordSep).toBe('|');
  });

  test('-z fieldSepZero and -0 recordSepZero', () => {
    const a = ok(parseStartupArgs(['-z', '-0']));
    expect(a.fieldSepZero).toBe(true);
    expect(a.recordSepZero).toBe(true);
  });

  test('-P NAME=VAL accumulates raw pset directives', () => {
    const a = ok(parseStartupArgs(['-P', 'format=html', '-P', 'border=2']));
    expect(a.pset).toEqual(['format=html', 'border=2']);
  });

  test('-T TEXT pushes tableattr through pset', () => {
    const a = ok(parseStartupArgs(['-T', 'class="t"']));
    expect(a.pset).toEqual(['tableattr=class="t"']);
  });

  test('--no-pager sets noPager', () => {
    expect(ok(parseStartupArgs(['--no-pager'])).noPager).toBe(true);
  });
});

describe('parseStartupArgs — psqlrc and friends', () => {
  test('-X sets noPsqlrc', () => {
    expect(ok(parseStartupArgs(['-X'])).noPsqlrc).toBe(true);
  });

  test('--no-psqlrc sets noPsqlrc', () => {
    expect(ok(parseStartupArgs(['--no-psqlrc'])).noPsqlrc).toBe(true);
  });

  test('-n sets noReadline', () => {
    expect(ok(parseStartupArgs(['-n'])).noReadline).toBe(true);
  });

  test('-l sets list', () => {
    expect(ok(parseStartupArgs(['-l'])).list).toBe(true);
  });

  test('-1 single-transaction', () => {
    expect(ok(parseStartupArgs(['-1'])).singleTransaction).toBe(true);
  });
});

describe('parseStartupArgs — help / version', () => {
  test('-V returns version sentinel', () => {
    const e = err(parseStartupArgs(['-V']));
    expect(e.kind).toBe('version');
    expect(e.message).toMatch(/psql/);
  });

  test('--version returns version sentinel', () => {
    const e = err(parseStartupArgs(['--version']));
    expect(e.kind).toBe('version');
  });

  test('--help renders top-level usage', () => {
    const e = err(parseStartupArgs(['--help']));
    expect(e.kind).toBe('help');
    expect(e.message).toMatch(/Usage/);
  });

  test('--help=commands renders backslash help', () => {
    const e = err(parseStartupArgs(['--help=commands']));
    expect(e.kind).toBe('help');
    expect(e.message).toMatch(/copyright/);
  });

  test('--help=variables renders variables help', () => {
    const e = err(parseStartupArgs(['--help=variables']));
    expect(e.kind).toBe('help');
    expect(e.message).toMatch(/AUTOCOMMIT/);
  });

  test('-? renders top-level usage', () => {
    const e = err(parseStartupArgs(['-?']));
    expect(e.kind).toBe('help');
  });

  test('--help=garbage returns invalid-option', () => {
    const e = err(parseStartupArgs(['--help=garbage']));
    expect(e.kind).toBe('invalid-option');
  });
});

describe('parseStartupArgs — errors', () => {
  test('--bogus returns invalid-option', () => {
    const e = err(parseStartupArgs(['--bogus']));
    expect(e.kind).toBe('invalid-option');
    expect(e.message).toMatch(/bogus/);
  });

  test('-c with no value returns missing-arg', () => {
    const e = err(parseStartupArgs(['-c']));
    expect(e.kind).toBe('missing-arg');
  });

  test('--command without value returns missing-arg', () => {
    const e = err(parseStartupArgs(['--command']));
    expect(e.kind).toBe('missing-arg');
  });

  test('--csv=value is rejected', () => {
    expect(err(parseStartupArgs(['--csv=yes'])).kind).toBe('invalid-option');
  });

  test('unknown short letter returns invalid-option', () => {
    const e = err(parseStartupArgs(['-Q']));
    expect(e.kind).toBe('invalid-option');
  });
});

describe('parseStartupArgs — edge cases', () => {
  test('empty argv produces empty parsed shape', () => {
    const a = ok(parseStartupArgs([]));
    expect(a.actions).toEqual([]);
    expect(a.variables).toEqual([]);
    expect(a.positional).toEqual([]);
    expect(a.echoAll).toBe(false);
    expect(a.noPsqlrc).toBe(false);
  });

  test('-- ends option parsing', () => {
    const a = ok(parseStartupArgs(['--', '-c', 'not-a-flag']));
    expect(a.actions).toEqual([]);
    expect(a.positional).toEqual(['-c', 'not-a-flag']);
  });

  test('clustered short flags -aA work', () => {
    const a = ok(parseStartupArgs(['-aA']));
    expect(a.echoAll).toBe(true);
    expect(a.noAlign).toBe(true);
  });

  test('clustered short with value: -hfoo', () => {
    const a = ok(parseStartupArgs(['-hfoo']));
    expect(a.host).toBe('foo');
  });

  test('two positionals: dbname and username', () => {
    const a = ok(parseStartupArgs(['dbname1', 'user1']));
    expect(a.positional).toEqual(['dbname1', 'user1']);
  });

  test('-C is accepted as a no-op', () => {
    const a = ok(parseStartupArgs(['-C']));
    expect(a).toBeDefined();
  });

  test('-c with backslash command preserved', () => {
    // psql converts leading "\" into ACT_SINGLE_SLASH; we keep it as a
    // command action with the leading backslash. The dispatch layer handles
    // routing in WP-26 integration.
    const a = ok(parseStartupArgs(['-c', '\\dt']));
    expect(a.actions).toEqual([{ kind: 'command', sql: '\\dt' }]);
  });
});

describe('applyStartupArgs', () => {
  const buildBaseSettings = (): ReturnType<typeof defaultSettings> => {
    const v = createVarStore();
    return defaultSettings(v);
  };
  const baseConn: ConnectOptions = {
    host: 'localhost',
    port: 5432,
    user: 'pg',
    database: 'postgres',
    ssl: 'prefer',
  };

  test('connection overrides apply', () => {
    const parsed = ok(
      parseStartupArgs(['-h', 'remote', '-p', '6543', '-U', 'me', 'maindb']),
    );
    const settings = buildBaseSettings();
    const { connect } = applyStartupArgs(parsed, settings, baseConn);
    expect(connect.host).toBe('remote');
    expect(connect.port).toBe(6543);
    expect(connect.user).toBe('me');
    expect(connect.database).toBe('maindb');
  });

  test('seeds the constant client VERSION vars', () => {
    const parsed = ok(parseStartupArgs([]));
    const settings = buildBaseSettings();
    applyStartupArgs(parsed, settings, baseConn);
    expect(settings.vars.get('VERSION')).toMatch(/^psql-ts \(neonctl\) /);
    expect(settings.vars.get('VERSION_NAME')).toMatch(/^\d+\.\d+\.\d+$/);
    expect(settings.vars.get('VERSION_NUM')).toMatch(/^\d+$/);
  });

  test('a user -v VERSION override wins over the startup default', () => {
    const parsed = ok(parseStartupArgs(['-v', 'VERSION=custom']));
    const settings = buildBaseSettings();
    applyStartupArgs(parsed, settings, baseConn);
    expect(settings.vars.get('VERSION')).toBe('custom');
  });

  test('variables flow into vars store', () => {
    const parsed = ok(parseStartupArgs(['-v', 'X=hi', '-v', 'PROMPT1=mine ']));
    const settings = buildBaseSettings();
    applyStartupArgs(parsed, settings, baseConn);
    expect(settings.vars.get('X')).toBe('hi');
    // PROMPT1 trips the registered hook.
    expect(settings.prompt1).toBe('mine ');
  });

  test('-q sets settings.quiet', () => {
    const parsed = ok(parseStartupArgs(['-q']));
    const settings = buildBaseSettings();
    applyStartupArgs(parsed, settings, baseConn);
    expect(settings.quiet).toBe(true);
  });

  test('--csv flips format', () => {
    const parsed = ok(parseStartupArgs(['--csv']));
    const settings = buildBaseSettings();
    applyStartupArgs(parsed, settings, baseConn);
    expect(settings.popt.topt.format).toBe('csv');
  });

  test('-A flips format to unaligned', () => {
    const parsed = ok(parseStartupArgs(['-A']));
    const settings = buildBaseSettings();
    applyStartupArgs(parsed, settings, baseConn);
    expect(settings.popt.topt.format).toBe('unaligned');
  });

  test('-t flips tuplesOnly', () => {
    const parsed = ok(parseStartupArgs(['-t']));
    const settings = buildBaseSettings();
    applyStartupArgs(parsed, settings, baseConn);
    expect(settings.popt.topt.tuplesOnly).toBe(true);
  });

  test('-x flips expanded on', () => {
    const parsed = ok(parseStartupArgs(['-x']));
    const settings = buildBaseSettings();
    applyStartupArgs(parsed, settings, baseConn);
    expect(settings.popt.topt.expanded).toBe('on');
  });

  test('--on-error-stop flips onErrorStop', () => {
    const parsed = ok(parseStartupArgs(['--on-error-stop']));
    const settings = buildBaseSettings();
    applyStartupArgs(parsed, settings, baseConn);
    expect(settings.onErrorStop).toBe(true);
  });

  test('preActions reflect -c/-f order', () => {
    const parsed = ok(parseStartupArgs(['-f', 'a.sql', '-c', 'b']));
    const settings = buildBaseSettings();
    const { preActions } = applyStartupArgs(parsed, settings, baseConn);
    expect(preActions).toEqual([
      { kind: 'file', path: 'a.sql' },
      { kind: 'command', sql: 'b' },
    ]);
  });

  test('-T pushes through to tableAttr', () => {
    const parsed = ok(parseStartupArgs(['-T', 'class="x"']));
    const settings = buildBaseSettings();
    applyStartupArgs(parsed, settings, baseConn);
    expect(settings.popt.topt.tableAttr).toBe('class="x"');
  });

  test('-F sets fieldSep on print opts', () => {
    const parsed = ok(parseStartupArgs(['-F', ';']));
    const settings = buildBaseSettings();
    applyStartupArgs(parsed, settings, baseConn);
    expect(settings.popt.topt.fieldSep).toBe(';');
  });

  test('positional[1] is user when -U not set', () => {
    const parsed = ok(parseStartupArgs(['mydb', 'alice']));
    const settings = buildBaseSettings();
    const { connect } = applyStartupArgs(parsed, settings, baseConn);
    expect(connect.database).toBe('mydb');
    expect(connect.user).toBe('alice');
  });
});

// ---------------------------------------------------------------------------
// Layered resolution: env vars + pgpass + pg_service.conf.
//
// These exercise the new `resolution` parameter to `applyStartupArgs`, which
// activates the vanilla-psql connection-lookup chain:
//
//   argv > URI partial > PG* env > pgpass (password only) > service > libpq defaults
//
// Existing tests above use the legacy path (no `resolution`) so they remain
// stable; the new fixtures construct everything explicitly so they don't
// depend on the test runner's ambient environment.
// ---------------------------------------------------------------------------
describe('applyStartupArgs — layered resolution', () => {
  const buildBaseSettings = (): ReturnType<typeof defaultSettings> => {
    const v = createVarStore();
    return defaultSettings(v);
  };

  test('PG* env vars fill in missing fields', () => {
    const parsed = ok(parseStartupArgs([]));
    const settings = buildBaseSettings();
    const { connect } = applyStartupArgs(parsed, settings, undefined, {
      env: {
        PGHOST: 'envhost',
        PGPORT: '7777',
        PGUSER: 'envuser',
        PGDATABASE: 'envdb',
        PGPASSWORD: 'envpass',
        PGSSLMODE: 'require',
        PGAPPNAME: 'envapp',
      },
    });
    expect(connect.host).toBe('envhost');
    expect(connect.port).toBe(7777);
    expect(connect.user).toBe('envuser');
    expect(connect.database).toBe('envdb');
    expect(connect.password).toBe('envpass');
    expect(connect.ssl).toBe('require');
    expect(connect.applicationName).toBe('envapp');
  });

  test('argv flags override PG* env vars', () => {
    const parsed = ok(
      parseStartupArgs(['-h', 'argvhost', '-p', '5555', '-U', 'argvuser']),
    );
    const settings = buildBaseSettings();
    const { connect } = applyStartupArgs(parsed, settings, undefined, {
      env: {
        PGHOST: 'envhost',
        PGPORT: '7777',
        PGUSER: 'envuser',
        PGDATABASE: 'envdb',
      },
    });
    expect(connect.host).toBe('argvhost');
    expect(connect.port).toBe(5555);
    expect(connect.user).toBe('argvuser');
    // PGDATABASE still fills in dbname since argv didn't set it.
    expect(connect.database).toBe('envdb');
  });

  test('URI partial overrides PG* env vars but argv still wins', () => {
    const parsed = ok(parseStartupArgs(['-h', 'argvhost']));
    const settings = buildBaseSettings();
    const { connect } = applyStartupArgs(parsed, settings, undefined, {
      uriPartial: { host: 'urihost', port: 6543, user: 'uriuser' },
      env: {
        PGHOST: 'envhost',
        PGPORT: '7777',
        PGUSER: 'envuser',
      },
    });
    expect(connect.host).toBe('argvhost'); // argv > URI > env
    expect(connect.port).toBe(6543); // URI > env (no argv)
    expect(connect.user).toBe('uriuser'); // URI > env (no argv)
  });

  test('falls back to libpq defaults when nothing else is supplied', () => {
    const parsed = ok(parseStartupArgs([]));
    const settings = buildBaseSettings();
    const { connect } = applyStartupArgs(parsed, settings, undefined, {
      env: { USER: 'osuser' },
    });
    expect(connect.host).toBe('localhost');
    expect(connect.port).toBe(5432);
    expect(connect.user).toBe('osuser');
    // database defaults to the resolved user when no layer supplies it.
    expect(connect.database).toBe('osuser');
    expect(connect.ssl).toBe('prefer');
  });

  test('pg_service.conf lookup fills in fields when serviceName is set', () => {
    const parsed = ok(parseStartupArgs([]));
    const settings = buildBaseSettings();
    const services = new Map([
      [
        'prod',
        {
          host: 'svc-host',
          port: '6543',
          dbname: 'svcdb',
          user: 'svcuser',
        },
      ],
    ]);
    const { connect } = applyStartupArgs(parsed, settings, undefined, {
      env: {},
      services,
      serviceName: 'prod',
    });
    expect(connect.host).toBe('svc-host');
    expect(connect.port).toBe(6543);
    expect(connect.database).toBe('svcdb');
    expect(connect.user).toBe('svcuser');
  });

  test('PGSERVICE env activates a service lookup', () => {
    const parsed = ok(parseStartupArgs([]));
    const settings = buildBaseSettings();
    const services = new Map([
      ['from-env', { host: 'envsvc-host', port: '5555' }],
    ]);
    const { connect } = applyStartupArgs(parsed, settings, undefined, {
      env: { PGSERVICE: 'from-env' },
      services,
    });
    expect(connect.host).toBe('envsvc-host');
    expect(connect.port).toBe(5555);
  });

  test('env vars override service entry (env is higher priority)', () => {
    const parsed = ok(parseStartupArgs([]));
    const settings = buildBaseSettings();
    const services = new Map([
      ['svc', { host: 'svc-host', port: '6543', user: 'svc-user' }],
    ]);
    const { connect } = applyStartupArgs(parsed, settings, undefined, {
      env: { PGHOST: 'env-host', PGSERVICE: 'svc' },
      services,
    });
    expect(connect.host).toBe('env-host'); // env > service
    expect(connect.port).toBe(6543); // env didn't set port → service wins
    expect(connect.user).toBe('svc-user');
  });

  test('explicit serviceName beats $PGSERVICE', () => {
    const parsed = ok(parseStartupArgs([]));
    const settings = buildBaseSettings();
    const services = new Map([
      ['envsvc', { host: 'env-svc-host' }],
      ['explicit', { host: 'explicit-host' }],
    ]);
    const { connect } = applyStartupArgs(parsed, settings, undefined, {
      env: { PGSERVICE: 'envsvc' },
      services,
      serviceName: 'explicit',
    });
    expect(connect.host).toBe('explicit-host');
  });

  test('.pgpass supplies password only when not otherwise set', () => {
    const parsed = ok(parseStartupArgs(['-h', 'myhost', '-U', 'alice']));
    const settings = buildBaseSettings();
    const { connect } = applyStartupArgs(parsed, settings, undefined, {
      env: { PGDATABASE: 'mydb' },
      pgpassEntries: [
        {
          host: 'myhost',
          port: '5432',
          database: 'mydb',
          user: 'alice',
          password: 'pgpass-secret',
        },
      ],
    });
    expect(connect.password).toBe('pgpass-secret');
  });

  test('.pgpass does NOT override an env-supplied password', () => {
    const parsed = ok(parseStartupArgs(['-h', 'myhost', '-U', 'alice']));
    const settings = buildBaseSettings();
    const { connect } = applyStartupArgs(parsed, settings, undefined, {
      env: { PGPASSWORD: 'env-pw', PGDATABASE: 'mydb' },
      pgpassEntries: [
        {
          host: 'myhost',
          port: '5432',
          database: 'mydb',
          user: 'alice',
          password: 'pgpass-secret',
        },
      ],
    });
    expect(connect.password).toBe('env-pw');
  });

  test('.pgpass wildcards match', () => {
    const parsed = ok(parseStartupArgs(['-h', 'random.host', '-U', 'alice']));
    const settings = buildBaseSettings();
    const { connect } = applyStartupArgs(parsed, settings, undefined, {
      env: { PGDATABASE: 'somedb' },
      pgpassEntries: [
        {
          host: '*',
          port: '*',
          database: '*',
          user: 'alice',
          password: 'wildcard-pw',
        },
      ],
    });
    expect(connect.password).toBe('wildcard-pw');
  });

  test('legacy baseConnectOpts path is unaffected by resolution absence', () => {
    // Without a resolution arg, applyStartupArgs uses the legacy "base +
    // argv overrides" semantic. This test pins that contract.
    const parsed = ok(parseStartupArgs(['-h', 'argv']));
    const settings = buildBaseSettings();
    const { connect } = applyStartupArgs(parsed, settings, {
      host: 'legacy',
      port: 5432,
      user: 'legacy-user',
      database: 'legacy-db',
      ssl: 'prefer',
    });
    expect(connect.host).toBe('argv');
    expect(connect.user).toBe('legacy-user');
    expect(connect.database).toBe('legacy-db');
  });
});
