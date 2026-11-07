'use client'

/**
 * The HubSpot push HOLD, on the surfaces a person sees it (Sequence step 2,
 * plan A.1). A contact an unattended run created carries
 * `metadata.hubspot_push_hold`; the push function and the sweep leave it alone
 * until a person releases it — from the badge on the contact itself, or from
 * the run's review card (work-item-detail-panel), which is the tier-2 gate.
 * Both call POST /api/account/contacts/[id]/hubspot-hold.
 */
import { useState } from 'react'
import { CirclePause, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { hasHubspotPushHold } from '@/lib/crm/hubspot-push-hold'

export const HUBSPOT_HOLD_TITLE = 'Created by an agent run. Not pushed to HubSpot until you release it.'

/**
 * Release one contact's hold. Resolves true when the row is un-held (already
 * un-held counts). `workspaceId`: the contact's own, when it may not be the
 * window's (a run's panel on its bot's page; the route scopes to the header's
 * workspace).
 */
export async function releaseHubspotHold(contactId: string, workspaceId?: string | null): Promise<boolean> {
  try {
    const res = await fetch(`/api/account/contacts/${contactId}/hubspot-hold`, {
      method: 'POST',
      ...(workspaceId ? { headers: { 'x-workspace-id': workspaceId } } : {}),
    })
    return res.ok
  } catch {
    return false
  }
}

export function HubspotHoldBadge({
  contactId,
  metadata,
  onReleased,
}: {
  contactId: string
  metadata: unknown
  onReleased?: () => void
}) {
  const [busy, setBusy] = useState(false)
  if (!hasHubspotPushHold(metadata)) return null

  const release = async () => {
    setBusy(true)
    const ok = await releaseHubspotHold(contactId)
    setBusy(false)
    if (ok) {
      toast.success('Released — syncing to HubSpot')
      onReleased?.()
    } else {
      toast.error('Could not release the hold')
    }
  }

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400"
      title={HUBSPOT_HOLD_TITLE}
      data-testid="hubspot-hold-badge"
    >
      <CirclePause className="h-3 w-3" />
      HubSpot sync held
      <button
        type="button"
        onClick={() => void release()}
        disabled={busy}
        className="ml-1 inline-flex items-center gap-1 underline underline-offset-2 hover:text-amber-900 disabled:opacity-50 dark:hover:text-amber-200"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        Release
      </button>
    </span>
  )
}
