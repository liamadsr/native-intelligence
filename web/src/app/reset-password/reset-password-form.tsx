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
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

export function ResetPasswordForm({
  linkFailed = false,
}: {
  /** The reset link came back with an error: it's spent, whatever session
   *  this browser already has (a password set now would go to that one). */
  linkFailed?: boolean
}) {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [loading, setLoading] = useState(false)
  const [hasRecoverySession, setHasRecoverySession] = useState<boolean | null>(
    linkFailed ? false : null,
  )

  useEffect(() => {
    if (linkFailed) return
    // The reset email's link (via /auth/confirm) lands here with a PKCE
    // `?code=`, which the browser client exchanges for a recovery session
    // with the verifier it kept. No session means the link failed.
    const supabase = createClient()
    supabase.auth.getSession().then(({ data }) => {
      setHasRecoverySession(Boolean(data.session))
    })
  }, [linkFailed])

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

  return (
    <div className="flex min-h-dvh items-center justify-center p-6 text-foreground lg:p-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex justify-center">
            <Link href="/" title="Home">
              <Logo className="h-9" />
            </Link>
          </div>
          <CardTitle className="mt-4">Set a new password</CardTitle>
          <CardDescription>
            Choose a new password for your Dial8 account.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
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

          {hasRecoverySession === false && (
            <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
              This reset link is invalid or has expired. Request a new one from
              the{' '}
              <Link href="/forgot-password" className="underline">
                forgot password
              </Link>{' '}
              page.
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
                disabled={hasRecoverySession === false}
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
                disabled={hasRecoverySession === false}
              />
            </div>
            <Button
              type="submit"
              className="w-full"
              disabled={loading || hasRecoverySession === false}
            >
              {loading ? 'Saving...' : 'Update password'}
            </Button>
          </form>

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
