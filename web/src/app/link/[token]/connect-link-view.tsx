'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Mark } from '@/components/logo'
import { Link } from '@/components/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export type ConnectLinkState =
  | { kind: 'invalid' }
  | { kind: 'signed_out'; requesterName: string; workspaceName: string | null }
  | { kind: 'own'; requesterName: string; workspaceName: string | null }
  | { kind: 'review'; requesterName: string; workspaceName: string | null; userEmail: string | null }

/** What the redeem route's refusals mean to the person holding the link. */
const REFUSALS: Record<string, string> = {
  invalid: 'This link has expired or was already used. Ask for a new one.',
  self: 'This is your own connect link. Send it to the person you want your agent to talk to.',
  wrong_account: 'This request was sent to a different account. Sign in with the email it was sent to.',
  already_linked: 'Your agents are already connected, or one of you has already asked.',
}

export function ConnectLinkView({ token, state }: { token: string; state: ConnectLinkState }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const from = state.kind === 'invalid' ? null : state.workspaceName ? `${state.requesterName} (${state.workspaceName})` : state.requesterName

  async function review() {
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/account/agent-links/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const data = (await res.json().catch(() => ({}))) as { linkId?: string; code?: string; error?: string }
      if (!res.ok || !data.linkId) {
        setError(REFUSALS[data.code ?? ''] ?? data.error ?? 'Something went wrong. Try again.')
        setBusy(false)
        return
      }
      router.push(`/account?agent-link=${encodeURIComponent(data.linkId)}`)
    } catch {
      setError('Something went wrong. Try again.')
      setBusy(false)
    }
  }

  function signIn(mode: 'signin' | 'signup') {
    const redirect = encodeURIComponent(window.location.pathname)
    router.push(`/login?redirect=${redirect}${mode === 'signup' ? '&mode=signup' : ''}`)
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-6 text-foreground lg:p-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-start">
            <Link href="/" title="Home">
              <Mark className="h-9 fill-foreground" />
            </Link>
          </div>
          <CardTitle className="mt-4">{state.kind === 'invalid' ? 'This link no longer works' : 'Connect your agents'}</CardTitle>
          <CardDescription>
            {state.kind === 'invalid' ? (
              REFUSALS.invalid
            ) : (
              <>
                <strong>{from}</strong> wants their Dial8 agent to talk to yours, so the two can find times and answer each other&apos;s questions.
              </>
            )}
          </CardDescription>
        </CardHeader>
        {state.kind !== 'invalid' && (
          <CardContent className="space-y-4">
            {error && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-400" data-connect-error>
                {error}
              </div>
            )}
            <p className="text-sm text-muted-foreground">
              Nothing is shared until you accept. You choose what their agent may ask yours, and either of you can disconnect at any time.
            </p>
            {state.kind === 'own' ? (
              <div className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">{REFUSALS.self}</div>
            ) : state.kind === 'review' ? (
              <>
                <Button className="w-full" onClick={review} disabled={busy} data-connect-review>
                  {busy ? 'Opening…' : 'Review request'}
                </Button>
                {state.userEmail && <p className="text-center text-xs text-muted-foreground">Signed in as {state.userEmail}</p>}
              </>
            ) : (
              <div className="space-y-2">
                <Button className="w-full" onClick={() => signIn('signin')} data-connect-sign-in>
                  Sign in to review
                </Button>
                <Button className="w-full" variant="outline" onClick={() => signIn('signup')} data-connect-sign-up>
                  New to Dial8? Create an account
                </Button>
              </div>
            )}
          </CardContent>
        )}
      </Card>
    </div>
  )
}
