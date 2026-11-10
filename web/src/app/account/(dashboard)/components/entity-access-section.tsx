'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Hash, Loader2, Search, Users2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { EntityAccessResponse, EntityGrant, GrantableType, GranteeKind } from '@/lib/entity-access/model'

/**
 * "People & channels with access": the per-item grants (migration 492) of a
 * private document or capture, slid into its existing Share dialog
 * (share-dialog.tsx). It lists who the record is shared with beyond its own
 * rule, adds a member, a team or a channel, and removes one. The picker is
 * the contact share dialog's (contact-share-dialog.tsx): the same Person /
 * Team toggle, member search and team select, with Channel beside them.
 *
 * Renders nothing unless the viewer may share the record AND there is
 * something to say: it is private (a grant then opens it), or it already has
 * grants. View only: a grant lets someone read it, never edit it.
 */

interface Option {
  id: string
  name: string
  avatar_url?: string | null
}

type Load = (input: string, init?: RequestInit) => Promise<Response>

export interface EntityAccessSectionProps {
  type: GrantableType
  id: string
  /**
   * List and remove only, no picker: for a dialog that already has its own
   * people picker (a contact's, contact_share), so a channel a contact was
   * shared to can still be seen and taken back. Renders nothing without grants.
   */
  listOnly?: boolean
  /** For tests and the screenshot harness. */
  fetchImpl?: Load
}

const KIND_LABEL: Record<GranteeKind, string> = { member: 'Person', team: 'Team', channel: 'Channel' }
/** How a grant came about, for its row's tooltip. */
const SOURCE_TITLE: Record<EntityGrant['source'], string> = {
  manual: 'Added here',
  mention: 'Mentioned in team chat',
  channel_share: 'Shared to the channel',
}

