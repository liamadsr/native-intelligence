'use client'

import { Fragment, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Check, Clock, Coins, CreditCard, Crown, ExternalLink, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { invalidateBillingCache } from '@/hooks/use-plan'

interface BillingStatus {
  plan: {
    name: string
    display_name: string
    cost_limit: number | null
  }
  subscription: {
    status: string
    cancel_at_period_end: boolean
    current_period_end: string
    has_stripe: boolean
  } | null
  usage: {
    cost_used: number
    cost_limit: number | null
    tokens: number
    requests: number
    resets_at: string | null
  }
  trial: {
    active: boolean
    ends_at: string | null
    days_remaining: number
  }
  credits: {
    balance_usd: number
    lifetime_granted_usd: number
    lifetime_consumed_usd: number
  }
  plans: Array<{
    name: string
    display_name: string
    description: string | null
    feature_highlights: string[]
    price_display: string | null
    price_subtext: string | null
    monthly_cost_limit_usd: number | null
    stripe_price_id: string | null
    badge_text: string | null
    sort_order: number
  }>
}

export function BillingView() {
  const searchParams = useSearchParams()
  const [status, setStatus] = useState<BillingStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const upgraded = searchParams.get('upgraded') === '1'
  const creditsAdded = searchParams.get('credits_added') === '1'

  useEffect(() => {
    fetchStatus()
    // Webhooks arrive a few seconds after Stripe redirects back. If the user
    // just upgraded or topped up, retry until we see the change reflected.
    if (upgraded || creditsAdded) {
      // Drop other components' cached billing snapshot so they re-fetch too
      // (sidebar plan/credits pills, usage-limit dialog, etc.).
      invalidateBillingCache()
      const start = Date.now()
      const poll = setInterval(() => {
        if (Date.now() - start > 15000) {
          clearInterval(poll)
          return
        }
        fetchStatus()
      }, 2000)
      return () => clearInterval(poll)
    }
  }, [upgraded, creditsAdded])

  async function fetchStatus() {
    try {
      const res = await fetch('/api/billing/status')
      if (res.ok) {
        setStatus(await res.json())
      }
    } finally {
      setLoading(false)
    }
  }

  async function handleUpgrade() {
    setActionLoading('upgrade')
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ return: 'billing' }),
      })
      const data = await res.json()
      if (data.url) {
        window.location.href = data.url
      } else {
        alert(data.error ?? 'Failed to create checkout session')
      }
    } finally {
      setActionLoading(null)
    }
  }

  async function handleBuyCredits(amountUsd: number) {
    setActionLoading(`credits-${amountUsd}`)
    try {
      const res = await fetch('/api/billing/credits/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount_usd: amountUsd }),
      })
      const data = await res.json()
      if (data.url) {
        window.location.href = data.url
      } else {
        alert(data.error ?? 'Failed to start credit purchase')
      }
    } finally {
      setActionLoading(null)
    }
  }

  async function handleManageSubscription() {
    setActionLoading('portal')
    try {
      const res = await fetch('/api/billing/portal', { method: 'POST' })
      const data = await res.json()
      if (data.url) {
        window.location.href = data.url
      } else {
        alert(data.error ?? 'Failed to open billing portal')
      }
    } finally {
      setActionLoading(null)
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-32 animate-pulse rounded-lg bg-muted" />
        <div className="h-64 animate-pulse rounded-lg bg-muted" />
      </div>
    )
  }

  if (!status) {
    return (
      <p className="text-sm text-muted-foreground">
        Failed to load billing information. Please try again.
      </p>
    )
  }

  const isSubscriber = status.plan.name === 'subscriber'
  const usagePercent = status.usage.cost_limit
    ? Math.min(100, (status.usage.cost_used / status.usage.cost_limit) * 100)
    : 0

  return (
    <div className="space-y-8">
      {/* Upgrade success banner */}
      {upgraded && (
        <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
          <p className="text-sm font-medium text-primary">
            Welcome to Dial8 Pro! Your subscription is now active.
          </p>
        </div>
      )}

      {/* Credits added banner */}
      {creditsAdded && (
        <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
          <p className="text-sm font-medium text-primary">
            Credits added. Your balance will appear within a minute.
          </p>
        </div>
      )}

      {/* Current Plan & Usage */}
      <div>
        <h2 className="mb-4 text-base font-semibold">Current Plan</h2>
        <div className="overflow-hidden rounded-lg border">
          <div className="flex items-center justify-between border-b p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                {isSubscriber ? (
                  <Crown className="h-5 w-5 text-primary" />
                ) : (
                  <CreditCard className="h-5 w-5 text-muted-foreground" />
                )}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">
                    {isSubscriber ? 'Pro' : 'No plan'}
                  </span>
                  {isSubscriber ? (
                    <Badge variant="default" className="text-xs">
                      {status.trial.active ? 'Free trial' : 'Active'}
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-xs">
                      Inactive
                    </Badge>
                  )}
                </div>
                {isSubscriber && status.subscription && status.trial.active ? (
                  <p className="flex items-center gap-1 text-sm text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {status.subscription.cancel_at_period_end
                      ? `Trial ends ${new Date(status.subscription.current_period_end).toLocaleDateString()} — you won't be charged.`
                      : `${status.trial.days_remaining} day${status.trial.days_remaining !== 1 ? 's' : ''} left — $99/month starts ${new Date(status.subscription.current_period_end).toLocaleDateString()}. Cancel any time before then.`}
                  </p>
                ) : isSubscriber && status.subscription ? (
                  <p className="text-sm text-muted-foreground">
                    {!status.subscription.has_stripe
                      ? 'Complimentary access'
                      : status.subscription.cancel_at_period_end
                        ? `Cancels on ${new Date(status.subscription.current_period_end).toLocaleDateString()}`
                        : `Renews on ${new Date(status.subscription.current_period_end).toLocaleDateString()}`}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Start a free trial to use Dial8.
                  </p>
                )}
              </div>
            </div>
            {isSubscriber ? (
              status.subscription?.has_stripe && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleManageSubscription}
                  disabled={actionLoading === 'portal'}
                >
                  {actionLoading === 'portal' ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Manage Subscription
                </Button>
              )
            ) : (
              <Button
                size="sm"
                onClick={handleUpgrade}
                disabled={actionLoading === 'upgrade'}
              >
                {actionLoading === 'upgrade' ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Crown className="mr-1.5 h-3.5 w-3.5" />
                )}
                Start free trial
              </Button>
            )}
          </div>

          {/* Usage */}
          {status.usage.cost_limit != null && (
            <div className="p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm text-muted-foreground">AI Usage This Period</span>
                {(() => {
                  // Prefer the allowance's actual reset date (aligned to the
                  // billing period post-mig-199); fall back to the subscription
                  // period end when the plan row hasn't surfaced one yet.
                  const resetsAt = status.usage.resets_at ?? status.subscription?.current_period_end ?? null
                  return resetsAt ? (
                    <span className="text-xs text-muted-foreground">
                      Resets {new Date(resetsAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </span>
                  ) : null
                })()}
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    usagePercent < 50
                      ? 'bg-primary'
                      : usagePercent < 80
                        ? 'bg-primary/70'
                        : 'bg-destructive',
                  )}
                  style={{ width: `${usagePercent}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Credits */}
      <CreditsSection
        credits={status.credits}
        actionLoading={actionLoading}
        onBuy={handleBuyCredits}
      />

      {/* Plans comparison table */}
      <PlanComparisonTable
        isSubscriber={isSubscriber}
        hasStripe={status.subscription?.has_stripe ?? false}
        actionLoading={actionLoading}
        onUpgrade={handleUpgrade}
        onManage={handleManageSubscription}
      />
    </div>
  )
}

/* ── Credits section ── */

const TOP_UP_AMOUNTS = [5, 10, 25, 50] as const

function CreditsSection({
  credits,
  actionLoading,
  onBuy,
}: {
  credits: BillingStatus['credits']
  actionLoading: string | null
  onBuy: (amountUsd: number) => void
}) {
  const isLoading = actionLoading?.startsWith('credits-') ?? false

  return (
    <div>
      <h2 className="mb-4 text-base font-semibold">Credits</h2>
      <div className="rounded-lg border p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Coins className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Available balance</p>
              <p className="text-2xl font-semibold tabular-nums">
                ${credits.balance_usd.toFixed(2)}
              </p>
            </div>
          </div>
          {credits.lifetime_granted_usd > 0 && (
            <div className="text-right text-xs text-muted-foreground">
              <p>${credits.lifetime_granted_usd.toFixed(2)} lifetime granted</p>
              <p>${credits.lifetime_consumed_usd.toFixed(2)} consumed</p>
            </div>
          )}
        </div>

        <div className="mt-4 border-t pt-4">
          <p className="mb-2 text-sm font-medium">Buy more credits</p>
          <p className="mb-3 text-xs text-muted-foreground">
            Used after your monthly allowance runs out. Credits don&apos;t expire.
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {TOP_UP_AMOUNTS.map((amount) => (
              <Button
                key={amount}
                variant="outline"
                disabled={isLoading}
                onClick={() => onBuy(amount)}
              >
                {actionLoading === `credits-${amount}` ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  `$${amount}`
                )}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── Feature comparison data ── */

type FeatureValue = true | false | string

interface FeatureRow {
  name: string
  free: FeatureValue
  pro: FeatureValue
  enterprise: FeatureValue
}

interface FeatureSection {
  title: string
  rows: FeatureRow[]
}

const FEATURE_SECTIONS: FeatureSection[] = [
  {
    title: 'Usage',
    rows: [
      { name: 'Team members',         free: '2',         pro: '$99 per seat', enterprise: 'Volume pricing' },
      { name: 'Workspaces',           free: '1',         pro: '5',         enterprise: 'Unlimited' },
    ],
  },
  {
    title: 'Capture',
    rows: [
      { name: 'Meeting capture',      free: true,  pro: true,  enterprise: true },
      { name: 'Transcription',        free: true,  pro: true,  enterprise: true },
      { name: 'Action extraction',    free: true,  pro: true,  enterprise: true },
      { name: 'Voice identification', free: false, pro: true,  enterprise: true },
    ],
  },
  {
    title: 'AI',
    rows: [
      { name: 'AI assistant',         free: true,  pro: true,  enterprise: true },
      { name: 'Advanced AI models',   free: false, pro: true,  enterprise: true },
      { name: 'AI email drafts',      free: false, pro: true,  enterprise: true },
      { name: 'Custom agents & skills', free: false, pro: true,  enterprise: true },
    ],
  },
  {
    title: 'Productivity',
    rows: [
      { name: 'Actions & projects',   free: true,  pro: true,  enterprise: true },
      { name: 'CRM & contacts',       free: true,  pro: true,  enterprise: true },
      { name: 'Custom views',         free: false, pro: true,  enterprise: true },
      { name: 'Workflows',            free: false, pro: true,  enterprise: true },
      { name: 'Outreach sequences',   free: false, pro: true,  enterprise: true },
    ],
  },
  {
    title: 'Integrations',
    rows: [
      { name: 'Calendar sync',        free: true,  pro: true,  enterprise: true },
      { name: 'Email integration',    free: false, pro: true,  enterprise: true },
      { name: 'GitHub integration',   free: false, pro: true,  enterprise: true },
      { name: 'MCP server',           free: false, pro: true,  enterprise: true },
      { name: 'Custom integrations',  free: false, pro: false, enterprise: true },
    ],
  },
  {
    title: 'Administration',
    rows: [
      { name: 'Team management',      free: true,  pro: true,  enterprise: true },
      { name: 'SSO & advanced auth',  free: false, pro: false, enterprise: true },
      { name: 'Dedicated support',    free: false, pro: false, enterprise: true },
      { name: 'SLA guarantees',       free: false, pro: false, enterprise: true },
      { name: 'Priority support',     free: false, pro: true,  enterprise: true },
    ],
  },
]

function FeatureCell({ value }: { value: FeatureValue }) {
  if (value === true) {
    return <Check className="mx-auto h-4 w-4 text-foreground/70" />
  }
  if (value === false) {
    return <span className="block text-center text-muted-foreground/40">&mdash;</span>
  }
  return <span className="block text-center text-sm">{value}</span>
}

function PlanComparisonTable({
  isSubscriber,
  hasStripe,
  actionLoading,
  onUpgrade,
  onManage,
}: {
  isSubscriber: boolean
  hasStripe: boolean
  actionLoading: string | null
  onUpgrade: () => void
  onManage: () => void
}) {
  return (
    <div>
      <h2 className="mb-4 text-base font-semibold">Plans</h2>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          {/* Plan headers */}
          <thead>
            <tr className="border-b">
              <th className="w-[40%] p-4 text-left font-normal text-muted-foreground" />
              <th className="w-[20%] p-4 text-center">
                <div className="space-y-1">
                  <div className="font-semibold">Free trial</div>
                  <div className="text-2xl font-semibold">$0</div>
                  <div className="text-xs text-muted-foreground">7 days, then $99</div>
                </div>
              </th>
              <th className="w-[20%] border-x bg-background p-4 text-center">
                <div className="space-y-1">
                  <div className="font-semibold">Pro</div>
                  <div className="text-2xl font-semibold">$99</div>
                  <div className="text-xs text-muted-foreground">per user / month</div>
                </div>
              </th>
              <th className="w-[20%] p-4 text-center">
                <div className="space-y-1">
                  <div className="font-semibold">Teams &amp; Enterprise</div>
                  <div className="text-lg font-semibold">Reach out</div>
                  <div className="text-xs text-muted-foreground">for your team</div>
                </div>
              </th>
            </tr>

            {/* CTA row */}
            <tr className="border-b">
              <th className="p-4" />
              <td className="p-4 text-center">
                <span className="text-xs text-muted-foreground">
                  {!isSubscriber ? 'Card required' : ''}
                </span>
              </td>
              <td className="border-x bg-background p-4 text-center">
                {isSubscriber ? (
                  hasStripe ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full max-w-[140px]"
                      onClick={onManage}
                      disabled={actionLoading === 'portal'}
                    >
                      {actionLoading === 'portal' && (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      )}
                      Manage
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" className="w-full max-w-[140px]" disabled>
                      Current plan
                    </Button>
                  )
                ) : (
                  <Button
                    size="sm"
                    className="w-full max-w-[140px]"
                    onClick={onUpgrade}
                    disabled={actionLoading === 'upgrade'}
                  >
                    {actionLoading === 'upgrade' && (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    )}
                    Start free trial
                  </Button>
                )}
              </td>
              <td className="p-4 text-center">
                <Button variant="outline" size="sm" className="w-full max-w-[140px]" asChild>
                  <a href="mailto:liam@dial8.ai">Contact us</a>
                </Button>
              </td>
            </tr>
          </thead>

          {/* Feature sections */}
          <tbody>
            {FEATURE_SECTIONS.map((section) => (
              <Fragment key={section.title}>
                {/* Section header */}
                <tr>
                  <td colSpan={4} className="px-4 pb-1 pt-5">
                    <span className="text-sm font-semibold">{section.title}</span>
                  </td>
                </tr>

                {/* Feature rows */}
                {section.rows.map((row, i) => (
                  <tr
                    key={row.name}
                    className={cn(
                      i < section.rows.length - 1 && 'border-b border-border/50',
                    )}
                  >
                    <td className="px-4 py-2.5 text-muted-foreground">{row.name}</td>
                    <td className="px-4 py-2.5">
                      <FeatureCell value={row.free} />
                    </td>
                    <td className="border-x border-border/50 bg-background px-4 py-2.5">
                      <FeatureCell value={row.pro} />
                    </td>
                    <td className="px-4 py-2.5">
                      <FeatureCell value={row.enterprise} />
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
