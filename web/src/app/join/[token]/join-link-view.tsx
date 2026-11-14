'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Mark } from '@/components/logo'
import { Link } from '@/components/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/** Where "Sign in to join" goes: the login page, which brings the person back here. */
export function joinSignInHref(path: string): string {
  return `/login?redirect=${encodeURIComponent(path)}`
}

export function JoinLinkView({
  token,
  workspaceName,
  isLoggedIn,
  userEmail,
  alreadyMember,
}: {
  token: string
  workspaceName: string
  isLoggedIn: boolean
  userEmail: string | null
  alreadyMember: boolean
}) {
  const router = useRouter()
  const [joining, setJoining] = useState(false)
  const [error, setError] = useState('')

  async function handleJoin() {
    setJoining(true)
    setError('')
    try {
      const res = await fetch('/api/account/workspace/join/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? 'Could not join the workspace')
      }
      router.push('/account')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setJoining(false)
    }
  }

  function handleSignIn() {
    router.push(joinSignInHref(window.location.pathname))
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
          <CardTitle className="mt-4">Join {workspaceName}</CardTitle>
          <CardDescription>
            {alreadyMember ? (
              <>You&apos;re already in <strong>{workspaceName}</strong>.</>
            ) : (
              <>
                You&apos;ve been invited to join <strong>{workspaceName}</strong> as a Member.
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-400">
              {error}
            </div>
          )}
          {isLoggedIn && userEmail && !alreadyMember && (
            <p className="text-sm text-muted-foreground">
              You&apos;ll join as <span className="text-foreground">{userEmail}</span>.
            </p>
          )}
          {isLoggedIn ? (
            <Button className="w-full" onClick={handleJoin} disabled={joining}>
              {alreadyMember ? (joining ? 'Opening...' : 'Open workspace') : joining ? 'Joining...' : 'Join workspace'}
            </Button>
          ) : (
            <>
              <Button className="w-full" onClick={handleSignIn}>
                Sign in to join
              </Button>
              <p className="text-xs text-muted-foreground">
                New here? Sign up with your work email. For a personal address, ask for an emailed invite.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
