'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Plus, Loader2 } from 'lucide-react'

export function CreateCampaignButton() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [triggerType, setTriggerType] = useState('manual')
  const [audienceSource, setAudienceSource] = useState('early_access')

  async function handleCreate() {
    if (!title.trim()) {
      setError('Title is required')
      return
    }

    setCreating(true)
    setError('')

    try {
      const res = await fetch('/api/admin/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          trigger_type: triggerType,
          audience_source: audienceSource,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        setError(data.error ?? 'Failed to create campaign')
        return
      }

      const { campaign } = await res.json()
      setOpen(false)
      setTitle('')
      setDescription('')
      setTriggerType('manual')
      setAudienceSource('early_access')
      router.push(`/admin/campaigns/${campaign.id}`)
      router.refresh()
    } catch {
      setError('Network error')
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New Campaign
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create Campaign</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <Label>Title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Onboarding Drip"
            />
          </div>

          <div className="space-y-2">
            <Label>Description (optional)</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Internal note about this campaign"
            />
          </div>

          <div className="space-y-2">
            <Label>Trigger Type</Label>
            <Select value={triggerType} onValueChange={setTriggerType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">Manual</SelectItem>
                <SelectItem value="cron">Automated (Cron)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {triggerType === 'cron'
                ? 'Steps are sent automatically based on day offsets after enrollment.'
                : 'Steps are sent manually or via bulk actions.'}
            </p>
          </div>

          <div className="space-y-2">
            <Label>Audience</Label>
            <Select value={audienceSource} onValueChange={setAudienceSource}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="early_access">Early Access Waitlist</SelectItem>
                <SelectItem value="auth_users">All Registered Users</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {audienceSource === 'early_access'
                ? 'Targets users from the early access waitlist.'
                : 'Targets all registered app users.'}
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Create
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
