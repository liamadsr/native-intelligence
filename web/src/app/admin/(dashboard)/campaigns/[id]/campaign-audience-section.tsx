'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CampaignUserTable } from '@/components/admin/campaign-user-table'
import { Users } from 'lucide-react'
import type { CampaignUser, CampaignAction } from '@/lib/campaign-types'

interface CampaignStep {
  id: string
  step_name: string
  step_order: number
  delivery_channel: string
}

const statusOptions = [
  { value: 'sent', label: 'Sent' },
  { value: 'not_sent', label: 'Not Sent' },
]

export function CampaignAudienceSection({
  campaignId,
  users,
  steps,
}: {
  campaignId: string
  users: CampaignUser[]
  steps: CampaignStep[]
}) {
  const router = useRouter()
  const [pickedStepId, setSelectedStepId] = useState<string>(
    steps.length > 0 ? steps[0].id : '',
  )
  // Steps can be added or deleted after mount: a pick that is no longer a
  // step (or none yet) falls back to the first step.
  const selectedStepId = steps.some((s) => s.id === pickedStepId)
    ? pickedStepId
    : (steps[0]?.id ?? '')
  const [sendingAll, setSendingAll] = useState(false)

  async function handleSendToAll() {
    const stepLabel = steps.find((s) => s.id === selectedStepId)?.step_name ?? 'selected step'
    if (
      !confirm(
        `Send "${stepLabel}" to ALL ${users.length} active users? This includes users who may have already received this campaign.`,
      )
    )
      return

    setSendingAll(true)
    try {
      const res = await fetch(
        `/api/admin/campaigns/${campaignId}/send`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            step_id: selectedStepId || undefined,
          }),
        },
      )

      const result = await res.json()
      if (!res.ok) {
        alert(result.error ?? 'Failed to send')
        return
      }
      alert(`Sent to ${result.success} users (${result.failed} failed)`)
      router.refresh()
    } catch {
      alert('Something went wrong')
    } finally {
      setSendingAll(false)
    }
  }

  const bulkActions: CampaignAction[] = steps.length > 0
    ? [
        {
          id: 'send-step',
          label: `Send: ${steps.find((s) => s.id === selectedStepId)?.step_name ?? 'Step'}`,
          description: 'Send the selected step to the selected users.',
          onExecute: async (userIds) => {
            const res = await fetch(
              `/api/admin/campaigns/${campaignId}/send`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  user_ids: userIds,
                  step_id: selectedStepId || undefined,
                }),
              },
            )
            return res.json()
          },
        },
      ]
    : []

  return (
    <div className="space-y-4">
      {/* Step selector + Send All controls */}
      <div className="flex items-center gap-3">
        {steps.length > 0 && (
          <>
            <span className="text-sm text-muted-foreground">Step to send:</span>
            <Select value={selectedStepId} onValueChange={setSelectedStepId}>
              <SelectTrigger className="h-8 w-[200px] text-xs">
                <SelectValue placeholder="Select step" />
              </SelectTrigger>
              <SelectContent>
                {steps.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.step_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="default"
            size="sm"
            onClick={handleSendToAll}
            disabled={sendingAll || steps.length === 0}
          >
            <Users className="mr-1.5 h-3.5 w-3.5" />
            {sendingAll ? 'Sending...' : 'Send to All Users'}
          </Button>
        </div>
      </div>

      {steps.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Add steps above before sending to users.
        </p>
      )}

      {/* User table with filters and bulk actions */}
      <CampaignUserTable
        campaignSlug={`campaign-${campaignId}`}
        users={users}
        statusOptions={statusOptions}
        bulkActions={bulkActions}
        emptyMessage="No active users found."
      />
    </div>
  )
}
