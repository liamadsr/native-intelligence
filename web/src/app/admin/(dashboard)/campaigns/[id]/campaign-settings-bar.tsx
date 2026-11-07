'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Loader2,
  Pause,
  Play,
  Trash2,
  Circle,
} from 'lucide-react'

export function CampaignSettingsBar({
  campaignId,
  isActive,
  triggerType,
}: {
  campaignId: string
  isActive: boolean
  triggerType: string
}) {
  const router = useRouter()
  const [toggling, setToggling] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function handleToggleActive() {
    setToggling(true)
    try {
      const res = await fetch(`/api/admin/campaigns/${campaignId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !isActive }),
      })
      if (res.ok) {
        router.refresh()
      }
    } catch {
      alert('Failed to update campaign')
    } finally {
      setToggling(false)
    }
  }

  async function handleDelete() {
    if (!confirm('Delete this campaign and all its steps? This cannot be undone.')) return

    setDeleting(true)
    try {
      const res = await fetch(`/api/admin/campaigns/${campaignId}`, {
        method: 'DELETE',
      })
      if (res.ok) {
        router.push('/admin/campaigns')
        router.refresh()
      } else {
        alert('Failed to delete campaign')
      }
    } catch {
      alert('Failed to delete campaign')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium">
        <Circle
          className={`h-2 w-2 ${isActive ? 'fill-emerald-500 text-emerald-500' : 'fill-muted-foreground/40 text-muted-foreground/40'}`}
        />
        {isActive ? 'Active' : 'Paused'}
      </div>

      <Badge variant="secondary" className="py-1.5 text-xs font-medium">
        {triggerType === 'cron' ? 'Automated' : 'Manual'}
      </Badge>

      <div className="mx-0.5 h-4 w-px bg-border" />

      <Button
        variant="outline"
        size="sm"
        className="h-8 px-3 text-xs"
        onClick={handleToggleActive}
        disabled={toggling}
      >
        {toggling ? (
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
        ) : isActive ? (
          <Pause className="mr-1.5 h-3.5 w-3.5" />
        ) : (
          <Play className="mr-1.5 h-3.5 w-3.5" />
        )}
        {isActive ? 'Pause' : 'Activate'}
      </Button>

      <Button
        variant="outline"
        size="sm"
        className="h-8 w-8 px-0 text-muted-foreground hover:text-destructive"
        onClick={handleDelete}
        disabled={deleting}
      >
        {deleting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Trash2 className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  )
}
