/**
 * SQL command help data for `\h` (helpSQL).
 *
 * This is a minimum-viable subset of upstream PostgreSQL's `sql_help.h`, which
 * is auto-generated from the SGML documentation at psql build time and covers
 * roughly 600 commands. Here we ship concise syntax skeletons for the ~70 SQL
 * commands that account for the vast majority of interactive `\h` lookups.
 * Each entry mirrors the shape of upstream `\h` output:
 *
 *   Command:     <cmd>
 *   Description: <one-line description>
 *   Syntax:
 *   <multi-line synopsis>
 *
 *   URL: <docs page>
 *
 * Drill-down on rarer commands is delegated to the URL — accuracy on the
 * skeleton is what matters here; the docs page is the source of truth for
 * details like reloption catalogs and per-storage-engine quirks.
 */

export type SqlHelpEntry = {
  /** Display name, e.g. "CREATE TABLE". */
  cmd: string;
  /** One-line description of what the command does. */
  description: string;
  /** Multi-line synopsis from the PG docs, ~10 lines typical. */
  syntax: string;
  /** URL to the canonical docs page. */
  docUrl: string;
};

const PG_DOCS = 'https://www.postgresql.org/docs/current/sql-';

export const SQL_HELP: readonly SqlHelpEntry[] = [
  // ---------------------------------------------------------------------------
  // DML
  // ---------------------------------------------------------------------------
  {
    cmd: 'SELECT',
    description: 'retrieve rows from a table or view',
    syntax: `[ WITH [ RECURSIVE ] with_query [, ...] ]
SELECT [ ALL | DISTINCT [ ON ( expression [, ...] ) ] ]
    [ * | expression [ [ AS ] output_name ] [, ...] ]
    [ FROM from_item [, ...] ]
    [ WHERE condition ]
    [ GROUP BY [ ALL | DISTINCT ] grouping_element [, ...] ]
    [ HAVING condition ]
    [ WINDOW window_name AS ( window_definition ) [, ...] ]
    [ { UNION | INTERSECT | EXCEPT } [ ALL | DISTINCT ] select ]
    [ ORDER BY expression [ ASC | DESC | USING operator ] [ NULLS { FIRST | LAST } ] [, ...] ]
    [ LIMIT { count | ALL } ]
    [ OFFSET start [ ROW | ROWS ] ]
    [ FOR { UPDATE | NO KEY UPDATE | SHARE | KEY SHARE } [ OF from_reference [, ...] ] [ NOWAIT | SKIP LOCKED ] [...] ]`,
    docUrl: `${PG_DOCS}select.html`,
  },
  {
    cmd: 'INSERT',
    description: 'create new rows in a table',
    syntax: `[ WITH [ RECURSIVE ] with_query [, ...] ]
INSERT INTO table_name [ AS alias ] [ ( column_name [, ...] ) ]
    [ OVERRIDING { SYSTEM | USER } VALUE ]
    { DEFAULT VALUES | VALUES ( { expression | DEFAULT } [, ...] ) [, ...] | query }
    [ ON CONFLICT [ conflict_target ] conflict_action ]
    [ RETURNING { * | output_expression [ [ AS ] output_name ] } [, ...] ]

where conflict_action is one of:
    DO NOTHING
    DO UPDATE SET { column_name = { expression | DEFAULT } |
                    ( column_name [, ...] ) = ( { expression | DEFAULT } [, ...] ) } [, ...]
                  [ WHERE condition ]`,
    docUrl: `${PG_DOCS}insert.html`,
  },
  {
    cmd: 'UPDATE',
    description: 'update rows of a table',
    syntax: `[ WITH [ RECURSIVE ] with_query [, ...] ]
UPDATE [ ONLY ] table_name [ * ] [ [ AS ] alias ]
    SET { column_name = { expression | DEFAULT } |
          ( column_name [, ...] ) = [ ROW ] ( { expression | DEFAULT } [, ...] ) |
          ( column_name [, ...] ) = ( sub-SELECT )
        } [, ...]
    [ FROM from_item [, ...] ]
    [ WHERE condition | WHERE CURRENT OF cursor_name ]
    [ RETURNING { * | output_expression [ [ AS ] output_name ] } [, ...] ]`,
    docUrl: `${PG_DOCS}update.html`,
  },
  {
    cmd: 'DELETE',
    description: 'delete rows of a table',
    syntax: `[ WITH [ RECURSIVE ] with_query [, ...] ]
DELETE FROM [ ONLY ] table_name [ * ] [ [ AS ] alias ]
    [ USING from_item [, ...] ]
    [ WHERE condition | WHERE CURRENT OF cursor_name ]
    [ RETURNING { * | output_expression [ [ AS ] output_name ] } [, ...] ]`,
    docUrl: `${PG_DOCS}delete.html`,
  },
  {
    cmd: 'MERGE',
    description: 'conditionally insert, update, or delete rows of a table',
    syntax: `[ WITH with_query [, ...] ]
MERGE INTO [ ONLY ] target_table_name [ * ] [ [ AS ] target_alias ]
USING data_source ON join_condition
when_clause [...]
[ RETURNING { * | output_expression [ [ AS ] output_name ] } [, ...] ]

where when_clause is one of:
  WHEN MATCHED [ AND condition ] THEN { merge_update | merge_delete | DO NOTHING }
  WHEN NOT MATCHED BY SOURCE [ AND condition ] THEN { merge_update | merge_delete | DO NOTHING }
  WHEN NOT MATCHED [ BY TARGET ] [ AND condition ] THEN { merge_insert | DO NOTHING }`,
    docUrl: `${PG_DOCS}merge.html`,
  },
  {
    cmd: 'COPY',
    description: 'copy data between a file and a table',
    syntax: `COPY table_name [ ( column_name [, ...] ) ]
    FROM { 'filename' | PROGRAM 'command' | STDIN }
    [ [ WITH ] ( option [, ...] ) ]
    [ WHERE condition ]

COPY { table_name [ ( column_name [, ...] ) ] | ( query ) }
    TO { 'filename' | PROGRAM 'command' | STDOUT }
    [ [ WITH ] ( option [, ...] ) ]`,
    docUrl: `${PG_DOCS}copy.html`,
  },
  {
    cmd: 'EXPLAIN',
    description: 'show the execution plan of a statement',
    syntax: `EXPLAIN [ ( option [, ...] ) ] statement
EXPLAIN [ ANALYZE ] [ VERBOSE ] statement

where option can be one of:
    ANALYZE [ boolean ]
    VERBOSE [ boolean ]
    COSTS [ boolean ]
    SETTINGS [ boolean ]
    GENERIC_PLAN [ boolean ]
    BUFFERS [ boolean ]
    SERIALIZE [ { NONE | TEXT | BINARY } ]
    WAL [ boolean ]
    TIMING [ boolean ]
    SUMMARY [ boolean ]
    MEMORY [ boolean ]
    FORMAT { TEXT | XML | JSON | YAML }`,
    docUrl: `${PG_DOCS}explain.html`,
  },
  {
    cmd: 'ANALYZE',
    description: 'collect statistics about a database',
    syntax: `ANALYZE [ ( option [, ...] ) ] [ table_and_columns [, ...] ]
ANALYZE [ VERBOSE ] [ table_and_columns [, ...] ]

where option can be one of:
    VERBOSE [ boolean ]
    SKIP_LOCKED [ boolean ]
    BUFFER_USAGE_LIMIT size

and table_and_columns is:
    table_name [ ( column_name [, ...] ) ]`,
    docUrl: `${PG_DOCS}analyze.html`,
  },
  {
    cmd: 'VACUUM',
    description: 'garbage-collect and optionally analyze a database',
    syntax: `VACUUM [ ( option [, ...] ) ] [ table_and_columns [, ...] ]
VACUUM [ FULL ] [ FREEZE ] [ VERBOSE ] [ ANALYZE ] [ table_and_columns [, ...] ]

where option can be one of:
    FULL [ boolean ]
    FREEZE [ boolean ]
    VERBOSE [ boolean ]
    ANALYZE [ boolean ]
    DISABLE_PAGE_SKIPPING [ boolean ]
    SKIP_LOCKED [ boolean ]
    INDEX_CLEANUP { AUTO | ON | OFF }
    PROCESS_TOAST [ boolean ]
    TRUNCATE [ boolean ]
    PARALLEL integer
    SKIP_DATABASE_STATS [ boolean ]
    ONLY_DATABASE_STATS [ boolean ]
    BUFFER_USAGE_LIMIT size`,
    docUrl: `${PG_DOCS}vacuum.html`,
  },
  {
    cmd: 'REINDEX',
    description: 'rebuild indexes',
    syntax: `REINDEX [ ( option [, ...] ) ] { INDEX | TABLE | SCHEMA } [ CONCURRENTLY ] name
REINDEX [ ( option [, ...] ) ] { DATABASE | SYSTEM } [ CONCURRENTLY ] [ name ]

where option can be one of:
    CONCURRENTLY [ boolean ]
    TABLESPACE new_tablespace
    VERBOSE [ boolean ]`,
    docUrl: `${PG_DOCS}reindex.html`,
  },
  {
    cmd: 'TRUNCATE',
    description: 'empty a table or set of tables',
    syntax: `TRUNCATE [ TABLE ] [ ONLY ] name [ * ] [, ... ]
    [ RESTART IDENTITY | CONTINUE IDENTITY ] [ CASCADE | RESTRICT ]`,
    docUrl: `${PG_DOCS}truncate.html`,
  },

  // ---------------------------------------------------------------------------
  // CREATE
  // ---------------------------------------------------------------------------
  {
    cmd: 'CREATE TABLE',
    description: 'define a new table',
    syntax: `CREATE [ [ GLOBAL | LOCAL ] { TEMPORARY | TEMP } | UNLOGGED ] TABLE [ IF NOT EXISTS ] table_name ( [
  { column_name data_type [ STORAGE { PLAIN | EXTERNAL | EXTENDED | MAIN | DEFAULT } ] [ COMPRESSION compression_method ] [ COLLATE collation ] [ column_constraint [ ... ] ]
    | table_constraint
    | LIKE source_table [ like_option ... ] }
    [, ... ]
] )
[ INHERITS ( parent_table [, ... ] ) ]
[ PARTITION BY { RANGE | LIST | HASH } ( { column_name | ( expression ) } [ COLLATE collation ] [ opclass ] [, ... ] ) ]
[ USING method ]
[ WITH ( storage_parameter [= value] [, ... ] ) | WITHOUT OIDS ]
[ ON COMMIT { PRESERVE ROWS | DELETE ROWS | DROP } ]
[ TABLESPACE tablespace_name ]

CREATE [ [ GLOBAL | LOCAL ] { TEMPORARY | TEMP } | UNLOGGED ] TABLE [ IF NOT EXISTS ] table_name
    OF type_name [ ( { column_name [ WITH OPTIONS ] [ column_constraint [ ... ] ] | table_constraint } [, ... ] ) ] [...]

CREATE [ [ GLOBAL | LOCAL ] { TEMPORARY | TEMP } | UNLOGGED ] TABLE [ IF NOT EXISTS ] table_name
    PARTITION OF parent_table [ ( ... ) ] { FOR VALUES partition_bound_spec | DEFAULT } [...]`,
    docUrl: `${PG_DOCS}createtable.html`,
  },
  {
    cmd: 'CREATE INDEX',
    description: 'define a new index',
    syntax: `CREATE [ UNIQUE ] INDEX [ CONCURRENTLY ] [ [ IF NOT EXISTS ] name ] ON [ ONLY ] table_name [ USING method ]
    ( { column_name | ( expression ) } [ COLLATE collation ] [ opclass [ ( opclass_parameter = value [, ... ] ) ] ] [ ASC | DESC ] [ NULLS { FIRST | LAST } ] [, ...] )
    [ INCLUDE ( column_name [, ...] ) ]
    [ NULLS [ NOT ] DISTINCT ]
    [ WITH ( storage_parameter [= value] [, ... ] ) ]
    [ TABLESPACE tablespace_name ]
    [ WHERE predicate ]`,
    docUrl: `${PG_DOCS}createindex.html`,
  },
  {
    cmd: 'CREATE VIEW',
    description: 'define a new view',
    syntax: `CREATE [ OR REPLACE ] [ TEMP | TEMPORARY ] [ RECURSIVE ] VIEW name [ ( column_name [, ...] ) ]
    [ WITH ( view_option_name [= view_option_value] [, ... ] ) ]
    AS query
    [ WITH [ CASCADED | LOCAL ] CHECK OPTION ]`,
    docUrl: `${PG_DOCS}createview.html`,
  },
  {
    cmd: 'CREATE MATERIALIZED VIEW',
    description: 'define a new materialized view',
    syntax: `CREATE MATERIALIZED VIEW [ IF NOT EXISTS ] table_name
    [ (column_name [, ...] ) ]
    [ USING method ]
    [ WITH ( storage_parameter [= value] [, ... ] ) ]
    [ TABLESPACE tablespace_name ]
    AS query
    [ WITH [ NO ] DATA ]`,
    docUrl: `${PG_DOCS}creatematerializedview.html`,
  },
  {
    cmd: 'CREATE FUNCTION',
    description: 'define a new function',
    syntax: `CREATE [ OR REPLACE ] FUNCTION
    name ( [ [ argmode ] [ argname ] argtype [ { DEFAULT | = } default_expr ] [, ...] ] )
    [ RETURNS rettype
      | RETURNS TABLE ( column_name column_type [, ...] ) ]
  { LANGUAGE lang_name
    | TRANSFORM { FOR TYPE type_name } [, ... ]
    | WINDOW
    | { IMMUTABLE | STABLE | VOLATILE }
    | [ NOT ] LEAKPROOF
    | { CALLED ON NULL INPUT | RETURNS NULL ON NULL INPUT | STRICT }
    | { [ EXTERNAL ] SECURITY INVOKER | [ EXTERNAL ] SECURITY DEFINER }
    | PARALLEL { UNSAFE | RESTRICTED | SAFE }
    | COST execution_cost
    | ROWS result_rows
    | SUPPORT support_function
    | SET configuration_parameter { TO value | = value | FROM CURRENT }
    | AS 'definition'
    | AS 'obj_file', 'link_symbol'
    | sql_body
  } ...`,
    docUrl: `${PG_DOCS}createfunction.html`,
  },
  {
    cmd: 'CREATE PROCEDURE',
    description: 'define a new procedure',
    syntax: `CREATE [ OR REPLACE ] PROCEDURE
    name ( [ [ argmode ] [ argname ] argtype [ { DEFAULT | = } default_expr ] [, ...] ] )
  { LANGUAGE lang_name
    | TRANSFORM { FOR TYPE type_name } [, ... ]
    | [ EXTERNAL ] SECURITY INVOKER | [ EXTERNAL ] SECURITY DEFINER
    | SET configuration_parameter { TO value | = value | FROM CURRENT }
    | AS 'definition'
    | AS 'obj_file', 'link_symbol'
    | sql_body
  } ...`,
    docUrl: `${PG_DOCS}createprocedure.html`,
  },
  {
    cmd: 'CREATE EXTENSION',
    description: 'install an extension',
    syntax: `CREATE EXTENSION [ IF NOT EXISTS ] extension_name
    [ WITH ] [ SCHEMA schema_name ]
             [ VERSION version ]
             [ CASCADE ]`,
    docUrl: `${PG_DOCS}createextension.html`,
  },
  {
    cmd: 'CREATE SCHEMA',
    description: 'define a new schema',
    syntax: `CREATE SCHEMA [ IF NOT EXISTS ] schema_name [ AUTHORIZATION role_specification ] [ schema_element [ ... ] ]
CREATE SCHEMA [ IF NOT EXISTS ] AUTHORIZATION role_specification [ schema_element [ ... ] ]

where role_specification can be:
    user_name
  | CURRENT_ROLE
  | CURRENT_USER
  | SESSION_USER`,
    docUrl: `${PG_DOCS}createschema.html`,
  },
  {
    cmd: 'CREATE DATABASE',
    description: 'create a new database',
    syntax: `CREATE DATABASE name
    [ WITH ] [ OWNER [=] user_name ]
             [ TEMPLATE [=] template ]
             [ ENCODING [=] encoding ]
             [ STRATEGY [=] strategy ]
             [ LOCALE [=] locale ]
             [ LC_COLLATE [=] lc_collate ]
             [ LC_CTYPE [=] lc_ctype ]
             [ BUILTIN_LOCALE [=] builtin_locale ]
             [ ICU_LOCALE [=] icu_locale ]
             [ ICU_RULES [=] icu_rules ]
             [ LOCALE_PROVIDER [=] locale_provider ]
             [ COLLATION_VERSION = collation_version ]
             [ TABLESPACE [=] tablespace_name ]
             [ ALLOW_CONNECTIONS [=] allowconn ]
             [ CONNECTION LIMIT [=] connlimit ]
             [ IS_TEMPLATE [=] istemplate ]
             [ OID [=] oid ]`,
    docUrl: `${PG_DOCS}createdatabase.html`,
  },
  {
    cmd: 'CREATE ROLE',
    description: 'define a new database role',
    syntax: `CREATE ROLE name [ [ WITH ] option [ ... ] ]

where option can be:

      SUPERUSER | NOSUPERUSER
    | CREATEDB | NOCREATEDB
    | CREATEROLE | NOCREATEROLE
    | INHERIT | NOINHERIT
    | LOGIN | NOLOGIN
    | REPLICATION | NOREPLICATION
    | BYPASSRLS | NOBYPASSRLS
    | CONNECTION LIMIT connlimit
    | [ ENCRYPTED ] PASSWORD 'password' | PASSWORD NULL
    | VALID UNTIL 'timestamp'
    | IN ROLE role_name [, ...]
    | ROLE role_name [, ...]
    | ADMIN role_name [, ...]
    | SYSID uid`,
    docUrl: `${PG_DOCS}createrole.html`,
  },
  {
    cmd: 'CREATE USER',
    description: 'define a new database role (alias for CREATE ROLE ... LOGIN)',
    syntax: `CREATE USER name [ [ WITH ] option [ ... ] ]

where option can be:

      SUPERUSER | NOSUPERUSER
    | CREATEDB | NOCREATEDB
    | CREATEROLE | NOCREATEROLE
    | INHERIT | NOINHERIT
    | LOGIN | NOLOGIN
    | REPLICATION | NOREPLICATION
    | BYPASSRLS | NOBYPASSRLS
    | CONNECTION LIMIT connlimit
    | [ ENCRYPTED ] PASSWORD 'password' | PASSWORD NULL
    | VALID UNTIL 'timestamp'
    | IN ROLE role_name [, ...]
    | ROLE role_name [, ...]
    | ADMIN role_name [, ...]`,
    docUrl: `${PG_DOCS}createuser.html`,
  },
  {
    cmd: 'CREATE TYPE',
    description: 'define a new data type',
    syntax: `CREATE TYPE name AS
    ( [ attribute_name data_type [ COLLATE collation ] [, ... ] ] )

CREATE TYPE name AS ENUM
    ( [ 'label' [, ... ] ] )

CREATE TYPE name AS RANGE (
    SUBTYPE = subtype
    [ , SUBTYPE_OPCLASS = subtype_operator_class ]
    [ , COLLATION = collation ]
    [ , CANONICAL = canonical_function ]
    [ , SUBTYPE_DIFF = subtype_diff_function ]
    [ , MULTIRANGE_TYPE_NAME = multirange_type_name ]
)

CREATE TYPE name (
    INPUT = input_function,
    OUTPUT = output_function
    [ , RECEIVE = receive_function ]
    [ , SEND = send_function ]
    [ , ... ]
)

CREATE TYPE name`,
    docUrl: `${PG_DOCS}createtype.html`,
  },
  {
    cmd: 'CREATE TRIGGER',
    description: 'define a new trigger',
    syntax: `CREATE [ OR REPLACE ] [ CONSTRAINT ] TRIGGER name { BEFORE | AFTER | INSTEAD OF } { event [ OR ... ] }
    ON table_name
    [ FROM referenced_table_name ]
    [ NOT DEFERRABLE | [ DEFERRABLE ] [ INITIALLY IMMEDIATE | INITIALLY DEFERRED ] ]
    [ REFERENCING { { OLD | NEW } TABLE [ AS ] transition_relation_name } [ ... ] ]
    [ FOR [ EACH ] { ROW | STATEMENT } ]
    [ WHEN ( condition ) ]
    EXECUTE { FUNCTION | PROCEDURE } function_name ( arguments )

where event can be one of:
    INSERT
    UPDATE [ OF column_name [, ... ] ]
    DELETE
    TRUNCATE`,
    docUrl: `${PG_DOCS}createtrigger.html`,
  },
  {
    cmd: 'CREATE POLICY',
    description: 'define a new row-level security policy for a table',
    syntax: `CREATE POLICY name ON table_name
    [ AS { PERMISSIVE | RESTRICTIVE } ]
    [ FOR { ALL | SELECT | INSERT | UPDATE | DELETE } ]
    [ TO { role_name | PUBLIC | CURRENT_ROLE | CURRENT_USER | SESSION_USER } [, ...] ]
    [ USING ( using_expression ) ]
    [ WITH CHECK ( check_expression ) ]`,
    docUrl: `${PG_DOCS}createpolicy.html`,
  },
  {
    cmd: 'CREATE PUBLICATION',
    description: 'define a new publication',
    syntax: `CREATE PUBLICATION name
    [ FOR ALL TABLES
      | FOR publication_object [, ... ] ]
    [ WITH ( publication_parameter [= value] [, ... ] ) ]

where publication_object is one of:

    TABLE [ ONLY ] table_name [ * ] [ ( column_name [, ... ] ) ] [ WHERE ( expression ) ] [, ... ]
    TABLES IN SCHEMA { schema_name | CURRENT_SCHEMA } [, ... ]`,
    docUrl: `${PG_DOCS}createpublication.html`,
  },
  {
    cmd: 'CREATE SUBSCRIPTION',
    description: 'define a new subscription',
    syntax: `CREATE SUBSCRIPTION subscription_name
    CONNECTION 'conninfo'
    PUBLICATION publication_name [, ...]
    [ WITH ( subscription_parameter [= value] [, ... ] ) ]`,
    docUrl: `${PG_DOCS}createsubscription.html`,
  },

  // ---------------------------------------------------------------------------
  // ALTER
  // ---------------------------------------------------------------------------
  {
    cmd: 'ALTER TABLE',
    description: 'change the definition of a table',
    syntax: `ALTER TABLE [ IF EXISTS ] [ ONLY ] name [ * ]
    action [, ... ]
ALTER TABLE [ IF EXISTS ] [ ONLY ] name [ * ]
    RENAME [ COLUMN ] column_name TO new_column_name
ALTER TABLE [ IF EXISTS ] [ ONLY ] name [ * ]
    RENAME CONSTRAINT constraint_name TO new_constraint_name
ALTER TABLE [ IF EXISTS ] name
    RENAME TO new_name
ALTER TABLE [ IF EXISTS ] name
    SET SCHEMA new_schema
ALTER TABLE ALL IN TABLESPACE name [ OWNED BY role_name [, ... ] ]
    SET TABLESPACE new_tablespace [ NOWAIT ]
ALTER TABLE [ IF EXISTS ] name
    ATTACH PARTITION partition_name { FOR VALUES partition_bound_spec | DEFAULT }
ALTER TABLE [ IF EXISTS ] name
    DETACH PARTITION partition_name [ CONCURRENTLY | FINALIZE ]

where action is one of:
    ADD [ COLUMN ] [ IF NOT EXISTS ] column_name data_type [ COLLATE collation ] [ column_constraint [ ... ] ]
    DROP [ COLUMN ] [ IF EXISTS ] column_name [ RESTRICT | CASCADE ]
    ALTER [ COLUMN ] column_name [ SET DATA ] TYPE data_type [ COLLATE collation ] [ USING expression ]
    ALTER [ COLUMN ] column_name SET DEFAULT expression
    ALTER [ COLUMN ] column_name DROP DEFAULT
    ALTER [ COLUMN ] column_name { SET | DROP } NOT NULL
    ADD table_constraint [ NOT VALID ]
    DROP CONSTRAINT [ IF EXISTS ] constraint_name [ RESTRICT | CASCADE ]
    ENABLE | DISABLE ROW LEVEL SECURITY
    OWNER TO new_owner
    SET TABLESPACE new_tablespace`,
    docUrl: `${PG_DOCS}altertable.html`,
  },
  {
    cmd: 'ALTER INDEX',
    description: 'change the definition of an index',
    syntax: `ALTER INDEX [ IF EXISTS ] name RENAME TO new_name
ALTER INDEX [ IF EXISTS ] name SET TABLESPACE tablespace_name
ALTER INDEX name ATTACH PARTITION index_name
ALTER INDEX name [ NO ] DEPENDS ON EXTENSION extension_name
ALTER INDEX [ IF EXISTS ] name SET ( storage_parameter [= value] [, ... ] )
ALTER INDEX [ IF EXISTS ] name RESET ( storage_parameter [, ... ] )
ALTER INDEX [ IF EXISTS ] name ALTER [ COLUMN ] column_number
    SET STATISTICS integer
ALTER INDEX ALL IN TABLESPACE name [ OWNED BY role_name [, ... ] ]
    SET TABLESPACE new_tablespace [ NOWAIT ]`,
    docUrl: `${PG_DOCS}alterindex.html`,
  },
  {
    cmd: 'ALTER VIEW',
    description: 'change the definition of a view',
    syntax: `ALTER VIEW [ IF EXISTS ] name ALTER [ COLUMN ] column_name SET DEFAULT expression
ALTER VIEW [ IF EXISTS ] name ALTER [ COLUMN ] column_name DROP DEFAULT
ALTER VIEW [ IF EXISTS ] name OWNER TO { new_owner | CURRENT_ROLE | CURRENT_USER | SESSION_USER }
ALTER VIEW [ IF EXISTS ] name RENAME [ COLUMN ] column_name TO new_column_name
ALTER VIEW [ IF EXISTS ] name RENAME TO new_name
ALTER VIEW [ IF EXISTS ] name SET SCHEMA new_schema
ALTER VIEW [ IF EXISTS ] name SET ( view_option_name [= view_option_value] [, ... ] )
ALTER VIEW [ IF EXISTS ] name RESET ( view_option_name [, ... ] )`,
    docUrl: `${PG_DOCS}alterview.html`,
  },
  {
    cmd: 'ALTER MATERIALIZED VIEW',
    description: 'change the definition of a materialized view',
    syntax: `ALTER MATERIALIZED VIEW [ IF EXISTS ] name action [, ... ]
ALTER MATERIALIZED VIEW name
    [ NO ] DEPENDS ON EXTENSION extension_name
ALTER MATERIALIZED VIEW [ IF EXISTS ] name
    RENAME [ COLUMN ] column_name TO new_column_name
ALTER MATERIALIZED VIEW [ IF EXISTS ] name RENAME TO new_name
ALTER MATERIALIZED VIEW [ IF EXISTS ] name SET SCHEMA new_schema
ALTER MATERIALIZED VIEW ALL IN TABLESPACE name [ OWNED BY role_name [, ... ] ]
    SET TABLESPACE new_tablespace [ NOWAIT ]`,
    docUrl: `${PG_DOCS}altermaterializedview.html`,
  },
  {
    cmd: 'ALTER FUNCTION',
    description: 'change the definition of a function',
    syntax: `ALTER FUNCTION name [ ( [ [ argmode ] [ argname ] argtype [, ...] ] ) ]
    action [ ... ] [ RESTRICT ]
ALTER FUNCTION name [ ( [ [ argmode ] [ argname ] argtype [, ...] ] ) ]
    RENAME TO new_name
ALTER FUNCTION name [ ( [ [ argmode ] [ argname ] argtype [, ...] ] ) ]
    OWNER TO { new_owner | CURRENT_ROLE | CURRENT_USER | SESSION_USER }
ALTER FUNCTION name [ ( [ [ argmode ] [ argname ] argtype [, ...] ] ) ]
    SET SCHEMA new_schema
ALTER FUNCTION name [ ( [ [ argmode ] [ argname ] argtype [, ...] ] ) ]
    [ NO ] DEPENDS ON EXTENSION extension_name`,
    docUrl: `${PG_DOCS}alterfunction.html`,
  },
  {
    cmd: 'ALTER EXTENSION',
    description: 'change the definition of an extension',
    syntax: `ALTER EXTENSION name UPDATE [ TO new_version ]
ALTER EXTENSION name SET SCHEMA new_schema
ALTER EXTENSION name ADD member_object
ALTER EXTENSION name DROP member_object

where member_object is one of:
    ACCESS METHOD object_name |
    AGGREGATE aggregate_name ( aggregate_signature ) |
    CAST (source_type AS target_type) |
    COLLATION object_name |
    DOMAIN object_name |
    FUNCTION function_name [ ( ... ) ] |
    OPERATOR operator_name (left_type, right_type) |
    SCHEMA object_name |
    SEQUENCE object_name |
    TABLE object_name |
    TYPE object_name |
    VIEW object_name`,
    docUrl: `${PG_DOCS}alterextension.html`,
  },
  {
    cmd: 'ALTER SCHEMA',
    description: 'change the definition of a schema',
    syntax: `ALTER SCHEMA name RENAME TO new_name
ALTER SCHEMA name OWNER TO { new_owner | CURRENT_ROLE | CURRENT_USER | SESSION_USER }`,
    docUrl: `${PG_DOCS}alterschema.html`,
  },
  {
    cmd: 'ALTER DATABASE',
    description: 'change a database',
    syntax: `ALTER DATABASE name [ [ WITH ] option [ ... ] ]

where option can be:

    ALLOW_CONNECTIONS allowconn
    CONNECTION LIMIT connlimit
    IS_TEMPLATE istemplate

ALTER DATABASE name RENAME TO new_name
ALTER DATABASE name OWNER TO { new_owner | CURRENT_ROLE | CURRENT_USER | SESSION_USER }
ALTER DATABASE name SET TABLESPACE new_tablespace
ALTER DATABASE name REFRESH COLLATION VERSION
ALTER DATABASE name SET configuration_parameter { TO | = } { value | DEFAULT }
ALTER DATABASE name SET configuration_parameter FROM CURRENT
ALTER DATABASE name RESET configuration_parameter
ALTER DATABASE name RESET ALL`,
    docUrl: `${PG_DOCS}alterdatabase.html`,
  },
  {
    cmd: 'ALTER ROLE',
    description: 'change a database role',
    syntax: `ALTER ROLE role_specification [ WITH ] option [ ... ]

where option can be:

      SUPERUSER | NOSUPERUSER
    | CREATEDB | NOCREATEDB
    | CREATEROLE | NOCREATEROLE
    | INHERIT | NOINHERIT
    | LOGIN | NOLOGIN
    | REPLICATION | NOREPLICATION
    | BYPASSRLS | NOBYPASSRLS
    | CONNECTION LIMIT connlimit
    | [ ENCRYPTED ] PASSWORD 'password' | PASSWORD NULL
    | VALID UNTIL 'timestamp'

ALTER ROLE name RENAME TO new_name
ALTER ROLE { role_specification | ALL } [ IN DATABASE database_name ] SET configuration_parameter { TO | = } { value | DEFAULT }
ALTER ROLE { role_specification | ALL } [ IN DATABASE database_name ] SET configuration_parameter FROM CURRENT
ALTER ROLE { role_specification | ALL } [ IN DATABASE database_name ] RESET configuration_parameter
ALTER ROLE { role_specification | ALL } [ IN DATABASE database_name ] RESET ALL`,
    docUrl: `${PG_DOCS}alterrole.html`,
  },
  {
    cmd: 'ALTER USER',
    description: 'change a database role (alias for ALTER ROLE)',
    syntax: `ALTER USER role_specification [ WITH ] option [ ... ]

where option can be:

      SUPERUSER | NOSUPERUSER
    | CREATEDB | NOCREATEDB
    | CREATEROLE | NOCREATEROLE
    | INHERIT | NOINHERIT
    | LOGIN | NOLOGIN
    | REPLICATION | NOREPLICATION
    | BYPASSRLS | NOBYPASSRLS
    | CONNECTION LIMIT connlimit
    | [ ENCRYPTED ] PASSWORD 'password' | PASSWORD NULL
    | VALID UNTIL 'timestamp'

ALTER USER name RENAME TO new_name`,
    docUrl: `${PG_DOCS}alteruser.html`,
  },
  {
    cmd: 'ALTER TYPE',
    description: 'change the definition of a type',
    syntax: `ALTER TYPE name OWNER TO { new_owner | CURRENT_ROLE | CURRENT_USER | SESSION_USER }
ALTER TYPE name RENAME ATTRIBUTE attribute_name TO new_attribute_name [ CASCADE | RESTRICT ]
ALTER TYPE name RENAME TO new_name
ALTER TYPE name SET SCHEMA new_schema
ALTER TYPE name ADD VALUE [ IF NOT EXISTS ] new_enum_value [ { BEFORE | AFTER } neighbor_enum_value ]
ALTER TYPE name RENAME VALUE existing_enum_value TO new_enum_value
ALTER TYPE name SET ( property = value [, ... ] )

where action is one of:
    ADD ATTRIBUTE attribute_name data_type [ COLLATE collation ] [ CASCADE | RESTRICT ]
    DROP ATTRIBUTE [ IF EXISTS ] attribute_name [ CASCADE | RESTRICT ]
    ALTER ATTRIBUTE attribute_name [ SET DATA ] TYPE data_type [ COLLATE collation ] [ CASCADE | RESTRICT ]`,
    docUrl: `${PG_DOCS}altertype.html`,
  },
  {
    cmd: 'ALTER TRIGGER',
    description: 'change the definition of a trigger',
    syntax: `ALTER TRIGGER name ON table_name RENAME TO new_name
ALTER TRIGGER name ON table_name [ NO ] DEPENDS ON EXTENSION extension_name`,
    docUrl: `${PG_DOCS}altertrigger.html`,
  },
  {
    cmd: 'ALTER POLICY',
    description: 'change the definition of a row-level security policy',
    syntax: `ALTER POLICY name ON table_name RENAME TO new_name

ALTER POLICY name ON table_name
    [ TO { role_name | PUBLIC | CURRENT_ROLE | CURRENT_USER | SESSION_USER } [, ...] ]
    [ USING ( using_expression ) ]
    [ WITH CHECK ( check_expression ) ]`,
    docUrl: `${PG_DOCS}alterpolicy.html`,
  },

  // ---------------------------------------------------------------------------
  // DROP
  // ---------------------------------------------------------------------------
  {
    cmd: 'DROP TABLE',
    description: 'remove a table',
    syntax: `DROP TABLE [ IF EXISTS ] name [, ...] [ CASCADE | RESTRICT ]`,
    docUrl: `${PG_DOCS}droptable.html`,
  },
  {
    cmd: 'DROP INDEX',
    description: 'remove an index',
    syntax: `DROP INDEX [ CONCURRENTLY ] [ IF EXISTS ] name [, ...] [ CASCADE | RESTRICT ]`,
    docUrl: `${PG_DOCS}dropindex.html`,
  },
  {
    cmd: 'DROP VIEW',
    description: 'remove a view',
    syntax: `DROP VIEW [ IF EXISTS ] name [, ...] [ CASCADE | RESTRICT ]`,
    docUrl: `${PG_DOCS}dropview.html`,
  },
  {
    cmd: 'DROP MATERIALIZED VIEW',
    description: 'remove a materialized view',
    syntax: `DROP MATERIALIZED VIEW [ IF EXISTS ] name [, ...] [ CASCADE | RESTRICT ]`,
    docUrl: `${PG_DOCS}dropmaterializedview.html`,
  },
  {
    cmd: 'DROP FUNCTION',
    description: 'remove a function',
    syntax: `DROP FUNCTION [ IF EXISTS ] name [ ( [ [ argmode ] [ argname ] argtype [, ...] ] ) ] [, ...]
    [ CASCADE | RESTRICT ]`,
    docUrl: `${PG_DOCS}dropfunction.html`,
  },
  {
    cmd: 'DROP EXTENSION',
    description: 'remove an extension',
    syntax: `DROP EXTENSION [ IF EXISTS ] name [, ...] [ CASCADE | RESTRICT ]`,
    docUrl: `${PG_DOCS}dropextension.html`,
  },
  {
    cmd: 'DROP SCHEMA',
    description: 'remove a schema',
    syntax: `DROP SCHEMA [ IF EXISTS ] name [, ...] [ CASCADE | RESTRICT ]`,
    docUrl: `${PG_DOCS}dropschema.html`,
  },
  {
    cmd: 'DROP DATABASE',
    description: 'remove a database',
    syntax: `DROP DATABASE [ IF EXISTS ] name [ [ WITH ] ( option [, ...] ) ]

where option can be:

    FORCE`,
    docUrl: `${PG_DOCS}dropdatabase.html`,
  },
  {
    cmd: 'DROP ROLE',
    description: 'remove a database role',
    syntax: `DROP ROLE [ IF EXISTS ] name [, ...]`,
    docUrl: `${PG_DOCS}droprole.html`,
  },

  // ---------------------------------------------------------------------------
  // Privileges
  // ---------------------------------------------------------------------------
  {
    cmd: 'GRANT',
    description: 'define access privileges',
    syntax: `GRANT { { SELECT | INSERT | UPDATE | DELETE | TRUNCATE | REFERENCES | TRIGGER | MAINTAIN }
    [, ...] | ALL [ PRIVILEGES ] }
    ON { [ TABLE ] table_name [, ...]
         | ALL TABLES IN SCHEMA schema_name [, ...] }
    TO role_specification [, ...] [ WITH GRANT OPTION ]
    [ GRANTED BY role_specification ]

GRANT { { USAGE | SELECT | UPDATE }
    [, ...] | ALL [ PRIVILEGES ] }
    ON { SEQUENCE sequence_name [, ...]
         | ALL SEQUENCES IN SCHEMA schema_name [, ...] }
    TO role_specification [, ...] [ WITH GRANT OPTION ]

GRANT { { CREATE | CONNECT | TEMPORARY | TEMP } [, ...] | ALL [ PRIVILEGES ] }
    ON DATABASE database_name [, ...]
    TO role_specification [, ...] [ WITH GRANT OPTION ]

GRANT { EXECUTE | ALL [ PRIVILEGES ] }
    ON { { FUNCTION | PROCEDURE | ROUTINE } routine_name [ ( ... ) ] [, ...] | ALL { FUNCTIONS | PROCEDURES | ROUTINES } IN SCHEMA schema_name [, ...] }
    TO role_specification [, ...] [ WITH GRANT OPTION ]

GRANT role_name [, ...] TO role_specification [, ...]
    [ WITH { ADMIN | INHERIT | SET } { OPTION | TRUE | FALSE } ]
    [ GRANTED BY role_specification ]`,
    docUrl: `${PG_DOCS}grant.html`,
  },
  {
    cmd: 'REVOKE',
    description: 'remove access privileges',
    syntax: `REVOKE [ GRANT OPTION FOR ]
    { { SELECT | INSERT | UPDATE | DELETE | TRUNCATE | REFERENCES | TRIGGER | MAINTAIN }
    [, ...] | ALL [ PRIVILEGES ] }
    ON { [ TABLE ] table_name [, ...]
         | ALL TABLES IN SCHEMA schema_name [, ...] }
    FROM role_specification [, ...]
    [ GRANTED BY role_specification ]
    [ CASCADE | RESTRICT ]

REVOKE [ ADMIN OPTION FOR ]
    role_name [, ...] FROM role_specification [, ...]
    [ GRANTED BY role_specification ]
    [ CASCADE | RESTRICT ]`,
    docUrl: `${PG_DOCS}revoke.html`,
  },

  // ---------------------------------------------------------------------------
  // Transaction control
  // ---------------------------------------------------------------------------
  {
    cmd: 'BEGIN',
    description: 'start a transaction block',
    syntax: `BEGIN [ WORK | TRANSACTION ] [ transaction_mode [, ...] ]

where transaction_mode is one of:

    ISOLATION LEVEL { SERIALIZABLE | REPEATABLE READ | READ COMMITTED | READ UNCOMMITTED }
    READ WRITE | READ ONLY
    [ NOT ] DEFERRABLE`,
    docUrl: `${PG_DOCS}begin.html`,
  },
  {
    cmd: 'COMMIT',
    description: 'commit the current transaction',
    syntax: `COMMIT [ WORK | TRANSACTION ] [ AND [ NO ] CHAIN ]`,
    docUrl: `${PG_DOCS}commit.html`,
  },
  {
    cmd: 'ROLLBACK',
    description: 'abort the current transaction',
    syntax: `ROLLBACK [ WORK | TRANSACTION ] [ AND [ NO ] CHAIN ]`,
    docUrl: `${PG_DOCS}rollback.html`,
  },
  {
    cmd: 'SAVEPOINT',
    description: 'define a new savepoint within the current transaction',
    syntax: `SAVEPOINT savepoint_name`,
    docUrl: `${PG_DOCS}savepoint.html`,
  },
  {
    cmd: 'RELEASE SAVEPOINT',
    description: 'destroy a previously defined savepoint',
    syntax: `RELEASE [ SAVEPOINT ] savepoint_name`,
    docUrl: `${PG_DOCS}release-savepoint.html`,
  },
  {
    cmd: 'START TRANSACTION',
    description: 'start a transaction block',
    syntax: `START TRANSACTION [ transaction_mode [, ...] ]

where transaction_mode is one of:

    ISOLATION LEVEL { SERIALIZABLE | REPEATABLE READ | READ COMMITTED | READ UNCOMMITTED }
    READ WRITE | READ ONLY
    [ NOT ] DEFERRABLE`,
    docUrl: `${PG_DOCS}start-transaction.html`,
  },

  // ---------------------------------------------------------------------------
  // Session / runtime configuration
  // ---------------------------------------------------------------------------
  {
    cmd: 'SET',
    description: 'change a run-time parameter',
    syntax: `SET [ SESSION | LOCAL ] configuration_parameter { TO | = } { value | 'value' | DEFAULT }
SET [ SESSION | LOCAL ] TIME ZONE { value | 'value' | LOCAL | DEFAULT }`,
    docUrl: `${PG_DOCS}set.html`,
  },
  {
    cmd: 'SET ROLE',
    description: 'set the current user identifier of the current session',
    syntax: `SET [ SESSION | LOCAL ] ROLE role_name
SET [ SESSION | LOCAL ] ROLE NONE
RESET ROLE`,
    docUrl: `${PG_DOCS}set-role.html`,
  },
  {
    cmd: 'RESET',
    description:
      'restore the value of a run-time parameter to the default value',
    syntax: `RESET configuration_parameter
RESET ALL`,
    docUrl: `${PG_DOCS}reset.html`,
  },
  {
    cmd: 'SHOW',
    description: 'show the value of a run-time parameter',
    syntax: `SHOW name
SHOW ALL`,
    docUrl: `${PG_DOCS}show.html`,
  },

  // ---------------------------------------------------------------------------
  // Async notification
  // ---------------------------------------------------------------------------
  {
    cmd: 'LISTEN',
    description: 'listen for a notification',
    syntax: `LISTEN channel`,
    docUrl: `${PG_DOCS}listen.html`,
  },
  {
    cmd: 'NOTIFY',
    description: 'generate a notification',
    syntax: `NOTIFY channel [ , payload ]`,
    docUrl: `${PG_DOCS}notify.html`,
  },
  {
    cmd: 'UNLISTEN',
    description: 'stop listening for a notification',
    syntax: `UNLISTEN { channel | * }`,
    docUrl: `${PG_DOCS}unlisten.html`,
  },

  // ---------------------------------------------------------------------------
  // Locking
  // ---------------------------------------------------------------------------
  {
    cmd: 'LOCK',
    description: 'lock a table',
    syntax: `LOCK [ TABLE ] [ ONLY ] name [ * ] [, ...] [ IN lockmode MODE ] [ NOWAIT ]

where lockmode is one of:

    ACCESS SHARE | ROW SHARE | ROW EXCLUSIVE | SHARE UPDATE EXCLUSIVE
    | SHARE | SHARE ROW EXCLUSIVE | EXCLUSIVE | ACCESS EXCLUSIVE`,
    docUrl: `${PG_DOCS}lock.html`,
  },

  // ---------------------------------------------------------------------------
  // Prepared statements
  // ---------------------------------------------------------------------------
  {
    cmd: 'PREPARE',
    description: 'prepare a statement for execution',
    syntax: `PREPARE name [ ( data_type [, ...] ) ] AS statement`,
    docUrl: `${PG_DOCS}prepare.html`,
  },
  {
    cmd: 'EXECUTE',
    description: 'execute a prepared statement',
    syntax: `EXECUTE name [ ( parameter [, ...] ) ]`,
    docUrl: `${PG_DOCS}execute.html`,
  },
  {
    cmd: 'DEALLOCATE',
    description: 'deallocate a prepared statement',
    syntax: `DEALLOCATE [ PREPARE ] { name | ALL }`,
    docUrl: `${PG_DOCS}deallocate.html`,
  },

  // ---------------------------------------------------------------------------
  // Cursors
  // ---------------------------------------------------------------------------
  {
    cmd: 'DECLARE',
    description: 'define a cursor',
    syntax: `DECLARE name [ BINARY ] [ ASENSITIVE | INSENSITIVE ] [ [ NO ] SCROLL ]
    CURSOR [ { WITH | WITHOUT } HOLD ] FOR query`,
    docUrl: `${PG_DOCS}declare.html`,
  },
  {
    cmd: 'FETCH',
    description: 'retrieve rows from a query using a cursor',
    syntax: `FETCH [ direction ] [ FROM | IN ] cursor_name

where direction can be empty or one of:

    NEXT
    PRIOR
    FIRST
    LAST
    ABSOLUTE count
    RELATIVE count
    count
    ALL
    FORWARD
    FORWARD count
    FORWARD ALL
    BACKWARD
    BACKWARD count
    BACKWARD ALL`,
    docUrl: `${PG_DOCS}fetch.html`,
  },
  {
    cmd: 'MOVE',
    description: 'position a cursor',
    syntax: `MOVE [ direction ] [ FROM | IN ] cursor_name

where direction can be empty or one of:

    NEXT | PRIOR | FIRST | LAST
    | ABSOLUTE count | RELATIVE count | count | ALL
    | FORWARD | FORWARD count | FORWARD ALL
    | BACKWARD | BACKWARD count | BACKWARD ALL`,
    docUrl: `${PG_DOCS}move.html`,
  },
  {
    cmd: 'CLOSE',
    description: 'close a cursor',
    syntax: `CLOSE { name | ALL }`,
    docUrl: `${PG_DOCS}close.html`,
  },

  // ---------------------------------------------------------------------------
  // Procedural / misc
  // ---------------------------------------------------------------------------
  {
    cmd: 'CALL',
    description: 'invoke a procedure',
    syntax: `CALL name ( [ argument ] [, ...] )`,
    docUrl: `${PG_DOCS}call.html`,
  },
  {
    cmd: 'DO',
    description: 'execute an anonymous code block',
    syntax: `DO [ LANGUAGE lang_name ] code`,
    docUrl: `${PG_DOCS}do.html`,
  },
];

