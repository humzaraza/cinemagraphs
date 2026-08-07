/**
 * Fail-closed target check for the local dev seed script.
 *
 * The seed script writes users, films, graphs and reviews. The Neon database
 * behind DATABASE_URL is shared between Vercel Preview and Production, so a
 * seed run pointed at the wrong connection string writes fixture rows into
 * production. This module is the one thing standing between those two
 * outcomes, so it is pure (no env reads, no I/O) and independently testable.
 *
 * Fail-closed means: every path that cannot positively prove the target is the
 * dev database throws. There is no path that returns on uncertainty.
 *
 * Thrown messages name the host, because hosts are not secrets and naming the
 * host is the whole point of the error. They never include the connection
 * string itself, which carries the database password.
 */

/**
 * Substring that identifies the dev Neon endpoint. Both the pooled and the
 * direct host for the dev branch contain it:
 *   ep-cool-lake-...-pooler.c-6.us-east-1.aws.neon.tech
 *   ep-cool-lake-....c-6.us-east-1.aws.neon.tech
 * Matching on the endpoint substring rather than on a full host covers both
 * without a second constant to keep in sync.
 */
const DEV_HOST_MARKER = 'cool-lake'

/**
 * Returns the host of `connectionUrl` when it is the dev database.
 * Throws on anything else, including anything unparseable.
 */
export function assertDevDatabase(connectionUrl: string | undefined): string {
  if (typeof connectionUrl !== 'string' || connectionUrl.trim().length === 0) {
    throw new Error(
      'Refusing to seed: no database connection string was provided. Set the dev database URL in .env.local.'
    )
  }

  let host: string
  try {
    host = new URL(connectionUrl.trim()).hostname
  } catch {
    // The underlying parse error is deliberately swallowed rather than
    // wrapped: it can echo its input, and the input carries credentials.
    throw new Error(
      'Refusing to seed: the database connection string is not a parseable URL.'
    )
  }

  // A URL like "postgres:some-opaque-path" parses but has no host. Treat a
  // missing host the same as a parse failure.
  if (host.length === 0) {
    throw new Error('Refusing to seed: the database connection string has no host.')
  }

  if (!host.includes(DEV_HOST_MARKER)) {
    throw new Error(
      `Refusing to seed: host "${host}" is not the dev database (expected a host containing "${DEV_HOST_MARKER}").`
    )
  }

  return host
}
