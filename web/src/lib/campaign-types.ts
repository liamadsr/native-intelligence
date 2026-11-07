import type { ReactNode } from 'react'

export type UserTier = 'free' | 'pro_paid' | 'pro_granted' | 'subscriber'

export interface CampaignUser {
  id: string
  email: string
  avatarUrl: string | null
  tier: UserTier
  createdAt: string
  lastSignInAt: string | null
  campaignStatus: string
  campaignStatusVariant: 'default' | 'secondary' | 'destructive' | 'outline'
  /** Campaign-specific data accessed by custom column renderers */
  extra: Record<string, unknown>
}

export interface CampaignColumnDef {
  key: string
  header: string
  render: (user: CampaignUser) => ReactNode
}

export interface CampaignAction {
  id: string
  label: string
  description?: string
  variant?: 'default' | 'destructive' | 'outline'
  onExecute: (userIds: string[]) => Promise<{ success: number; failed: number }>
}

export interface FilterConfig {
  tier: UserTier | 'all'
  signedUpDays: number | null
  lastSignInDays: number | null
  hasPurchase: boolean | null
  campaignStatus: string | 'all'
}

export const DEFAULT_FILTERS: FilterConfig = {
  tier: 'all',
  signedUpDays: null,
  lastSignInDays: null,
  hasPurchase: null,
  campaignStatus: 'all',
}

export interface SavedFilterView {
  id: string
  name: string
  filters: FilterConfig
  isDefault: boolean
  createdAt: string
}
