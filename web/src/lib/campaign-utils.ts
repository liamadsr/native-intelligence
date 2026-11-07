import type { UserTier } from './campaign-types'

type AuthUser = any

export function getUserAvatar(user: AuthUser): string | null {
  const meta = user.user_metadata ?? {}
  const url = meta.avatar_url ?? meta.picture ?? meta.photo_url
  return typeof url === 'string' ? url : null
}

export function getInitials(email: string): string {
  return email
    .split('@')[0]
    .split(/[._]/)
    .map((s: string) => s[0]?.toUpperCase())
    .filter(Boolean)
    .join('')
    .slice(0, 2)
}

export function formatRelativeTime(date: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 30) return `${diffDays}d ago`
  const diffMonths = Math.floor(diffDays / 30)
  return `${diffMonths}mo ago`
}

export function isGrantedPurchase(p: {
  price_paid: number | string
  metadata: Record<string, unknown> | null
}): boolean {
  return (
    Number(p.price_paid) === 0 ||
    !!p.metadata?.promotional ||
    !!p.metadata?.granted_by
  )
}

/**
 * Build a tier map from purchases and subscriptions.
 * Returns a Record<userId, UserTier> — users not in the map are 'free'.
 * Subscriber tier takes priority over purchase-based tiers.
 */
export function buildUserTierMap(
  purchases: Array<{
    user_id: string
    status: string
    price_paid: number | string
    metadata: Record<string, unknown> | null
  }> | null,
  subscriptions?: Array<{
    user_id: string
    status: string
  }> | null,
): Record<string, UserTier> {
  const tiers: Record<string, UserTier> = {}

  // Apply purchase-based tiers first
  for (const p of purchases ?? []) {
    if (p.status === 'completed') {
      const isPaid =
        Number(p.price_paid) > 0 &&
        !p.metadata?.promotional &&
        !p.metadata?.granted_by
      if (isPaid) {
        tiers[p.user_id] = 'pro_paid'
      } else if (!tiers[p.user_id]) {
        tiers[p.user_id] = 'pro_granted'
      }
    }
  }

  // Subscriber tier overrides everything
  for (const s of subscriptions ?? []) {
    if (s.status === 'active' || s.status === 'trialing') {
      tiers[s.user_id] = 'subscriber'
    }
  }

  return tiers
}
