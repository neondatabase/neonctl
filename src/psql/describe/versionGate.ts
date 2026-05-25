/**
 * Server-version comparison helpers.
 *
 * PostgreSQL encodes server_version_num as MMmmpp (e.g. 9.6.0 -> 90600,
 * 10.0 -> 100000, 17.0 -> 170000). See `PG_VERSION_NUM` in upstream.
 *
 * These helpers replace the inline `pset.sversion >= N` checks that pepper
 * `describe.c`. Keeping them in one place lets a future WP centrally adjust
 * minimum-supported-version policy.
 */

export type ServerVersion = number;

/**
 * Encode major[.minor] into the server_version_num integer form.
 * For PG >= 10 the minor component is ignored (single-component versioning).
 *
 * `major` may also be an already-encoded `ServerVersion` (>= 10000), in which
 * case it is returned unchanged — this lets callers pass either the bare
 * major number (e.g. `11`) or one of the `PG_*` constants (e.g. `PG_11`).
 */
const encode = (major: number, minor = 0): ServerVersion => {
  if (major >= 10000) return major; // already encoded
  if (major >= 10) return major * 10000;
  return major * 10000 + minor * 100;
};

export const serverAtLeast = (
  actual: ServerVersion,
  major: number,
  minor = 0,
): boolean => actual >= encode(major, minor);

export const serverLess = (
  actual: ServerVersion,
  major: number,
  minor = 0,
): boolean => actual < encode(major, minor);

export const PG_9_0: ServerVersion = 90000;
export const PG_9_1: ServerVersion = 90100;
export const PG_9_2: ServerVersion = 90200;
export const PG_9_3: ServerVersion = 90300;
export const PG_9_4: ServerVersion = 90400;
export const PG_9_5: ServerVersion = 90500;
export const PG_9_6: ServerVersion = 90600;
export const PG_10: ServerVersion = 100000;
export const PG_11: ServerVersion = 110000;
export const PG_12: ServerVersion = 120000;
export const PG_13: ServerVersion = 130000;
export const PG_14: ServerVersion = 140000;
export const PG_15: ServerVersion = 150000;
export const PG_16: ServerVersion = 160000;
export const PG_17: ServerVersion = 170000;
export const PG_18: ServerVersion = 180000;
