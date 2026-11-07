'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Clock } from 'lucide-react'

export function ExtendTrialInline({
  userId,
  currentOverride,
}: {
  userId: string
  currentOverride: string | null
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [sendEmail, setSendEmail] = useState(true)
  const [result, setResult] = useState<string | null>(null)

  const overrideDate = currentOverride ? new Date(currentOverride) : null
  const isActive = overrideDate ? overrideDate > new Date() : false

  async function handleExtend(days: number) {
    setLoading(true)
    setResult(null)

    try {
      const res = await fetch(`/api/admin/users/${userId}/extend-trial`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days, sendEmail }),
      })

      if (!res.ok) {
        const data = await res.json()
        setResult(`Error: ${data.error}`)
        return
      }

      const data = await res.json()
      const endDate = new Date(data.trial_end_override).toLocaleDateString()
      setResult(`Extended to ${endDate}${data.email_sent ? ' + email sent' : ''}`)
      setTimeout(() => {
        setOpen(false)
        setResult(null)
        router.refresh()
      }, 1500)
    } catch {
      setResult('Error: Network failure')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          className="inline-flex items-center gap-1 text-xs"
          type="button"
        >
          {overrideDate ? (
            <Badge
              variant={isActive ? 'default' : 'secondary'}
              className="gap-0.5 text-[10px] px-1.5 py-0 cursor-pointer"
            >
              <Clock className="h-2.5 w-2.5" />
              {isActive
                ? overrideDate.toLocaleDateString()
                : 'Expired'}
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 cursor-pointer text-muted-foreground"
            >
              14d trial
            </Badge>
          )}
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-xs">
        <DialogHeader>
          <DialogTitle className="text-sm">Extend Trial</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {overrideDate && (
            <p className="text-xs text-muted-foreground">
              {isActive
                ? `Currently extended to ${overrideDate.toLocaleDateString()}`
                : `Extension expired ${overrideDate.toLocaleDateString()}`}
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => handleExtend(7)}
              disabled={loading}
            >
              +1 Week
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => handleExtend(14)}
              disabled={loading}
            >
              +2 Weeks
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => handleExtend(30)}
              disabled={loading}
            >
              +1 Month
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id={`email-${userId}`}
              checked={sendEmail}
              onChange={(e) => setSendEmail(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-input"
            />
            <Label htmlFor={`email-${userId}`} className="text-xs text-muted-foreground cursor-pointer">
              Send win-back email
            </Label>
          </div>
          {result && (
            <p className={`text-xs ${result.startsWith('Error') ? 'text-destructive' : 'text-green-600'}`}>
              {result}
            </p>
          )}
          {loading && (
            <p className="text-xs text-muted-foreground">Extending...</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
