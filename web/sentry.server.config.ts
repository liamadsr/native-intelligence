// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from '@sentry/nextjs'
import { getSentryEnvironment, isSentryEnabled } from '@/lib/sentry-env'

// Only report from production — dev/preview events are noise.
if (isSentryEnabled()) {
  Sentry.init({
    dsn: 'https://a26853a25b5e2e6f5912e7a6f251b3f0@o4510925258948608.ingest.us.sentry.io/4510925351944192',

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
  })
}
