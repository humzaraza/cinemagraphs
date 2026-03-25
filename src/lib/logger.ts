import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  formatters: {
    level(label) {
      return { level: label }
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
})

// Create child loggers for specific domains
export const pipelineLogger = logger.child({ module: 'pipeline' })
export const reviewLogger = logger.child({ module: 'review-fetcher' })
export const cronLogger = logger.child({ module: 'cron' })
export const apiLogger = logger.child({ module: 'api' })
export const authLogger = logger.child({ module: 'auth' })