export function EntityAccessSection({ type, id, listOnly = false, fetchImpl }: EntityAccessSectionProps) {
  const load = useMemo<Load>(() => fetchImpl ?? ((input, init) => fetch(input, init)), [fetchImpl])
  const [access, setAccess] = useState<EntityAccessResponse | null>(null)
  const [members, setMembers] = useState<Option[]>([])
  const [teams, setTeams] = useState<Option[]>([])
  const [channels, setChannels] = useState<Option[]>([])
  const [kind, setKind] = useState<GranteeKind>('member')
  const [selectedId, setSelectedId] = useState('')
  const [search, setSearch] = useState('')
  const [showDropdown, setShowDropdown] = useState(false)
  const [adding, setAdding] = useState(false)

  const refresh = useCallback(async () => {
    const res = await load(`/api/account/entity-access?type=${type}&id=${encodeURIComponent(id)}`).catch(() => null)
    if (!res?.ok) return setAccess(null)
    setAccess((await res.json()) as EntityAccessResponse)
  }, [load, type, id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const canShare = !!access?.can_share
  useEffect(() => {
    if (!canShare || listOnly) return
    let cancelled = false
    void Promise.all([
      load('/api/account/workspace').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      load('/api/account/teams').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      load('/api/account/team-chat/channels').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([ws, ts, cs]) => {
      if (cancelled) return
      const me = (ws as { currentMemberId?: string } | null)?.currentMemberId ?? null
      setMembers(
        (((ws as { members?: Array<{ id: string; display_name?: string; avatar_url?: string | null }> } | null)?.members ?? [])
          .filter((m) => m.id !== me)
          .map((m) => ({ id: m.id, name: m.display_name || 'Someone', avatar_url: m.avatar_url ?? null }))),
      )
      setTeams((((ts as { teams?: Array<{ id: string; name: string }> } | null)?.teams ?? []).map((t) => ({ id: t.id, name: t.name }))))
      setChannels(
        (((cs as { channels?: Array<{ id: string; name: string | null; kind: string; archived_at?: string | null }> } | null)?.channels ?? [])
          .filter((c) => c.kind === 'channel' && !c.archived_at && c.name)
          .map((c) => ({ id: c.id, name: `#${c.name}` }))),
      )
    })
    return () => {
      cancelled = true
    }
  }, [load, canShare, listOnly])

  if (!access || !access.can_share) return null
  if (access.grants.length === 0 && (listOnly || !access.restricted)) return null

  const granted = new Set(access.grants.map((g) => `${g.grantee_kind}:${g.grantee_id}`))
  const options = (kind === 'member' ? members : kind === 'team' ? teams : channels).filter((o) => !granted.has(`${kind}:${o.id}`))
  const filteredMembers = options.filter((m) => !search || m.name.toLowerCase().includes(search.toLowerCase()))

  const pickKind = (k: GranteeKind) => {
    setKind(k)
    setSelectedId('')
    setSearch('')
  }

  const add = async () => {
    if (!selectedId || adding) return
    setAdding(true)
    const res = await load('/api/account/entity-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, id, grantee_kind: kind, grantee_id: selectedId }),
    }).catch(() => null)
    setAdding(false)
    if (!res?.ok) {
      const body = (await res?.json().catch(() => null)) as { error?: string } | null
      toast.error(body?.error || "Couldn't share it")
      return
    }
    setSelectedId('')
    setSearch('')
    await refresh()
  }

  const remove = async (grant: EntityGrant) => {
    // Optimistic: the row goes now, and comes back if the delete fails.
    setAccess((prev) => (prev ? { ...prev, grants: prev.grants.filter((g) => g.id !== grant.id) } : prev))
    const res = await load(`/api/account/entity-access/${encodeURIComponent(grant.id)}`, { method: 'DELETE' }).catch(() => null)
    if (!res?.ok) {
      toast.error("Couldn't remove access")
      await refresh()
    }
  }

  return (
    <>
      <Separator />
      <div className="space-y-3" data-testid="entity-access-section">
        <div className="flex items-center gap-2">
          <Users2 className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">People &amp; channels with access</span>
        </div>
        {!listOnly && (
          <p className="text-[11px] leading-normal text-muted-foreground">
            {access.restricted
              ? `Only you can see this ${type}. Anyone you add here can view it too.`
              : `Everyone in the workspace can see this ${type} now. These keep access if it goes back to Only me.`}
          </p>
        )}

        {!listOnly && (
          <div className="space-y-3.5">
            <div className="flex w-fit items-center gap-0.5 rounded-lg border p-1">
              {(['member', 'team', 'channel'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => pickKind(k)}
                  className={cn(
                    'rounded-md px-4 py-1.5 text-xs font-medium transition-all',
                    kind === k ? 'bg-muted text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              {kind === 'member' ? (
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search members..."
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value)
                      setShowDropdown(true)
                      if (selectedId) setSelectedId('')
                    }}
                    onFocus={() => setShowDropdown(true)}
                    onBlur={() => setTimeout(() => setShowDropdown(false), 200)}
                    className="h-8 pl-8 text-sm"
                  />
                  {showDropdown && search && !selectedId && filteredMembers.length > 0 && (
                    <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-[180px] overflow-y-auto rounded-3xl border bg-popover p-2 shadow-md animate-in fade-in-0 zoom-in-95 duration-100">
                      {filteredMembers.slice(0, 8).map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setSelectedId(m.id)
                            setSearch(m.name)
                            setShowDropdown(false)
                          }}
                          className="flex w-full items-center gap-2.5 rounded-2xl px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                        >
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-medium text-primary">
                            {m.name.charAt(0).toUpperCase()}
                          </span>
                          <span className="truncate">{m.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <Select value={selectedId} onValueChange={setSelectedId}>
                  <SelectTrigger className="h-8 min-w-0 flex-1 text-sm">
                    <SelectValue placeholder={kind === 'team' ? 'Select a team...' : 'Select a channel...'} />
                  </SelectTrigger>
                  <SelectContent>
                    {options.length === 0 ? (
                      <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                        {kind === 'team' ? 'No teams available' : 'No channels available'}
                      </div>
                    ) : (
                      options.map((o) => (
                        <SelectItem key={o.id} value={o.id}>
                          <div className="flex items-center gap-2">
                            {kind === 'team' ? <Users2 className="h-3.5 w-3.5 text-muted-foreground" /> : <Hash className="h-3.5 w-3.5 text-muted-foreground" />}
                            {kind === 'channel' ? o.name.replace(/^#/, '') : o.name}
                          </div>
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              )}
              <Button size="sm" className="h-8 shrink-0 px-3" onClick={() => void add()} disabled={!selectedId || adding}>
                {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Share'}
              </Button>
            </div>
          </div>
        )}

        {access.grants.length > 0 && (
          <div className="divide-y rounded-md border">
            {access.grants.map((g) => (
              <div key={g.id} className="flex items-center gap-2.5 px-2.5 py-2 transition-colors hover:bg-muted/30">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                  {g.grantee_kind === 'member' ? (
                    g.grantee_name.charAt(0).toUpperCase()
                  ) : g.grantee_kind === 'team' ? (
                    <Users2 className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <Hash className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{g.grantee_name}</span>
                <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]" title={SOURCE_TITLE[g.source]}>
                  Can view
                </Badge>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={`Remove ${g.grantee_name}`}
                  onClick={() => void remove(g)}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
