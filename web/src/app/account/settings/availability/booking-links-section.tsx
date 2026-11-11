'use client'

/**
 * Settings → Availability → Booking links (availability phase 4b): standing
 * pages anyone books a time with you from, /book/<your handle>/<slug>.
 *
 *   Your address   the handle every link of yours starts with
 *                  (/api/account/booking-profile), editable.
 *   Links          the workspace's links (/api/account/booking-links): each
 *                  with its length and hosts, on or off, its link to copy and
 *                  open; New link and Edit in ./booking-link-dialog.tsx.
 *                  Delete is one tap with Undo in the toast: the link goes
 *                  once the toast does.
 *
 * Read once when the page opens; nothing polls. Who may change a link (its
 * owner, or an owner or admin) is the server's: a link the person can't
 * change shows without its controls.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Copy, ExternalLink, MoreHorizontal, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { copyTextToClipboard } from '@/lib/clipboard'
import { PROFILE_HANDLE_RE } from '@/lib/booking-links/types'
import { cn } from '@/lib/utils'
import { BookingLinkDialog, type LinkMember } from './booking-link-dialog'
import { createBody, draftOf, linkSummary, newDraft, patchBody, type LinkDraft, type SettingsLink } from './booking-link-form'

interface ListBody {
  links: SettingsLink[]
  handles: { me: string | null; workspace: string | null }
  can_manage: boolean
  user_id: string
}

async function call<T>(url: string, init: RequestInit = {}): Promise<{ ok: boolean; data: T & { error?: string } }> {
  try {
    const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
    return { ok: res.ok, data: (await res.json().catch(() => ({}))) as T & { error?: string } }
  } catch {
    return { ok: false, data: { error: 'Network error' } as T & { error?: string } }
  }
}

/** "nativeintelligence.dev" from the page's origin. Pure. */
export function hostOf(origin: string): string {
  return origin.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

/** The handle as it's typed: lower case, spaces as dashes, nothing else. Pure. */
export function typedHandle(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 48)
}

type DialogState = { kind: 'new' } | { kind: 'edit'; link: SettingsLink } | null

