'use client'

import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'

export function SendInvitesForm({ waitlistedCount }: { waitlistedCount: number }) {
  const [batchSize, setBatchSize] = useState(10)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ sent: number; failed: number } | null>(null)
  const [error, setError] = useState('')

  async function handleSend() {
    if (waitlistedCount === 0) return

    setLoading(true)
    setResult(null)
    setError('')

    try {
      const response = await fetch('/api/admin/send-invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchSize }),
      })

      if (!response.ok) {
        const data = await response.json()
        setError(data.error ?? 'Failed to send invites')
        return
      }

      const data = await response.json()
      setResult(data)
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex items-center gap-4">
      <div className="flex items-center gap-2">
        <Label htmlFor="batch-size" className="text-sm text-muted-foreground">Batch size:</Label>
        <Input
          id="batch-size"
          type="number"
          min={1}
          max={waitlistedCount}
          value={batchSize}
          onChange={(e) => setBatchSize(Number(e.target.value))}
          className="w-20"
        />
      </div>

      <Button
        onClick={handleSend}
        disabled={loading || waitlistedCount === 0}
      >
        {loading ? 'Sending...' : 'Send Invites'}
      </Button>

      {result && (
        <span className="text-sm text-green-600 dark:text-green-400">
          Sent {result.sent}, failed {result.failed}
        </span>
      )}

      {error && (
        <span className="text-sm text-destructive">{error}</span>
      )}
    </div>
  )
}
