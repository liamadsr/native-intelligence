'use client'

import { Link } from '@/components/link'
import { Mark } from '@/components/logo'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { createClient } from '@/lib/supabase/client'
import { useSearchParams } from 'next/navigation'
import { useState } from 'react'

const ERROR_MESSAGES: Record<string, string> = {
  unauthorized_domain: "This account isn't a Dial8 admin.",
  auth_failed: 'Authentication failed. Please try again.',
  missing_code: 'Authentication failed. Please try again.',
  google_declined: 'Google sign-in was cancelled.',
  // A personal Google account the signup hook refused is no admin either.
  work_email_required: "This account isn't a Dial8 admin.",
}

export function LoginForm({
  googleOnDial8 = false,
  adminDomain = null,
}: {
  /** Sign in through Dial8's own Google flow (lib/auth/google-sign-in,
   *  decided by the page) instead of Supabase's. */
  googleOnDial8?: boolean
  /** The domain every admin's address shares (ADMIN_EMAILS), if one: Google's
   *  account-chooser hint. */
  adminDomain?: string | null
} = {}) {
  const searchParams = useSearchParams()
  const callbackError = searchParams.get('error')

  const [error, setError] = useState(callbackError ? (ERROR_MESSAGES[callbackError] ?? 'An error occurred.') : '')
  const [googleLoading, setGoogleLoading] = useState(false)

  async function handleGoogleSignIn() {
    setError('')
    setGoogleLoading(true)

    if (googleOnDial8) {
      // /auth/google/callback checks ADMIN_EMAILS and lands on /admin.
      window.location.assign('/auth/google?admin=1')
      return
    }

    const supabase = createClient()
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/admin/auth/callback`,
        ...(adminDomain ? { queryParams: { hd: adminDomain } } : {}),
      },
    })

    if (oauthError) {
      setError(oauthError.message)
      setGoogleLoading(false)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground lg:p-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-start">
            <Link href="/" title="Home">
              <Mark className="h-9 fill-foreground" />
            </Link>
          </div>
          <CardTitle className="mt-4">Admin Sign In</CardTitle>
          <CardDescription>
            {adminDomain ? `Sign in with your @${adminDomain} Google account.` : 'Sign in with your admin Google account.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-400">
              {error}
            </div>
          )}

          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={googleLoading}
            onClick={handleGoogleSignIn}
          >
            <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            {googleLoading ? 'Redirecting...' : 'Sign in with Google'}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
