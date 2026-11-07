'use client'

import { useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  closeUsageLimit,
  getUsageLimitSnapshot,
  subscribeUsageLimit,
  type UsageLimitInfo,
} from '@/lib/usage-limit-store'

const TOP_UP_AMOUNTS = [5, 10, 25, 50] as const

/**
 * Global dialog shown whenever any AI request returns 429 "Usage limit
 * exceeded". Mounted once in the account dashboard shell; the fetch
 * interceptor in lib/workspace-fetch.ts opens it as a side effect whenever
 * a same-origin /api/ response comes back with a usage-limit 429.
 */
export function UsageLimitDialog() {
  const info = useSyncExternalStore(
    subscribeUsageLimit,
    getUsageLimitSnapshot,
    () => null, // server snapshot — dialog is client-only
  )
  const [topupLoading, setTopupLoading] = useState<number | null>(null)

  const open = info !== null
  const isPaid = info?.isPaidPlan === true

  async function buyCredits(amountUsd: number) {
    setTopupLoading(amountUsd)
    try {
      const res = await fetch('/api/billing/credits/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount_usd: amountUsd }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        console.error('Top-up checkout failed:', body)
        toast.error((body as { error?: string }).error || 'Couldn’t start checkout. Try again.')
        return
      }
      const { url } = (await res.json()) as { url?: string }
      if (url) window.location.href = url
    } catch (err) {
      console.error('Top-up checkout failed:', err)
      toast.error('Couldn’t start checkout. Try again.')
    } finally {
      setTopupLoading(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && closeUsageLimit()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title(info)}</DialogTitle>
          <DialogDescription>{description(info)}</DialogDescription>
        </DialogHeader>

        {isPaid && (
          <div className="space-y-3">
            <p className="text-sm font-medium">Buy more credits</p>
            <div className="grid grid-cols-2 gap-2">
              {TOP_UP_AMOUNTS.map((amount) => (
                <Button
                  key={amount}
                  variant="outline"
                  disabled={topupLoading !== null}
                  onClick={() => buyCredits(amount)}
                >
                  {topupLoading === amount ? 'Loading…' : `$${amount}`}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Credits roll over and are used before next month&apos;s allowance.
            </p>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={closeUsageLimit}>
            {isPaid ? 'Got it' : 'Dismiss'}
          </Button>
          {!isPaid && (
            <Button asChild>
              <Link href="/account/settings/billing" onClick={closeUsageLimit}>
                Upgrade to Pro
              </Link>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function title(info: UsageLimitInfo | null): string {
  if (!info) return ''
  if (info.isPaidPlan) return 'You\'ve used up this month\'s tokens'
  return 'You\'ve used up your allowance'
}

function description(info: UsageLimitInfo | null): string {
  if (!info) return ''
  if (info.isPaidPlan) {
    const resetCopy = formatResetCopy(info.usageResetDate)
    const resetLine = resetCopy
      ? `Your plan ${resetCopy}.`
      : 'Your plan will reset at the start of next month.'
    return `${resetLine} You can also top up to keep going right now.`
  }
  return 'Upgrade to a Pro plan to continue using AI features.'
}

function formatResetCopy(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  const fmt: Intl.DateTimeFormatOptions = sameYear
    ? { month: 'long', day: 'numeric' }
    : { month: 'long', day: 'numeric', year: 'numeric' }
  return `resets on ${d.toLocaleDateString(undefined, fmt)}`
}
