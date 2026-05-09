import pino from 'pino'

// Exported so tests can construct a parallel pino instance using the exact
// production config and verify redaction end-to-end. Paths use pino's
// wildcard syntax: `*.password` matches `password` at any direct child of
// the log record root (e.g. the metadata object passed as the first arg).
export const redactConfig = {
  paths: [
    '*.password',
    '*.token',
    '*.accessToken',
    '*.refreshToken',
    '*.idToken',
    '*.identityToken',
    '*.tokenHash',
    'req.headers.authorization',
    'req.headers.cookie',
    'headers.authorization',
    'headers.cookie',
    'authorization',
    '*.id_token',
    '*.access_token',
    '*.refresh_token',
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
