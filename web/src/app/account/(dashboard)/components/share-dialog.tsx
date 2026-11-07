'use client'

import { PreferenceActionButton } from '@/components/views/preference-action'

import { useCallback, useEffect, useState } from 'react'
import { ThinkingOrb } from 'thinking-orbs'
import { copyTextToClipboard } from '@/lib/clipboard'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Share2,
  Copy,
  Check,
  X,
  Loader2,
  Mail,
  Globe,
  Users,
} from 'lucide-react'

interface Share {
  id: string
  share_type: 'link' | 'email'
  access_level: 'view' | 'comment'
  shared_with_email: string | null
  share_token: string
  share_url: string
  is_active: boolean
  expires_at: string | null
  show_transcript: boolean
  show_ai_summary: boolean
  show_decisions: boolean
  created_at: string
}

interface ShareDialogProps {
  shareableType: 'capture' | 'document'
  shareableId: string
  trigger?: React.ReactNode
}

export function ShareDialog({ shareableType, shareableId, trigger }: ShareDialogProps) {
  const [open, setOpen] = useState(false)
  const [shares, setShares] = useState<Share[]>([])
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  // Link share state
  const [linkShare, setLinkShare] = useState<Share | null>(null)
  const [togglingLink, setTogglingLink] = useState(false)

  // Email share state
  const [emailInput, setEmailInput] = useState('')
  const [sharingEmail, setSharingEmail] = useState(false)

  const fetchShares = useCallback(async () => {
    setLoading(true)
    const res = await fetch(
      `/api/account/shares?shareable_type=${shareableType}&shareable_id=${shareableId}`,
    )
    if (res.ok) {
      const data = await res.json()
      const all = data.shares as Share[]
      setShares(all)
      setLinkShare(all.find((s) => s.share_type === 'link' && s.is_active) || null)
    }
    setLoading(false)
  }, [shareableType, shareableId])

  useEffect(() => {
    if (open) fetchShares()
  }, [open, fetchShares])

  async function toggleLinkShare() {
    setTogglingLink(true)
    if (linkShare) {
      // Revoke
      const res = await fetch(`/api/account/shares/${linkShare.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: false }),
      }).catch(() => null)
      if (res?.ok) setLinkShare(null)
      else toast.error("Couldn't turn off the public link. It is still active.")
    } else {
      // Create
      const res = await fetch('/api/account/shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shareable_type: shareableType,
          shareable_id: shareableId,
          share_type: 'link',
          access_level: 'view',
        }),
      }).catch(() => null)
      if (res?.ok) {
        const data = await res.json()
        setLinkShare(data.share)
      } else {
        toast.error("Couldn't create the link")
      }
    }
    setTogglingLink(false)
    fetchShares()
  }

  async function updateLinkShare(updates: Partial<Share>) {
    if (!linkShare) return
    const res = await fetch(`/api/account/shares/${linkShare.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    if (res.ok) {
      const data = await res.json()
      setLinkShare(data.share)
    }
  }

  async function handleEmailShare() {
    if (!emailInput.trim()) return
    setSharingEmail(true)
    const res = await fetch('/api/account/shares', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shareable_type: shareableType,
        shareable_id: shareableId,
        share_type: 'email',
        shared_with_email: emailInput.trim(),
        access_level: 'comment',
      }),
    })
    if (res.ok) {
      setEmailInput('')
      fetchShares()
    } else {
      toast.error(`Couldn't share with ${emailInput.trim()}`)
    }
    setSharingEmail(false)
  }

  async function revokeShare(shareId: string) {
    const res = await fetch(`/api/account/shares/${shareId}`, { method: 'DELETE' }).catch(() => null)
    if (!res?.ok) toast.error("Couldn't remove access")
    fetchShares()
  }

  async function copyLink() {
    if (!linkShare) return
    if (!(await copyTextToClipboard(linkShare.share_url))) {
      toast.error("Couldn't copy the link")
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const emailShares = shares.filter((s) => s.share_type === 'email' && s.is_active)
  const hasActiveShares = !!linkShare || emailShares.length > 0

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? (
        <DialogTrigger asChild>{trigger}</DialogTrigger>
      ) : (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <DialogTrigger asChild>
                <PreferenceActionButton label="Share"
                  variant="ghost"
                  size="sm"
                  className="relative h-7 w-7 p-0"
                  aria-label="Share"
                >
                  <Share2 className="h-3.5 w-3.5" />
                  {hasActiveShares && (
                    <span className="absolute right-1 top-1 flex h-1.5 w-1.5 rounded-full bg-blue-500" />
                  )}
                </PreferenceActionButton>
              </DialogTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">Share</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">
            Share {shareableType === 'capture' ? 'Capture' : 'Document'}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <ThinkingOrb state="connecting" size={20} theme="auto" />
          </div>
        ) : (
          <div className="space-y-5">
            {/* Public link section */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">Public Link</span>
              </div>

              <div className="flex items-center justify-between">
                <Label htmlFor="link-toggle" className="text-sm text-muted-foreground">
                  Anyone with the link can view
                </Label>
                <Switch
                  id="link-toggle"
                  checked={!!linkShare}
                  onCheckedChange={toggleLinkShare}
                  disabled={togglingLink}
                />
              </div>

              {linkShare && (
                <div className="space-y-3 rounded-md border bg-muted/30 p-3">
                  <div className="flex items-center gap-2">
                    <Input
                      readOnly
                      value={linkShare.share_url}
                      className="h-8 text-xs"
                      onClick={(e) => (e.target as HTMLInputElement).select()}
                    />
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 w-8 shrink-0 p-0"
                            onClick={copyLink}
                          >
                            {copied ? (
                              <Check className="h-3.5 w-3.5 text-green-500" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{copied ? 'Copied!' : 'Copy link'}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="flex-1">
                      <Label className="text-xs text-muted-foreground">Access</Label>
                      <Select
                        value={linkShare.access_level}
                        onValueChange={(v) =>
                          updateLinkShare({ access_level: v as 'view' | 'comment' })
                        }
                      >
                        <SelectTrigger className="h-7 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="view">Can view</SelectItem>
                          <SelectItem value="comment">Can comment</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex-1">
                      <Label className="text-xs text-muted-foreground">Expires</Label>
                      <Select
                        value={linkShare.expires_at ? 'custom' : 'never'}
                        onValueChange={(v) => {
                          if (v === 'custom') return
                          if (v === 'never') {
                            updateLinkShare({ expires_at: null })
                          } else {
                            const d = new Date()
                            if (v === '24h') d.setHours(d.getHours() + 24)
                            else if (v === '7d') d.setDate(d.getDate() + 7)
                            else if (v === '30d') d.setDate(d.getDate() + 30)
                            updateLinkShare({ expires_at: d.toISOString() } as Partial<Share>)
                          }
                        }}
                      >
                        <SelectTrigger className="h-7 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="never">Never</SelectItem>
                          {/* The active expiry, so the trigger names it rather than going blank. */}
                          {linkShare.expires_at && (
                            <SelectItem value="custom">
                              {`Until ${new Date(linkShare.expires_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`}
                            </SelectItem>
                          )}
                          <SelectItem value="24h">24 hours</SelectItem>
                          <SelectItem value="7d">7 days</SelectItem>
                          <SelectItem value="30d">30 days</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {shareableType === 'capture' && (
                    <div className="space-y-2 pt-1">
                      <Label className="text-xs text-muted-foreground">Visible content</Label>
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() =>
                            updateLinkShare({ show_ai_summary: !linkShare.show_ai_summary })
                          }
                          className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                            linkShare.show_ai_summary
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'border-muted text-muted-foreground hover:border-foreground/30'
                          }`}
                        >
                          AI Summary
                        </button>
                        <button
                          onClick={() =>
                            updateLinkShare({ show_transcript: !linkShare.show_transcript })
                          }
                          className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                            linkShare.show_transcript
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'border-muted text-muted-foreground hover:border-foreground/30'
                          }`}
                        >
                          Transcript
                        </button>
                        <button
                          onClick={() =>
                            updateLinkShare({ show_decisions: !linkShare.show_decisions })
                          }
                          className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                            linkShare.show_decisions
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'border-muted text-muted-foreground hover:border-foreground/30'
                          }`}
                        >
                          Decisions
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <Separator />

            {/* Email share section */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">Share with People</span>
              </div>

              <div className="flex gap-2">
                <Input
                  placeholder="Enter email address..."
                  type="email"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleEmailShare()}
                  className="h-8 text-sm"
                />
                <Button
                  size="sm"
                  className="h-8 shrink-0"
                  onClick={handleEmailShare}
                  disabled={sharingEmail || !emailInput.trim()}
                >
                  {sharingEmail ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Share'}
                </Button>
              </div>

              {emailShares.length > 0 && (
                <div className="space-y-1">
                  {emailShares.map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-muted/50"
                    >
                      <div className="flex items-center gap-2 overflow-hidden">
                        <Mail className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate text-sm">{s.shared_with_email}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Badge variant="secondary" className="text-[10px]">
                          {s.access_level === 'comment' ? 'Can comment' : 'Can view'}
                        </Badge>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5"
                          onClick={() => revokeShare(s.id)}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
