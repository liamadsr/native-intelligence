'use client'

import { useEffect, useState } from 'react'
import { Link } from '@/components/link'
import { Mark } from '@/components/logo'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Loader2 } from 'lucide-react'
import { hardNavigate } from '@/app/account/onboarding/hard-navigate'
import { SEAT_PRICE_USD, TRIAL_DAYS, type BillingState } from '@/lib/billing/access'

interface AccessProps {
  state: BillingState
  allowed: boolean
  hasUsedTrial: boolean
  canSkipPayment: boolean
  hasStripe: boolean
}

export function StartTrialView({
  access,
  sessionId,
  email,
  chargeDate,
}: {
  access: AccessProps
  sessionId: string | null
  email: string
  /** Pre-formatted on the server: the day the trial converts if started now. */
  chargeDate: string
}) {
  const [busy, setBusy] = useState<'checkout' | 'skip' | 'portal' | 'confirm' | null>(
    sessionId ? 'confirm' : null,
  )
  const [error, setError] = useState('')

  // Back from Stripe: record the subscription now rather than waiting for
  // the webhook, then go in. hardNavigate (not router.replace) because the
  // dashboard layout's server-side gate must re-run against the new row.
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/billing/checkout/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId }),
        })
        const data = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) {
          setError(data.error ?? 'We could not confirm your subscription. Please try again.')
          setBusy(null)
          return
        }
        hardNavigate('/account')
      } catch {
        if (!cancelled) {
          setError('We could not confirm your subscription. Please try again.')
          setBusy(null)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId])

  async function startCheckout() {
    setBusy('checkout')
    setError('')
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ return: 'start-trial' }),
      })
      const data = await res.json()
      if (data.url) {
        window.location.href = data.url
        return
      }
      setError(data.error ?? 'Failed to start checkout')
    } catch {
      setError('Network error')
    }
    setBusy(null)
  }

  async function skipPayment() {
    setBusy('skip')
    setError('')
    try {
      const res = await fetch('/api/billing/invite-access', { method: 'POST' })
      const data = await res.json()
      if (res.ok) {
        hardNavigate('/account')
        return
      }
      setError(data.error ?? 'Failed to activate access')
    } catch {
      setError('Network error')
    }
    setBusy(null)
  }

  async function openPortal() {
    setBusy('portal')
    setError('')
    try {
      const res = await fetch('/api/billing/portal', { method: 'POST' })
      const data = await res.json()
      if (data.url) {
        window.location.href = data.url
        return
      }
      setError(data.error ?? 'Failed to open billing portal')
    } catch {
      setError('Network error')
    }
    setBusy(null)
  }

  const confirming = busy === 'confirm'
  const pastDue = access.state === 'past_due'
  const secondTime = access.hasUsedTrial && !pastDue

  let title = `Start your ${TRIAL_DAYS}-day free trial`
  let description: React.ReactNode = (
    <>
      Add a card to start. You won&apos;t be charged until <strong>{chargeDate}</strong>. After
      that it&apos;s ${SEAT_PRICE_USD} per user per month. Cancel any time before then and you
      won&apos;t pay anything.
    </>
  )
  let cta = 'Start free trial'
  if (pastDue) {
    title = 'Your payment didn\'t go through'
    description = (
      <>
        We couldn&apos;t charge the card on file for your ${SEAT_PRICE_USD}/month seat. Update your
        payment method to keep using Native Intelligence.
      </>
    )
    cta = 'Update payment method'
  } else if (secondTime) {
    title = 'Subscribe to Native Intelligence'
    description = (
      <>
        Your free trial has already been used. Native Intelligence is ${SEAT_PRICE_USD} per user per month,
        billed monthly. Cancel any time.
      </>
    )
    cta = `Subscribe for $${SEAT_PRICE_USD}/month`
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
          <CardTitle className="mt-4">{confirming ? 'Setting up your account…' : title}</CardTitle>
          <CardDescription>
            {confirming ? 'One moment while we confirm your subscription.' : description}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-400">
              {error}
            </div>
          )}

          {confirming ? (
            <div className="flex items-center justify-center py-4 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (
            <>
              {!pastDue && (
                <ul className="space-y-1 text-sm text-muted-foreground">
                  <li>• Everything included, no usage caps</li>
                  <li>• {secondTime ? 'Billed monthly, cancel any time' : `Free for ${TRIAL_DAYS} days, then $${SEAT_PRICE_USD}/user/month`}</li>
                  <li>• Cancel from Settings → Billing in one click</li>
                </ul>
              )}

              <Button
                className="w-full"
                onClick={pastDue && access.hasStripe ? openPortal : startCheckout}
                disabled={busy !== null}
              >
                {busy === 'checkout' || busy === 'portal' ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                {cta}
              </Button>

              {access.canSkipPayment && !pastDue && (
                <Button
                  variant="ghost"
                  className="w-full"
                  onClick={skipPayment}
                  disabled={busy !== null}
                >
                  {busy === 'skip' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Continue without adding a card
                </Button>
              )}

              <p className="text-center text-xs text-muted-foreground">
                Signed in as {email}.{' '}
                <a href="/sign-out" className="underline-offset-4 hover:underline">
                  Sign out
                </a>
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