export function BookingLinksSection() {
  const [list, setList] = useState<ListBody | null>(null)
  const [members, setMembers] = useState<LinkMember[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [origin, setOrigin] = useState('')
  const [handle, setHandle] = useState('')
  const [savingHandle, setSavingHandle] = useState(false)
  const [dialog, setDialog] = useState<DialogState>(null)
  const [saving, setSaving] = useState(false)
  // Links deleted in this session whose toast is still up: hidden, gone for good when it closes.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const pending = useRef(new Map<string, () => void>())

  useEffect(() => {
    setOrigin(window.location.origin)
    void (async () => {
      const [links, people] = await Promise.all([call<ListBody>('/api/account/booking-links'), call<{ members?: Array<{ user_id: string; display_name: string | null }> }>('/api/account/workspace/members')])
      if (!links.ok || !Array.isArray(links.data.links)) {
        setLoadError(links.data.error ?? 'Could not load your booking links')
        return
      }
      setList(links.data)
      setHandle(links.data.handles.me ?? '')
      setMembers((people.ok ? (people.data.members ?? []) : []).map((m) => ({ userId: m.user_id, name: m.display_name?.trim() || 'A teammate' })))
    })()
  }, [])

  // A delete still in its toast when the page goes: it goes through.
  useEffect(() => {
    const waiting = pending.current
    return () => {
      for (const commit of waiting.values()) commit()
    }
  }, [])

  const nameOf = useCallback((userId: string) => members.find((m) => m.userId === userId)?.name ?? (userId === list?.user_id ? 'You' : 'A teammate'), [members, list?.user_id])
  const shown = useMemo(() => (list?.links ?? []).filter((l) => !hidden.has(l.id)), [list, hidden])
  // The links' own origin (the server's app address) when there is one; else this page's.
  const site = hostOf(list?.links.find((l) => l.url)?.url?.match(/^https?:\/\/[^/]+/)?.[0] ?? origin)
  const handleDirty = !!list && handle !== (list.handles.me ?? '')
  const handleOk = PROFILE_HANDLE_RE.test(handle)

  const replace = useCallback((link: SettingsLink) => setList((l) => (l ? { ...l, links: l.links.map((x) => (x.id === link.id ? link : x)) } : l)), [])

  const saveHandle = useCallback(async () => {
    if (!handleOk) return
    setSavingHandle(true)
    const res = await call<{ handles: ListBody['handles'] }>('/api/account/booking-profile', { method: 'PUT', body: JSON.stringify({ handle }) })
    setSavingHandle(false)
    if (!res.ok) {
      toast.error(res.data.error ?? 'Could not save your address')
      return
    }
    const fresh = await call<ListBody>('/api/account/booking-links')
    setList((l) => (fresh.ok ? fresh.data : l ? { ...l, handles: res.data.handles } : l))
    setHandle(res.data.handles.me ?? handle)
    toast.success('Address saved')
  }, [handle, handleOk])

  const setActive = useCallback(
    async (link: SettingsLink, active: boolean) => {
      replace({ ...link, active })
      const res = await call<{ link: SettingsLink }>(`/api/account/booking-links/${link.id}`, { method: 'PATCH', body: JSON.stringify({ active }) })
      if (!res.ok) {
        replace(link)
        toast.error(res.data.error ?? 'Could not save')
      } else replace(res.data.link)
    },
    [replace],
  )

  const copy = useCallback(async (url: string | null) => {
    if (url && (await copyTextToClipboard(url))) toast.success('Link copied')
    else toast.error("Couldn't copy the link")
  }, [])

  const remove = useCallback((link: SettingsLink) => {
    setHidden((h) => new Set(h).add(link.id))
    let settled = false
    const commit = () => {
      if (settled) return
      settled = true
      pending.current.delete(link.id)
      void call(`/api/account/booking-links/${link.id}`, { method: 'DELETE' }).then((res) => {
        if (res.ok) setList((l) => (l ? { ...l, links: l.links.filter((x) => x.id !== link.id) } : l))
        else {
          setHidden((h) => {
            const next = new Set(h)
            next.delete(link.id)
            return next
          })
          toast.error(res.data.error ?? 'Could not delete it')
        }
      })
    }
    pending.current.set(link.id, commit)
    toast.success(`Deleted “${link.title}”`, {
      action: {
        label: 'Undo',
        onClick: () => {
          settled = true
          pending.current.delete(link.id)
          setHidden((h) => {
            const next = new Set(h)
            next.delete(link.id)
            return next
          })
        },
      },
      onAutoClose: commit,
      onDismiss: commit,
    })
  }, [])

  const save = useCallback(
    async (draft: LinkDraft) => {
      if (!dialog) return
      setSaving(true)
      if (dialog.kind === 'new') {
        const res = await call<{ link: SettingsLink }>('/api/account/booking-links', { method: 'POST', body: JSON.stringify(createBody(draft)) })
        setSaving(false)
        if (!res.ok) return void toast.error(res.data.error ?? 'Could not make the link')
        setList((l) => (l ? { ...l, links: [res.data.link, ...l.links], handles: { ...l.handles, me: l.handles.me ?? res.data.link.profile } } : l))
        if (!handle && res.data.link.profile && !draft.team) setHandle(res.data.link.profile)
        setDialog(null)
        toast.success('Booking link made')
        return
      }
      const body = patchBody(dialog.link, draft)
      if (!Object.keys(body).length) {
        setSaving(false)
        setDialog(null)
        return
      }
      const res = await call<{ link: SettingsLink }>(`/api/account/booking-links/${dialog.link.id}`, { method: 'PATCH', body: JSON.stringify(body) })
      setSaving(false)
      if (!res.ok) return void toast.error(res.data.error ?? 'Could not save the link')
      replace(res.data.link)
      setDialog(null)
    },
    [dialog, handle, replace],
  )

  const base = (h: string | null, fallback: string) => `${site}/book/${h || fallback}/`

  return (
    <section className="mt-8" aria-labelledby="availability-links" data-booking-links="">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 id="availability-links" className="text-sm font-medium">
            Booking links
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Pages anyone can book a time with you from, inside your working hours and around everything busy.</p>
        </div>
        {list && (
          <Button size="sm" variant="outline" className="h-8 shrink-0 gap-1" onClick={() => setDialog({ kind: 'new' })}>
            <Plus className="size-3.5" />
            New link
          </Button>
        )}
      </div>

      {loadError && <p className="mt-3 text-sm text-destructive">{loadError}</p>}
      {!list && !loadError && <Skeleton className="mt-3 h-24 w-full" />}

      {list && (
        <>
          <div className="mt-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
            <label htmlFor="booking-handle" className="text-sm font-medium">
              Your address
            </label>
            <div className="mt-1.5 flex items-center gap-2">
              <div className="flex h-8 min-w-0 flex-1 items-center rounded-md border border-input bg-background text-sm focus-within:border-foreground/30">
                <span className="shrink-0 pl-2.5 text-muted-foreground">{site}/book/</span>
                <input id="booking-handle" value={handle} placeholder="your-name" onChange={(e) => setHandle(typedHandle(e.target.value))} className="h-full min-w-0 flex-1 bg-transparent pr-2.5 outline-none placeholder:text-muted-foreground" data-booking-handle="" />
              </div>
              {handleDirty && (
                <Button size="sm" className="h-8" disabled={savingHandle || !handleOk} onClick={() => void saveHandle()}>
                  Save
                </Button>
              )}
            </div>
            {handleDirty && !handleOk && handle && <p className="mt-1.5 text-xs text-destructive">3 to 48 lower-case letters, digits or dashes, not starting or ending with a dash.</p>}
            {list.handles.me && <p className="mt-1.5 text-xs text-muted-foreground">Changing it changes every link of yours; the old addresses stop working.</p>}
          </div>

          {shown.length === 0 ? (
            <div className="mt-3 rounded-lg border border-dashed px-4 py-6 text-center" data-booking-links-empty="">
              <p className="text-sm">No booking links yet</p>
              <p className="mt-0.5 text-xs text-muted-foreground">Make one and share it: people pick a time that works for you both.</p>
              <Button size="sm" className="mt-3 h-8 gap-1" onClick={() => setDialog({ kind: 'new' })}>
                <Plus className="size-3.5" />
                New link
              </Button>
            </div>
          ) : (
            <ul className="mt-3 divide-y rounded-md border">
              {shown.map((link) => (
                <li key={link.id} data-testid="booking-link" data-active={link.active ? '' : undefined} className="flex items-center gap-3 px-3 py-2">
                  <div className={cn('min-w-0 flex-1', !link.active && 'opacity-60')}>
                    <p className="flex items-center gap-2 text-sm">
                      <span className="truncate font-medium">{link.title}</span>
                      {link.ask_first && <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">Asks first</span>}
                      {link.purpose === 'job' && <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">Business page</span>}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {link.purpose === 'job' ? lengthOnly(link) : linkSummary(link, nameOf)}
                      {link.url ? ` · ${link.url.replace(/^https?:\/\//, '')}` : ''}
                    </p>
                  </div>
                  <Button size="icon" variant="ghost" className="size-7 shrink-0 text-muted-foreground hover:text-foreground" aria-label={`Copy the link to ${link.title}`} disabled={!link.url} onClick={() => void copy(link.url)}>
                    <Copy className="size-3.5" />
                  </Button>
                  {link.url && (
                    <Button asChild size="icon" variant="ghost" className="size-7 shrink-0 text-muted-foreground hover:text-foreground">
                      <a href={link.url} target="_blank" rel="noreferrer" aria-label={`Open ${link.title}`}>
                        <ExternalLink className="size-3.5" />
                      </a>
                    </Button>
                  )}
                  <Switch aria-label={`${link.title} is on`} checked={link.active} disabled={!link.can_edit} onCheckedChange={(next) => void setActive(link, next)} />
                  {link.can_edit && link.purpose === 'meeting' ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon" variant="ghost" className="size-7 shrink-0 text-muted-foreground hover:text-foreground" aria-label={`More for ${link.title}`}>
                          <MoreHorizontal className="size-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-36">
                        <DropdownMenuItem onSelect={() => setDialog({ kind: 'edit', link })}>Edit</DropdownMenuItem>
                        <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => remove(link)}>
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : (
                    <span aria-hidden className="size-7 shrink-0" />
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {list && dialog && (
        <BookingLinkDialog
          key={dialog.kind === 'edit' ? dialog.link.id : 'new'}
          open
          onOpenChange={(open) => !open && setDialog(null)}
          initial={dialog.kind === 'edit' ? draftOf(dialog.link) : newDraft(list.user_id)}
          editing={dialog.kind === 'edit'}
          addressBase={{ me: dialog.kind === 'edit' ? base(dialog.link.profile, 'your-name') : base(handle || list.handles.me, 'your-name'), team: base(list.handles.workspace, 'team') }}
          members={members}
          canTeam={list.can_manage}
          busy={saving}
          onSave={(draft) => void save(draft)}
        />
      )}
    </section>
  )
}

const lengthOnly = (link: SettingsLink) => linkSummary({ ...link, hosts: [] }, () => '')
