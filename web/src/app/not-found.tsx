'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Home } from 'lucide-react'
import { Mark } from '@/components/logo'
import { Button } from '@/components/ui/button'

/**
 * Global 404. Catches any unmatched route — most importantly inside the desktop
 * (Tauri) WebView, where the bare Next.js default 404 leaves users stranded with
 * no chrome and no way out short of restarting the app.
 *
 * The primary action is "Go back" (browser/WebView history). On a desktop
 * cold-start or a direct-loaded bad URL there may be no history to pop, so we
 * fall back to the authenticated home (`/account`). "Go to dashboard" is always
 * available as a hard link in case history navigation can't recover the view.
 */
export default function NotFound() {
  const router = useRouter()

  const goBack = () => {
    // history.length is 1 on a fresh load (no prior entry to return to) — in
    // that case `back()` would be a no-op and leave the user stuck, so route to
    // the dashboard instead.
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back()
    } else {
      router.push('/account')
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 px-6 text-center">
      <div className="flex flex-col items-center gap-5">
        <Mark className="h-12 w-12 fill-muted-foreground/40" />
        <div className="flex flex-col items-center gap-2">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-muted-foreground/60">
            404
          </p>
          <h1 className="text-2xl font-semibold text-foreground">
            We couldn&apos;t find that page
          </h1>
          <p className="max-w-md text-balance text-sm leading-relaxed text-muted-foreground">
            The page you&apos;re looking for doesn&apos;t exist or may have moved.
          </p>
        </div>
      </div>

      <div className="flex flex-col items-center gap-3 sm:flex-row">
        <Button onClick={goBack} className="w-full sm:w-auto">
          <ArrowLeft />
          Go back
        </Button>
        <Button asChild variant="outline" className="w-full sm:w-auto">
          <Link href="/account">
            <Home />
            Go to dashboard
          </Link>
        </Button>
      </div>
    </div>
  )
}
