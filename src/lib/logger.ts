import pino from 'pino'

// Exported so tests can construct a parallel pino instance using the exact
// production config and verify redaction end-to-end. Paths use pino's
// wildcard syntax: `*.password` matches `password` at any direct child of
// the log record root (e.g. the metadata object passed as the first arg).
export const redactConfig = {
  paths: [
    // Top-level (catches direct logging of these fields)
    'password',
    'token',
    'accessToken',
    'refreshToken',
    'idToken',
    'identityToken',
    'tokenHash',
    // One level deep (catches common wrapper objects)
    '*.password',
    '*.token',
    '*.accessToken',
    '*.refreshToken',
    '*.idToken',
    '*.identityToken',
    '*.tokenHash',
    // Specific known nested paths
    'req.headers.authorization',
    'req.headers.cookie',
    'headers.authorization',
    'headers.cookie',
    'authorization',
    // OAuth provider field names (snake_case variants)
    '*.id_token',
    '*.access_token',
    '*.refresh_token',
    'id_token',
    'access_token',
    'refresh_token',
    // serializeAuthError() output. A failed OAuth token exchange can echo
    // back a partial token payload in the provider response body, so the
    // nested shapes it produces are redacted explicitly (pino's `*` only
    // matches one level).
    'err.body.access_token',
    'err.body.id_token',
    'err.body.refresh_token',
    'err.response.body.access_token',
    'err.response.body.id_token',
    'err.response.body.refresh_token',
    'err.cause.body.access_token',
    'err.cause.body.id_token',
    'err.cause.body.refresh_token',
    'err.cause.response.body.access_token',
    'err.cause.response.body.id_token',
    'err.cause.response.body.refresh_token',
  ],
  censor: '[Redacted]',
}

export const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  formatters: {
    level(label) {
      return { level: label }
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: redactConfig,
})

// Create child loggers for specific domains
export const pipelineLogger = logger.child({ module: 'pipeline' })
export const reviewLogger = logger.child({ module: 'review-fetcher' })
export const cronLogger = logger.child({ module: 'cron' })
export const apiLogger = logger.child({ module: 'api' })
export const authLogger = logger.child({ module: 'auth' })
