// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from '@sentry/nextjs'
import { getSentryDsn, getSentryEnvironment, isSentryEnabled } from '@/lib/sentry-env'
import { scrubSentryEvent } from '@/lib/privacy/join-token-redaction'

// Only report from production, and only when NEXT_PUBLIC_SENTRY_DSN is set:
// dev/preview events are noise, and a copy without a DSN has no Sentry.
if (isSentryEnabled()) {
  Sentry.init({
    dsn: getSentryDsn(),

    environment: getSentryEnvironment(),

    // Node surfaces a client disconnecting mid-request as `Error: aborted`
    // (message is exactly "aborted") from the http stack — not an app failure.
    // Anchored so real errors that merely mention "aborted" still report.
    ignoreErrors: [/^aborted$/],

    // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
    tracesSampleRate: 1,

    // Enable logs to be sent to Sentry
    enableLogs: true,

    // Enable sending user PII (Personally Identifiable Information)
    // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
    sendDefaultPii: true,

    // A workspace join link (/join/<token>) admits whoever holds it: its
    // token is blanked in request URLs, headers, breadcrumbs and transaction
    // names (src/lib/privacy/join-token-redaction.ts).
    beforeSend: (event) => scrubSentryEvent(event),
    beforeSendTransaction: (event) => scrubSentryEvent(event),
    beforeSendLog: (log) => scrubSentryEvent(log),
    beforeBreadcrumb: (breadcrumb) => scrubSentryEvent(breadcrumb),
  })
}
