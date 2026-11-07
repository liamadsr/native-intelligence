'use client'

import { createContext, useContext, type MouseEvent } from 'react'
import type { ProposedChange } from '@/lib/proposed-changes/types'
import type { TrustPolicy } from '@/lib/proposed-changes/trust-policy'

export interface ProposalNodeContextValue {
  changes: ProposedChange[]
  /**
   * O(1) id → change lookup for the per-node render path (memoized by the
   * provider from `changes`). Optional — nodes fall back to a linear scan of
   * `changes` when a provider doesn't supply it.
   */
  changesById?: Map<string, ProposedChange>
  /** Resolves to the created entity's id when known — see ProposalCard.onApply. */
  onApply: (changeId: string) => Promise<string | null | void>
  onDismiss: (changeId: string) => Promise<void>
  onEdit: (changeId: string, updates: Record<string, unknown>) => Promise<void>
  /** Un-apply an already-applied change. Optional — omit in read-only views. */
  onUndo?: (changeId: string) => Promise<void>
  /** Open the entity an applied proposal created (e.g. its action). */
  onOpenEntity?: (entityType: string, id: string, title: string, event?: MouseEvent) => void
  members?: { id: string; display_name: string; avatar_url: string | null }[]
  /** AI team members (agents) assignable to the actions these proposals create. */
  aiMembers?: { id: string; name: string; avatar_url: string | null }[]
  contacts?: { id: string; full_name: string; email: string | null }[]
  projects?: { id: string; name: string }[]
  /** Current user's member ID — shows "(Me)" badge next to their name */
  currentMemberId?: string | null
  /** Workspace trust policy — explains why a pending item didn't auto-accept. */
  autoAcceptPolicy?: TrustPolicy | null
  /** When true, the card renders in view-only mode (no apply/dismiss/edit affordances). */
  readOnly?: boolean
  /** Open the dashboard settings overlay — the "Push to…" menu's setup CTAs. */
  onOpenSettings?: (subPath?: string) => void
}

const ProposalNodeContext = createContext<ProposalNodeContextValue | null>(null)

export const ProposalNodeProvider = ProposalNodeContext.Provider

export function useProposalNodeContext() {
  return useContext(ProposalNodeContext)
}
