'use client'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { passwordResetReturnUrl } from '@/lib/auth/password-reset'
import { isDesktopApp } from '@/lib/platform'
import { createClient } from '@/lib/supabase/client'
import { useState } from 'react'

/** What the person is told once a link is on its way: where to open it. */
const SENT: Record<'desktop' | 'browser', string> = {
  browser: 'If an account exists for that email, a reset link is on its way. Open it in this browser.',
  desktop:
    'If an account exists for that email, a reset link is on its way. Open it on this computer and it will bring you back to the app.',
}

/**
 * Ask for a password reset link (the forgot-password page, and the reset
 * page when a link didn't work). The link only works where it was asked for
 * (src/lib/auth/password-reset.ts): in the desktop app it returns to the app,
 * in a browser to this browser's reset page.
 */
export function RequestResetLinkForm({ submitLabel }: { submitLabel: string }) {
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [sent, setSent] = useState<'desktop' | 'browser' | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) return

    setError('')
    setSent(null)
    setLoading(true)

    const where = isDesktopApp() ? 'desktop' : 'browser'
    const supabase = createClient()
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: passwordResetReturnUrl(where, window.location.origin),
    })

    if (resetError) setError(resetError.message)
    else setSent(where)
    setLoading(false)
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-400">
          {error}
        </div>
      )}
      {sent && (
        <div
          role="status"
          className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-900/30 dark:text-green-400"
        >
          {SENT[sent]}
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
          {loading ? 'Sending...' : submitLabel}
        </Button>
      </form>
    </div>
  )
}
