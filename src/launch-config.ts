/**
 * Public re-export surface for `neonctl/config`.
 *
 * `package.json` `exports["./config"]` points at the compiled
 * `dist/launch-config.{js,d.ts}`. This file lists everything that consumers
 * of the `neon launch` API are allowed to depend on; internals (the
 * `InternalResource` shape, `makeRef`, the type guards) intentionally stay
 * out of the public surface so they can be refactored without a breaking
 * change.
 */
export {
  postgres,
  vercelDeployment,
  localCommand,
  stack,
  type Ref,
  type LaunchContext,
  type FlagValue,
  type PostgresSpec,
  type PostgresOutputs,
  type ConnectionStringCallable,
  type VercelDeploymentSpec,
  type VercelDeploymentOutputs,
  type LocalCommandSpec,
  type LocalCommandReadiness,
  type LocalCommandOutputs,
} from './launch/config.js';

// Intentionally NOT re-exported:
//   Resource, DepsRecord, Resolved, SpecFn — these are internal shapes
//     used to type the factory generics. User-land helpers can rely on
//     factory return-type inference (`const makeSeed = (t: string) =>
//     localCommand({...})`) without naming the underlying types.
//   InternalResource, isInternalResource, makeRef, isRef — launcher
//     internals; would prevent us from refactoring the runtime carriers.
