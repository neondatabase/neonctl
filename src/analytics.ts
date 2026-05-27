import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Analytics, TrackParams } from '@segment/analytics-node';
import { isAxiosError } from 'axios';

import { CREDENTIALS_FILE } from './config.js';
import type { Traceparent } from './env.js';
import {
  detectAgentHostSource,
  detectCiProvider,
  detectTerminalHost,
  getGithubEnvVars,
  isCi,
  parseTraceparent,
  sanitizeClientUserAgent,
} from './env.js';
import { ErrorCode } from './errors.js';
import { log } from './log.js';
import pkg from './pkg.js';
import { getApiClient } from './api.js';

const WRITE_KEY = '3SQXn5ejjXWLEJ8xU2PRYhAotLtTaeeV';

let client: Analytics | undefined;
let clientInitialized = false;
// Free-form during resolution (credentials JSON yields `any`, the API
// client may return a number); always coerced to string via getUserId()
// before being handed to Segment.
let userId: string | number = '';

// Coerces a raw user_id value (sourced from JSON.parse and API responses,
// effectively `any`-typed) to a string suitable for Segment's `userId`
// field. Only strings (trimmed, non-empty) and finite non-zero numbers
// are accepted; everything else maps to 'anonymous' so a malformed
// credentials file or unexpected API response can't leak garbage like
// '[object Object]' or '' into the analytics pipeline.
export const coerceUserId = (raw: unknown): string => {
  if (typeof raw === 'number' && raw !== 0 && Number.isFinite(raw)) {
    return String(raw);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed !== '') return trimmed;
  }
  return 'anonymous';
};

const getUserId = (): string => coerceUserId(userId);

/**
 * @internal Test-only escape hatch to reset module-level state between
 * test cases. Not part of the public CLI surface; named with the `__`
 * prefix so it's obviously internal. Lets opt-out / init tests start
 * from a known state without depending on file-level test ordering.
 */
export const __resetAnalyticsForTesting = () => {
  client = undefined;
  clientInitialized = false;
  userId = '';
};

/**
 * Phase 1: Run before validation so the Segment client exists if any
 * middleware (e.g. auth) fails. Enables sendError() in the fail handler.
 * Does not resolve user id or send CLI Started.
 */
export const initAnalyticsClientMiddleware = (args: {
  analytics: boolean;
  [key: string]: unknown;
}) => {
  if (!args.analytics || clientInitialized) {
    return;
  }
  // Mark as attempted regardless of outcome so a persistent init failure
  // can't make every subsequent command retry initialization. If init
  // throws, `client` stays undefined and downstream calls skip via their
  // own `!client` guards.
  clientInitialized = true;
  try {
    client = new Analytics({
      writeKey: WRITE_KEY,
      host: 'https://track.neon.tech',
    });
    log.debug('Initialized CLI analytics client');
    client.identify({
      userId: 'anonymous',
    });
  } catch (err) {
    log.debug('Failed to initialize CLI analytics client', err);
  }
};

/**
 * Phase 2: Run after auth. Resolves user id from credentials,
 * identifies the user, and sends CLI Started.
 */
export const analyticsMiddleware = async (args: {
  analytics: boolean;
  apiKey?: string;
  apiHost?: string;
  configDir: string;
  _: (string | number)[];
  [key: string]: unknown;
}) => {
  if (!client || !args.analytics) {
    return;
  }

  try {
    const credentialsPath = join(args.configDir, CREDENTIALS_FILE);
    const credentials = readFileSync(credentialsPath, { encoding: 'utf-8' });
    userId = JSON.parse(credentials).user_id;
  } catch (err) {
    log.debug('Failed to read credentials file', err);
  }

  try {
    if (args.apiKey) {
      const apiClient = getApiClient({
        apiKey: args.apiKey,
        apiHost: args.apiHost,
      });

      // Populating api key details for analytics
      const authDetailsResponse = await apiClient.getAuthDetails();
      const authDetails = authDetailsResponse.data;
      args.accountId = authDetails.account_id;
      args.authMethod = authDetails.auth_method;
      args.authData = authDetails.auth_data;

      // Get user id if not org api key
      if (!userId && authDetails.auth_method !== 'api_key_org') {
        const resp = await apiClient?.getCurrentUserInfo?.();
        userId = resp?.data?.id;
      }
    } else {
      args.accountId = userId;
      args.authMethod = 'oauth';
    }
  } catch (err) {
    log.debug('Failed to get user id from api', err);
  }

  // Analytics is best-effort: a bug in property derivation or a Segment
  // outage must never break a real CLI command. Swallow + log only.
  try {
    client.identify({
      userId: getUserId(),
    });
    client.track({
      userId: getUserId(),
      event: 'CLI Started',
      properties: getAnalyticsEventProperties(args),
      context: {
        direct: true,
      },
    });
  } catch (err) {
    log.debug('Failed to send CLI Started analytics', err);
  }
};

