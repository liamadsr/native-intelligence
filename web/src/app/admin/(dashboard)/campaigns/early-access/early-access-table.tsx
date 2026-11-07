'use client'

import { Badge } from '@/components/ui/badge'
import { CampaignUserTable } from '@/components/admin/campaign-user-table'
import type { CampaignUser, CampaignColumnDef, CampaignAction } from '@/lib/campaign-types'

const statusOptions = [
  { value: 'waitlisted', label: 'Waitlisted' },
  { value: 'invited', label: 'Invited' },
  { value: 'signed_up', label: 'Signed Up' },
  { value: 'downloaded', label: 'Downloaded' },
  { value: 'setup_complete', label: 'Setup Complete' },
  { value: 'active', label: 'Active' },
]

const extraColumns: CampaignColumnDef[] = [
  {
    key: 'lastEmail',
    header: 'Last Email',
    render: (user) => (
      <span className="text-xs text-muted-foreground">
        {(user.extra.lastEmailStep as string) ?? '—'}
      </span>
    ),
  },
  {
    key: 'invitedAt',
    header: 'Invited At',
    render: (user) => (
      <span className="text-xs text-muted-foreground">
        {user.extra.invitedAt
          ? new Date(user.extra.invitedAt as string).toLocaleDateString()
          : '—'}
      </span>
    ),
  },
  {
    key: 'convertedAt',
    header: 'Signed Up',
    render: (user) => (
      <span className="text-xs text-muted-foreground">
        {user.extra.convertedAt
          ? new Date(user.extra.convertedAt as string).toLocaleDateString()
          : '—'}
      </span>
    ),
  },
  {
    key: 'unsubscribed',
    header: 'Unsub',
    render: (user) =>
      user.extra.unsubscribed ? (
        <Badge variant="destructive" className="text-xs">
          unsub
        </Badge>
      ) : null,
  },
]

const bulkActions: CampaignAction[] = [
  {
    id: 'send-invite',
    label: 'Send Invite',
    description: 'Send the welcome/invite email to the selected waitlisted users.',
    onExecute: async (userIds) => {
      const res = await fetch('/api/admin/campaigns/bulk-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'send-invite', userIds }),
      })
      return res.json()
    },
  },
  {
    id: 'reset-to-waitlisted',
    label: 'Reset to Waitlisted',
    variant: 'outline',
    description: 'Reset the selected users back to "waitlisted" so they can be invited again.',
    onExecute: async (userIds) => {
      const res = await fetch('/api/admin/campaigns/bulk-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset-status', status: 'waitlisted', userIds }),
      })
      return res.json()
    },
  },
]

export function EarlyAccessTable({ users }: { users: CampaignUser[] }) {
  return (
    <CampaignUserTable
      campaignSlug="early-access"
      users={users}
      statusOptions={statusOptions}
      extraColumns={extraColumns}
      bulkActions={bulkActions}
      emptyMessage="No early access users yet."
    />
  )
}