// ---------------------------------------------------------------------------
// Lookup helpers.
//
// Upstream's matcher is case-insensitive and matches by whitespace-tokenised
// prefix: "create t" matches CREATE TABLE, CREATE TRIGGER, CREATE TYPE; the
// full command name is also accepted. If the input matches an entry exactly
// (case-insensitively), we treat that as a single match even if it's a prefix
// of others — so `\h CREATE` lists everything starting with CREATE rather
// than failing on ambiguity (which matches the spec's "prefix match" wording).
// We additionally accept a single trailing space.
// ---------------------------------------------------------------------------

/** Normalise a topic string for matching. */
const normalize = (s: string): string =>
  s.trim().replace(/\s+/gu, ' ').toUpperCase();

/** Tokenise on whitespace, dropping empties. */
const tokens = (s: string): string[] =>
  s.split(/\s+/u).filter((t) => t.length > 0);

/**
 * Return entries whose `cmd` matches the topic by whitespace-tokenised prefix.
 *
 * Semantics:
 *   - "select"      → [SELECT]
 *   - "CREATE T"    → all CREATE entries starting with "T" (TABLE, TRIGGER, TYPE)
 *   - "CREATE"      → all CREATE entries
 *   - "CREATE TABLE"→ exactly [CREATE TABLE]
 *
 * Each topic token must be a prefix of the entry's token at the same index;
 * the entry must have at least as many tokens as the topic.
 */
export const findMatches = (topic: string): SqlHelpEntry[] => {
  const needle = normalize(topic);
  if (needle.length === 0) return [];
  const needleToks = tokens(needle);

  return SQL_HELP.filter((entry) => {
    const cmdToks = tokens(entry.cmd.toUpperCase());
    if (cmdToks.length < needleToks.length) return false;
    for (let i = 0; i < needleToks.length; i++) {
      if (!cmdToks[i].startsWith(needleToks[i])) return false;
    }
    return true;
  });
};

/**
 * Format a single entry the way upstream `\h` does:
 *
 *   Command:     CMD
 *   Description: DESC
 *   Syntax:
 *   <syntax body>
 *
 *   URL: <docs>
 */
export const formatEntry = (entry: SqlHelpEntry): string => {
  return (
    `Command:     ${entry.cmd}\n` +
    `Description: ${entry.description}\n` +
    `Syntax:\n` +
    `${entry.syntax}\n` +
    `\n` +
    `URL: ${entry.docUrl}\n`
  );
};
