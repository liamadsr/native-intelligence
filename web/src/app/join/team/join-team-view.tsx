'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Mark } from '@/components/logo'
import { Link } from '@/components/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export interface TeamOffer {
  workspaceId: string
  name: string
  ownerName: string | null
}

/**
 * The workspaces on the person's email domain, one Join each. Join adds
 * them as a member and opens that workspace; "Not now" means none of these
 * is offered again.
 */
export function JoinTeamView({ offers, domain }: { offers: TeamOffer[]; domain: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  async function join(workspaceId: string) {
    setBusy(workspaceId)
    setError('')
    try {
      const res = await fetch('/api/account/workspace/join/domain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? 'Could not join the workspace')
      }
      router.push('/account')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setBusy(null)
    }
  }

  async function notNow() {
    setBusy('dismiss')
    setError('')
    try {
      await fetch('/api/account/workspace/join/domain/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_ids: offers.map((o) => o.workspaceId) }),
      })
    } catch {
      // Not recorded: they are offered again at the next sign-in, nothing worse.
    }
    router.push('/account')
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
          <CardTitle className="mt-4">{offers.length === 1 ? 'Your team is here' : 'Your teams are here'}</CardTitle>
          <CardDescription>
            {domain ? (
              <>
                People with an <strong>@{domain}</strong> email can join {offers.length === 1 ? 'this workspace' : 'these workspaces'}.
              </>
            ) : (
              'You can join these workspaces.'
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-400">
              {error}
            </div>
          )}
          <div className="divide-y rounded-lg border">
            {offers.map((offer) => (
              <div key={offer.workspaceId} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{offer.name}</p>
                  {offer.ownerName && (
                    <p className="truncate text-xs text-muted-foreground">Owner: {offer.ownerName}</p>
                  )}
                </div>
                <Button size="sm" disabled={busy !== null} onClick={() => join(offer.workspaceId)}>
                  {busy === offer.workspaceId ? 'Joining...' : 'Join'}
                </Button>
              </div>
            ))}
          </div>
          <Button variant="ghost" className="w-full" disabled={busy !== null} onClick={notNow}>
            Not now
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
