/**
 * A failure the audit can't recover from by trying again, with words for the
 * person who started it. Its own module so discovery and the robots rules can
 * name one without importing the engine.
 */
export type AuditFailureCode =
  | 'NOTHING_TO_CRAWL'
  | 'ROBOTS_DISALLOWED'
  | 'ROBOTS_TOO_COMPLEX'
  | 'ROBOTS_UNREACHABLE'
  | 'SITE_UNREACHABLE'
  | 'START_URL_TOO_LONG'
  | 'AUDIT_NOT_FOUND'

export class AuditFailure extends Error {
  constructor(
    readonly code: AuditFailureCode,
    message: string,
  ) {
    super(message)
    this.name = 'AuditFailure'
  }
}
