'use client'

import { useCallback, useEffect, useState } from 'react'
import { ThinkingOrb } from 'thinking-orbs'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Check, Eye, Globe, Loader2, Lock, Pencil, Search, Shield, Share2, UserPlus, Users2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { EntityAccessSection } from './entity-access-section'

interface ContactShareDialogProps {
  contactId: string
  contactName: string
  visibility: 'private' | 'team' | 'workspace'
  onVisibilityChange?: (visibility: 'private' | 'team' | 'workspace') => void
  trigger?: React.ReactNode
}

interface ShareEntry {
  id: string
  access_level: 'view' | 'edit'
  shared_with_member: { id: string; display_name: string; avatar_url: string | null } | null
  shared_with_team: { id: string; name: string; icon: string | null; color: string | null } | null
  shared_by: { id: string; display_name: string } | null
  created_at: string
}

interface MemberOption {
  id: string
  display_name: string
  avatar_url: string | null
}

interface TeamOption {
  id: string
  name: string
  icon: string | null
  color: string | null
}

const VISIBILITY_CONFIG = {
  private: {
    icon: Lock,
    label: 'Private',
    description: 'Only you and people you share with can see this contact.',
  },
  team: {
    icon: Users2,
    label: 'My Teams',
    description: 'Members of your teams can see this contact.',
  },
  workspace: {
    icon: Globe,
    label: 'Workspace',
    description: 'Everyone in the workspace can see this contact.',
  },
} as const

