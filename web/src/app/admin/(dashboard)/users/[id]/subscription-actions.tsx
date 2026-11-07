'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Crown, XCircle } from 'lucide-react'

export function CancelSubscriptionButton({
  subscriptionId,
}: {
  subscriptionId: string
}) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function handleCancel() {
    if (!confirm('Cancel this subscription? The user will keep access until the end of their billing period.')) return

    setLoading(true)
    try {
      const res = await fetch(`/api/admin/subscriptions/${subscriptionId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })

      if (!res.ok) {
        const data = await res.json()
        alert(data.error ?? 'Failed to cancel subscription')
        return
      }

      router.refresh()
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleCancel}
      disabled={loading}
      className="text-xs"
    >
      <XCircle className="mr-1.5 h-3.5 w-3.5" />
      {loading ? '...' : 'Cancel Subscription'}
    </Button>
  )
}

export function GrantSubscription({
  userId,
}: {
  userId: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleGrant() {
    setLoading(true)
    setError(null)

    try {
      const res = await fetch(`/api/admin/users/${userId}/grant-subscription`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: reason.trim() || undefined,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Failed to grant subscription')
      }

      setOpen(false)
      setReason('')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Crown className="mr-1.5 h-3.5 w-3.5" />
          Grant Subscription
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Grant Subscription</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Create a complimentary Pro subscription for this user. They will get full subscriber access
          with managed AI keys and no billing.
        </p>
        <div className="mt-4 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="grant-sub-reason">Reason (optional)</Label>
            <Textarea
              id="grant-sub-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g., Beta tester, promotional offer..."
              rows={2}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button onClick={handleGrant} disabled={loading} className="w-full">
            {loading ? 'Granting...' : 'Grant Pro Subscription'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
