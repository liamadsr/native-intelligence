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
import { useState } from 'react'

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) return

    setError('')
    setSuccess('')
    setLoading(true)

    const supabase = createClient()
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      email.trim(),
      {
        redirectTo: `${window.location.origin}/reset-password`,
      },
    )

    if (resetError) {
      setError(resetError.message)
    } else {
      setSuccess(
        'If an account exists for that email, a reset link is on its way.',
      )
    }
    setLoading(false)
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
          <CardTitle className="mt-4">Reset your password</CardTitle>
          <CardDescription>
            Enter the email associated with your account. We&apos;ll send you a
            link to set a new password.
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

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Sending...' : 'Send reset link'}
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