export const closeAnalytics = async () => {
  if (!client) return;
  // Best-effort: a flush failure (network, DNS, serialization) at shutdown
  // must not crash the CLI's exit path.
  try {
    log.debug('Flushing CLI analytics');
    await client.closeAndFlush();
    log.debug('Flushed CLI analytics');
  } catch (err) {
    log.debug('Failed to flush CLI analytics', err);
  }
};

export const sendError = (err: Error, errCode: ErrorCode) => {
  if (!client) {
    return;
  }
  const axiosError = isAxiosError(err) ? err : undefined;
  const requestId = axiosError?.response?.headers['x-neon-ret-request-id'];
  if (requestId) {
    log.debug('Failed request ID: %s', requestId);
  }
  // Best-effort: derivation or transport failure must not mask the
  // actual error path that's already in flight.
  try {
    client.track({
      event: 'CLI Error',
      userId: getUserId(),
      properties: {
        message: err.message,
        stack: err.stack,
        errCode,
        statusCode: axiosError?.response?.status,
        requestId: requestId,
        ...getEnvAnalyticsProperties(
          process.env,
          Boolean(process.stdout.isTTY),
        ),
      },
    });
    log.debug('Sent CLI error event: %s', errCode);
  } catch (trackErr) {
    log.debug('Failed to send CLI Error analytics', trackErr);
  }
};

export const trackEvent = (
  event: string,
  properties: TrackParams['properties'],
) => {
  if (!client) {
    return;
  }
  // Best-effort: a Segment transport error or a downstream serialization
  // failure must never break the command flow.
  try {
    client.track({
      event,
      userId: getUserId(),
      properties,
    });
    log.debug('Sent CLI event: %s', event);
  } catch (trackErr) {
    log.debug('Failed to send %s analytics', event, trackErr);
  }
};

type EnvDerivedProperties = {
  ci: boolean;
  ciProvider?: string;
  terminalType?: string;
  isTty: boolean;
  agentHostDetected: boolean;
  agentHostSource?: string;
  clientUserAgent?: string;
  traceparent?: Traceparent;
  githubEnvVars: Record<string, string>;
};

export type AnalyticsEventProperties = EnvDerivedProperties & {
  version: string;
  command: string;
  flags: { output?: unknown };
};

// Env-derived signals attached to every analytics event (CLI Started,
// CLI Error, cli_command_success). All event types compose this helper,
// so new env-derived fields should be added here to flow uniformly into
// every event. (`--no-analytics` is enforced upstream — see
// initAnalyticsClientMiddleware / analyticsMiddleware — and prevents any
// of these properties from being emitted at all.)
const getEnvAnalyticsProperties = (
  env: NodeJS.ProcessEnv,
  isTty: boolean,
): EnvDerivedProperties => {
  const traceparent = parseTraceparent(env.TRACEPARENT);
  const clientUserAgent = sanitizeClientUserAgent(env.NEON_CLIENT_USER_AGENT);
  const agentHostSource = detectAgentHostSource(env);
  return {
    ci: isCi(env),
    ciProvider: detectCiProvider(env),
    terminalType: detectTerminalHost(env),
    isTty,
    agentHostDetected: agentHostSource !== undefined,
    agentHostSource,
    ...(clientUserAgent ? { clientUserAgent } : {}),
    ...(traceparent ? { traceparent } : {}),
    githubEnvVars: getGithubEnvVars(env),
  };
};

export const getAnalyticsEventProperties = (
  args: { _: (string | number)[]; output?: unknown; [key: string]: unknown },
  env: NodeJS.ProcessEnv = process.env,
  isTty = Boolean(process.stdout.isTTY),
): AnalyticsEventProperties => ({
  version: pkg.version,
  command: args._.join(' '),
  flags: {
    output: args.output,
  },
  ...getEnvAnalyticsProperties(env, isTty),
});
