'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'

export function PurchaseActions({
  purchaseId,
  currentStatus,
}: {
  purchaseId: string
  currentStatus: string
}) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  if (currentStatus !== 'completed') {
    return null
  }

  async function handleRefund() {
    if (!confirm('Are you sure you want to refund this purchase?')) return

    setLoading(true)
    try {
      const res = await fetch(`/api/admin/purchases/${purchaseId}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'refunded',
          refunded_at: new Date().toISOString(),
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        alert(data.error ?? 'Failed to refund purchase')
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
      onClick={handleRefund}
      disabled={loading}
      className="text-xs"
    >
      {loading ? '...' : 'Refund'}
    </Button>
  )
}
