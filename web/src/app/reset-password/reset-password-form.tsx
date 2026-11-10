'use client'

import { Link } from '@/components/link'
import { Logo } from '@/components/logo'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { resetLinkProblem, type ResetLinkProblem } from '@/lib/auth/password-reset'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { RequestResetLinkForm } from '../forgot-password/request-reset-link-form'

/** What the page says when the link didn't open it, before offering a new one. */
const PROBLEM_MESSAGES: Record<ResetLinkProblem, string> = {
  opened_elsewhere:
    'This reset link has to be opened in the browser or app where you asked for it. Open it there, or ask for a new link here.',
  expired: 'This reset link has expired or has already been used. Ask for a new link here.',
  failed:
    "This reset link didn't work. A reset link works once, and only in the browser or app where you asked for it. Ask for a new link here.",
}

export function ResetPasswordForm({
  linkError,
}: {
  /** The reset link came back with this `?error=`: it's spent, whatever
   *  session this browser already has (a password set now would go to that
   *  one), so the new-password form stays shut. */
  linkError?: string
}) {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [loading, setLoading] = useState(false)
  const linkProblem = resetLinkProblem(linkError)
  const [hasRecoverySession, setHasRecoverySession] = useState<boolean | null>(
    linkProblem ? false : null,
  )

  useEffect(() => {
    if (linkProblem) return
    // The reset link reaches this page with its code already exchanged for a
    // recovery session: by /auth/confirm in a browser, by the desktop app's
    // deep-link handler in the app. No session means the link didn't work.
    const supabase = createClient()
    supabase.auth.getSession().then(({ data }) => {
      setHasRecoverySession(Boolean(data.session))
    })
  }, [linkProblem])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }

    setError('')
    setSuccess('')
    setLoading(true)

    const supabase = createClient()
    const { error: updateError } = await supabase.auth.updateUser({ password })

    if (updateError) {
      setError(updateError.message)
      setLoading(false)
      return
    }

    setSuccess('Password updated. Redirecting...')
    router.replace('/account')
    router.refresh()
  }

  // The link didn't open a recovery session: say why, and offer a new link
  // right here (it will work here, where it's asked for).
  const problem = linkProblem ?? (hasRecoverySession === false ? 'failed' : null)

  return (
    <div className="flex min-h-dvh items-center justify-center p-6 text-foreground lg:p-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex justify-center">
            <Link href="/" title="Home">
              <Logo className="h-9" />
            </Link>
          </div>
          <CardTitle className="mt-4">{problem ? 'Reset your password' : 'Set a new password'}</CardTitle>
          <CardDescription>
            {problem
              ? 'We can send you a new link to set a new password.'
              : 'Choose a new password for your Native Intelligence account.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {problem ? (
            <>
              <div
                role="alert"
                className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
              >
                {PROBLEM_MESSAGES[problem]}
              </div>
              <RequestResetLinkForm submitLabel="Send a new link" />
            </>
          ) : (
            <>
              {error && (
                <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-400">
                  {error}
                </div>
              )}
              {success && (
                <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-900/30 dark:text-green-400">
                  {success}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="password">New password</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="new-password"
                    placeholder="At least 8 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    minLength={8}
                    required
                    disabled={hasRecoverySession !== true}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="confirm">Confirm password</Label>
                  <Input
                    id="confirm"
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    minLength={8}
                    required
                    disabled={hasRecoverySession !== true}
                  />
                </div>
                <Button
                  type="submit"
                  className="w-full"
                  disabled={loading || hasRecoverySession !== true}
                >
                  {loading ? 'Saving...' : 'Update password'}
                </Button>
              </form>
            </>
          )}

          <div className="text-center text-sm text-muted-foreground">
            <Link href="/login" className="hover:text-foreground">
              Back to sign in
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
