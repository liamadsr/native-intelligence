'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Mark } from '@/components/logo'
import { Link } from '@/components/link'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

interface InviteData {
  token: string
  email: string
  role: string
  workspaceName: string
  workspaceLogo: string | null
  inviterName: string
}

const ROLE_LABELS: Record<string, string> = {
  admin: 'an Admin',
  member: 'a Member',
  guest: 'a Guest',
}

export function InviteAcceptView({
  invite,
  isLoggedIn,
  userEmail,
}: {
  invite: InviteData
  isLoggedIn: boolean
  userEmail: string | null
}) {
  const router = useRouter()
  const [accepting, setAccepting] = useState(false)
  const [error, setError] = useState('')

  const emailMismatch =
    isLoggedIn &&
    userEmail &&
    userEmail.toLowerCase() !== invite.email.toLowerCase()

  async function handleAccept() {
    setAccepting(true)
    setError('')
    try {
      const res = await fetch('/api/account/workspace/invites/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: invite.token }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Failed to accept invite')
      }

      const data = await res.json()
      router.push('/account')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setAccepting(false)
    }
  }

  function handleSignIn() {
    const currentPath = window.location.pathname
    router.push(`/login?redirect=${encodeURIComponent(currentPath)}`)
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
          <CardTitle className="mt-4">
            Join {invite.workspaceName}
          </CardTitle>
          <CardDescription>
            {invite.inviterName} invited you to join{' '}
            <strong>{invite.workspaceName}</strong> as{' '}
            {ROLE_LABELS[invite.role] ?? `a ${invite.role}`}.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-400">
              {error}
            </div>
          )}

          <div className="rounded-lg border px-4 py-3">
            <p className="text-xs text-muted-foreground">Invite details</p>
            <div className="mt-2 space-y-1">
              <p className="text-sm">
                <span className="text-muted-foreground">Workspace: </span>
                {invite.workspaceName}
              </p>
              <div className="flex items-center gap-1 text-sm">
                <span className="text-muted-foreground">Role: </span>
                <Badge variant="outline" className="capitalize">
                  {invite.role}
                </Badge>
              </div>
              <p className="text-sm">
                <span className="text-muted-foreground">Email: </span>
                {invite.email}
              </p>
            </div>
          </div>

          {emailMismatch ? (
            <div className="rounded-lg bg-yellow-50 px-3 py-2 text-sm text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">
              This invite was sent to <strong>{invite.email}</strong> but you
              are signed in as <strong>{userEmail}</strong>. Please sign in
              with the correct account.
            </div>
          ) : isLoggedIn ? (
            <Button
              className="w-full"
              onClick={handleAccept}
              disabled={accepting}
            >
              {accepting ? 'Accepting...' : 'Accept Invite'}
            </Button>
          ) : (
            <Button className="w-full" onClick={handleSignIn}>
              Sign in to accept
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
