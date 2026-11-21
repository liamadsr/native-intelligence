'use client'

import * as Sentry from '@sentry/nextjs'
import NextError from 'next/error'
import { useEffect } from 'react'
import { isChunkLoadFailure, markBooted } from '@/components/boot-mark'

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string }
}) {
  useEffect(() => {
    Sentry.captureException(error)
    // This page replaces the root layout, so BootMark never runs. A crash in the app's own code is
    // reported above and shown here: the boot watchdog must not reload it and cover it. A chunk that
    // failed to load is the watchdog's case, so it is left to reload the page.
    if (!isChunkLoadFailure(error)) markBooted()
  }, [error])

  return (
    <html lang="en">
      <body>
        {/* `NextError` is the default Next.js error page component. Its type
        definition requires a `statusCode` prop. However, since the App Router
        does not expose status codes for errors, we simply pass 0 to render a
        generic error message. */}
        <NextError statusCode={0} />
      </body>
    </html>
  )
}
