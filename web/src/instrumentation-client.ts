// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from '@sentry/nextjs'
import {
  getSentryEnvironment,
  isSentryEnabled,
  SENTRY_IGNORE_ERRORS,
  shouldDropSentryBreadcrumb,
  shouldDropSentryEvent,
} from '@/lib/sentry-env'

// Only report from production — dev/preview events are noise.
if (isSentryEnabled()) {
  Sentry.init({
    dsn: 'https://a26853a25b5e2e6f5912e7a6f251b3f0@o4510925258948608.ingest.us.sentry.io/4510925351944192',

    environment: getSentryEnvironment(),

    // Drop browser noise (Apple Mail / Safari link-prefetch aborts) that fires
    // even in production. See sentry-env.ts for the rationale.
    ignoreErrors: SENTRY_IGNORE_ERRORS,
    beforeSend: (event, hint) => (shouldDropSentryEvent(event, hint) ? null : event),
    // Inside the in-app browser's DOM, click/input breadcrumbs would carry the
    // user's visited URLs + page titles (element title/aria-label). See sentry-env.ts.
    beforeBreadcrumb: (breadcrumb, hint) =>
      shouldDropSentryBreadcrumb(breadcrumb, hint) ? null : breadcrumb,

    // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
    tracesSampleRate: 1,
    // Enable logs to be sent to Sentry
    enableLogs: true,

    // Enable sending user PII (Personally Identifiable Information)
    // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
    sendDefaultPii: true,
  })
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
