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
  type Resource,
  type DepsRecord,
  type Resolved,
  type SpecFn,
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