export function ContactShareDialog({
  contactId,
  contactName,
  visibility,
  onVisibilityChange,
  trigger,
}: ContactShareDialogProps) {
  const [open, setOpen] = useState(false)
  const [shares, setShares] = useState<ShareEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [members, setMembers] = useState<MemberOption[]>([])
  const [teams, setTeams] = useState<TeamOption[]>([])
  const [shareTarget, setShareTarget] = useState<'member' | 'team'>('member')
  const [selectedId, setSelectedId] = useState('')
  const [selectedName, setSelectedName] = useState('')
  const [accessLevel, setAccessLevel] = useState<'view' | 'edit'>('view')
  const [sharing, setSharing] = useState(false)
  const [memberSearch, setMemberSearch] = useState('')
  const [showMemberDropdown, setShowMemberDropdown] = useState(false)
  const [updatingVisibility, setUpdatingVisibility] = useState(false)
  const [justShared, setJustShared] = useState(false)

  const fetchShares = useCallback(async () => {
    setLoading(true)
    const res = await fetch(`/api/account/contacts/${contactId}/shares`)
    if (res.ok) {
      const data = await res.json()
      setShares(data.shares || [])
    }
    setLoading(false)
  }, [contactId])

  const fetchOptions = useCallback(async () => {
    const [workspaceRes, teamsRes] = await Promise.all([
      fetch('/api/account/workspace'),
      fetch('/api/account/teams'),
    ])
    if (workspaceRes.ok) {
      const data = await workspaceRes.json()
      setMembers(data.members || [])
    }
    if (teamsRes.ok) {
      const data = await teamsRes.json()
      setTeams(data.teams || [])
    }
  }, [])

  useEffect(() => {
    if (open) {
      fetchShares()
      fetchOptions()
    } else {
      // Reset state when closing
      setSelectedId('')
      setSelectedName('')
      setMemberSearch('')
      setShowMemberDropdown(false)
      setJustShared(false)
    }
  }, [open, fetchShares, fetchOptions])

  const handleShare = async () => {
    if (!selectedId) return
    setSharing(true)
    const res = await fetch(`/api/account/contacts/${contactId}/shares`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_type: shareTarget,
        target_id: selectedId,
        access_level: accessLevel,
      }),
    })
    if (res.ok) {
      setSelectedId('')
      setSelectedName('')
      setMemberSearch('')
      setShowMemberDropdown(false)
      setJustShared(true)
      setTimeout(() => setJustShared(false), 2000)
      await fetchShares()
    }
    setSharing(false)
  }

  const handleRemoveShare = async (shareId: string) => {
    try {
      const res = await fetch(`/api/account/contacts/${contactId}/shares?share_id=${shareId}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setShares((prev) => prev.filter((s) => s.id !== shareId))
    } catch {
      // Keep the row: the share is still active.
      toast.error("Couldn't remove access")
    }
  }

  const handleVisibilityChange = async (newVisibility: 'private' | 'team' | 'workspace') => {
    if (newVisibility === visibility) return
    setUpdatingVisibility(true)
    const res = await fetch(`/api/account/contacts/${contactId}/visibility`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: newVisibility }),
    })
    if (res.ok) {
      onVisibilityChange?.(newVisibility)
    }
    setUpdatingVisibility(false)
  }

  const handleSelectMember = (member: MemberOption) => {
    setSelectedId(member.id)
    setSelectedName(member.display_name)
    setMemberSearch(member.display_name)
    setShowMemberDropdown(false)
  }

  const handleMemberSearchChange = (value: string) => {
    setMemberSearch(value)
    setShowMemberDropdown(true)
    // Clear selection if user edits the text
    if (selectedName && value !== selectedName) {
      setSelectedId('')
      setSelectedName('')
    }
  }

  // Filter members already shared with
  const sharedMemberIds = new Set(shares.filter((s) => s.shared_with_member).map((s) => s.shared_with_member!.id))
  const sharedTeamIds = new Set(shares.filter((s) => s.shared_with_team).map((s) => s.shared_with_team!.id))
  const filteredMembers = members
    .filter((m) => !sharedMemberIds.has(m.id))
    .filter((m) => !memberSearch || m.display_name.toLowerCase().includes(memberSearch.toLowerCase()))
  const filteredTeams = teams.filter((t) => !sharedTeamIds.has(t.id))

  const hasActiveShares = shares.length > 0

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs">
            <Share2 className="h-3 w-3" />
            Share
            {hasActiveShares && (
              <span className="flex h-1.5 w-1.5 rounded-full bg-blue-500" />
            )}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="text-base">Share Contact</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <ThinkingOrb state="connecting" size={20} theme="auto" />
          </div>
        ) : (
          <div className="space-y-5">
            {/* ── Visibility ── */}
            <div className="space-y-2.5">
              <div className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">Visibility</span>
              </div>

              <div className="flex items-center gap-0.5 rounded-lg border p-1">
                {(['private', 'team', 'workspace'] as const).map((v) => {
                  const config = VISIBILITY_CONFIG[v]
                  const Icon = config.icon
                  const isActive = visibility === v
                  return (
                    <button
                      key={v}
                      onClick={() => handleVisibilityChange(v)}
                      disabled={updatingVisibility}
                      className={cn(
                        'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium transition-all',
                        isActive
                          ? 'bg-muted text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground',
                        updatingVisibility && 'opacity-50 cursor-not-allowed',
                      )}
                    >
                      <Icon className="h-3 w-3 shrink-0" />
                      {config.label}
                    </button>
                  )
                })}
              </div>

              <p className="mt-2.5 text-center text-[11px] leading-normal text-muted-foreground">
                {VISIBILITY_CONFIG[visibility].description}
              </p>
            </div>

            <Separator />

            {/* ── Share with people / teams ── */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <UserPlus className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">Share with People</span>
              </div>

              {/* Target type toggle + input row */}
              <div className="space-y-3.5">
                <div className="flex items-center gap-0.5 rounded-lg border p-1 w-fit">
                  <button
                    onClick={() => { setShareTarget('member'); setSelectedId(''); setSelectedName(''); setMemberSearch('') }}
                    className={cn(
                      'rounded-md px-4 py-1.5 text-xs font-medium transition-all',
                      shareTarget === 'member'
                        ? 'bg-muted text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    Person
                  </button>
                  <button
                    onClick={() => { setShareTarget('team'); setSelectedId(''); setSelectedName(''); setMemberSearch('') }}
                    className={cn(
                      'rounded-md px-4 py-1.5 text-xs font-medium transition-all',
                      shareTarget === 'team'
                        ? 'bg-muted text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    Team
                  </button>
                </div>

                <div className="flex items-center gap-2">
                {shareTarget === 'member' ? (
                  <div className="relative flex-1 min-w-0">
                    <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                    <Input
                      placeholder="Search members..."
                      value={memberSearch}
                      onChange={(e) => handleMemberSearchChange(e.target.value)}
                      onFocus={() => setShowMemberDropdown(true)}
                      onBlur={() => setTimeout(() => setShowMemberDropdown(false), 200)}
                      className="h-8 pl-8 text-sm"
                    />

                    {/* Member dropdown */}
                    {showMemberDropdown && memberSearch && !selectedId && filteredMembers.length > 0 && (
                      <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-[180px] overflow-y-auto rounded-3xl border bg-popover p-2 shadow-md animate-in fade-in-0 zoom-in-95 duration-100">
                        {filteredMembers.slice(0, 8).map((m) => (
                          <button
                            key={m.id}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => handleSelectMember(m)}
                            className="flex w-full items-center gap-2.5 rounded-2xl px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                          >
                            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-medium text-primary">
                              {m.avatar_url ? (
                                <img src={m.avatar_url} alt="" className="h-full w-full rounded-full object-cover" />
                              ) : (
                                m.display_name.charAt(0).toUpperCase()
                              )}
                            </div>
                            <span className="truncate">{m.display_name}</span>
                          </button>
                        ))}
                      </div>
                    )}

                    {showMemberDropdown && memberSearch && !selectedId && filteredMembers.length === 0 && (
                      <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-3xl border bg-popover px-3 py-2.5 shadow-md animate-in fade-in-0 zoom-in-95 duration-100">
                        <p className="text-center text-xs text-muted-foreground">No members found</p>
                      </div>
                    )}
                  </div>
                ) : (
                  <Select value={selectedId} onValueChange={(v) => { setSelectedId(v); setSelectedName(filteredTeams.find(t => t.id === v)?.name || '') }}>
                    <SelectTrigger className="h-8 flex-1 min-w-0 text-sm">
                      <SelectValue placeholder="Select a team..." />
                    </SelectTrigger>
                    <SelectContent>
                      {filteredTeams.length === 0 ? (
                        <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                          No teams available
                        </div>
                      ) : (
                        filteredTeams.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            <div className="flex items-center gap-2">
                              <Users2 className="h-3.5 w-3.5 text-muted-foreground" />
                              {t.name}
                            </div>
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                )}

                <Select value={accessLevel} onValueChange={(v) => setAccessLevel(v as 'view' | 'edit')}>
                  <SelectTrigger className="h-8 w-[96px] shrink-0 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="view">
                      <span className="flex items-center gap-1.5">
                        <Eye className="h-3 w-3 text-muted-foreground" />
                        View
                      </span>
                    </SelectItem>
                    <SelectItem value="edit">
                      <span className="flex items-center gap-1.5">
                        <Pencil className="h-3 w-3 text-muted-foreground" />
                        Edit
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>

                <Button
                  size="sm"
                  className="h-8 shrink-0 px-3"
                  onClick={handleShare}
                  disabled={!selectedId || sharing}
                >
                  {sharing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : justShared ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    'Share'
                  )}
                </Button>
                </div>
              </div>

              {/* Current shares */}
              {shares.length > 0 && (
                <div className="pt-2">
                  <p className="mb-1.5 px-0.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
                    Shared with {shares.length} {shares.length === 1 ? 'person' : 'people'}
                  </p>
                  <div className="rounded-md border divide-y">
                    {shares.map((share) => (
                      <div
                        key={share.id}
                        className="flex items-center gap-2.5 px-2.5 py-2 transition-colors hover:bg-muted/30"
                      >
                        {share.shared_with_member ? (
                          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
                            {share.shared_with_member.avatar_url ? (
                              <img src={share.shared_with_member.avatar_url} alt="" className="h-full w-full rounded-full object-cover" />
                            ) : (
                              share.shared_with_member.display_name.charAt(0).toUpperCase()
                            )}
                          </div>
                        ) : share.shared_with_team ? (
                          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
                            <Users2 className="h-3.5 w-3.5 text-muted-foreground" />
                          </div>
                        ) : null}

                        <span className="min-w-0 flex-1 truncate text-sm">
                          {share.shared_with_member?.display_name || share.shared_with_team?.name}
                        </span>

                        <Badge variant="secondary" className="shrink-0 text-[10px] px-1.5 py-0">
                          {share.access_level === 'edit' ? 'Can edit' : 'Can view'}
                        </Badge>

                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => handleRemoveShare(share.id)}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* The channels it was shared to from team chat (migration 492), to see and take back. */}
            <EntityAccessSection type="contact" id={contactId} listOnly />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
