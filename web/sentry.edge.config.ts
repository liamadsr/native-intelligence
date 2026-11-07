// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// The config you add here will be used whenever one of the edge features is loaded.
// Note that this config is unrelated to the Vercel Edge Runtime and is also required when running locally.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from '@sentry/nextjs'
import { getSentryEnvironment, isSentryEnabled } from '@/lib/sentry-env'

// Only report from production — dev/preview events are noise.
if (isSentryEnabled()) {
  Sentry.init({
    dsn: 'https://a26853a25b5e2e6f5912e7a6f251b3f0@o4510925258948608.ingest.us.sentry.io/4510925351944192',

    environment: getSentryEnvironment(),

    // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
    tracesSampleRate: 1,

    // Enable logs to be sent to Sentry
    enableLogs: true,

    // Enable sending user PII (Personally Identifiable Information)
    // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
    sendDefaultPii: true,
  })
}
