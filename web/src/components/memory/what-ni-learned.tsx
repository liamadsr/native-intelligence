'use client'

/**
 * "What Native Intelligence has learned" (one-agent plan Part 3, "Memory"): the lines of
 * each area's note, yours and the workspace's, to edit, delete or add to, and
 * the proposals waiting on someone, with Accept and Dismiss for whoever may
 * settle them.
 *
 * Learning is on by default (Liam, 2026-10-17): what Native Intelligence noticed about you
 * on its own (`learned`) is live at once, marked "Native Intelligence noticed this", with a
 * one-tap Remove and an Undo in the toast that follows. Undo adds the line
 * back as yours. Workspace lines Native Intelligence learned still wait for an owner or
 * admin, with Accept and Dismiss.
 *
 * One component, two homes: Settings → Memory lists the facts about you
 * (About you, migration 328), what the agents learned at work (AgentsLearned,
 * owners and admins only, and only when there is some) and every area that
 * has lines; an area's page (S3) passes `area` and gets just that area's note.
 * The server decides who may do what (RLS and migration 317's guard); this
 * only shows the buttons that will work (lineActions).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Lightbulb, Pencil, Plus, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { AREA_OPTIONS, PACKS, type AreaKey } from '@/lib/packs/registry'
import {
  MEMORY_LINE_MAX_CHARS,
  memoryTextProblem,
  normalizeMemoryText,
  type MemoryLine,
  type MemoryScope,
} from '@/lib/packs/memory-types'
import { profileFactProblem, type ProfileFact } from '@/lib/memory/profile-facts'
import { outsideReadLabel } from '@/lib/safety/outside-label'
import { relativeTime } from '@/lib/work/presentation'

export interface MemoryViewer {
  userId: string
  canManageWorkspace: boolean
}

export interface LineActions {
  edit: boolean
  delete: boolean
  /** A live line Native Intelligence learned: one tap removes it, with Undo. Shown instead of delete. */
  remove: boolean
  accept: boolean
  dismiss: boolean
  /** A member's own workspace proposal: they may take it back. */
  withdraw: boolean
  /** Shown instead of buttons: it waits on an owner or admin. */
  waitingForAdmin: boolean
}

/**
 * What the viewer may do with a line, as migration 317 allows it. Your own
 * personal lines are yours to change; the workspace's are an owner's or
 * admin's, and a member may only withdraw their own proposal. A live line
 * Native Intelligence learned gets Remove (one tap, with Undo) in place of Delete. Pure.
 */
export function lineActions(line: Pick<MemoryLine, 'scope' | 'status' | 'source' | 'created_by'>, viewer: MemoryViewer): LineActions {
  const none: LineActions = { edit: false, delete: false, remove: false, accept: false, dismiss: false, withdraw: false, waitingForAdmin: false }
  const mayChange = line.scope === 'personal' || viewer.canManageWorkspace
  if (line.status === 'proposed') {
    if (mayChange) return { ...none, accept: true, dismiss: true, edit: true }
    return { ...none, waitingForAdmin: true, withdraw: line.created_by === viewer.userId }
  }
  if (!mayChange) return none
  return line.source === 'learned' ? { ...none, edit: true, remove: true } : { ...none, edit: true, delete: true }
}

/** The editor's sections: each area with lines (or just `only`), yours then the workspace's, oldest first. */
export function groupMemoryLines(lines: readonly MemoryLine[], only?: AreaKey) {
  const areas = only ? [only] : AREA_OPTIONS.map((o) => o.key).filter((key) => lines.some((l) => l.area === key))
  return areas.map((area) => ({
    area,
    name: PACKS[area].name,
    personal: lines.filter((l) => l.area === area && l.scope === 'personal'),
    workspace: lines.filter((l) => l.area === area && l.scope === 'workspace'),
  }))
}

function sourceNote(line: MemoryLine): string | null {
  if (line.source === 'learned') return 'Native Intelligence noticed this'
  return line.status === 'proposed' && line.scope === 'workspace' ? 'Proposed' : null
}

/**
 * The toast after a one-tap remove of something Native Intelligence noticed: Undo adds it
 * back (as the person's own, through the same add their editor uses).
 */
function removedWithUndo(undo: () => Promise<void>) {
  toast.success('Removed', { action: { label: 'Undo', onClick: () => void undo() } })
}

async function send(url: string, init: RequestInit): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return { ok: res.ok, data }
  } catch {
    return { ok: false, data: { error: 'Network error' } }
  }
}

function LineRow({
  line,
  viewer,
  onChanged,
  onRemoved,
  onRestored,
}: {
  line: MemoryLine
  viewer: MemoryViewer
  onChanged: (line: MemoryLine) => void
  onRemoved: (id: string) => void
  onRestored: (line: MemoryLine) => void
}) {
  const actions = lineActions(line, viewer)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(line.text)
  const [busy, setBusy] = useState(false)

  const run = useCallback(
    async (what: 'save' | 'accept' | 'remove') => {
      setBusy(true)
      const url = `/api/account/memory/${encodeURIComponent(line.id)}`
      const res =
        what === 'remove'
          ? await send(url, { method: 'DELETE' })
          : await send(url, { method: 'PATCH', body: JSON.stringify(what === 'accept' ? { status: 'active' } : { text: draft }) })
      setBusy(false)
      if (!res.ok) {
        toast.error(typeof res.data.error === 'string' ? res.data.error : 'Could not save')
        return
      }
      if (what === 'remove') {
        onRemoved(line.id)
        if (actions.remove) {
          removedWithUndo(async () => {
            const back = await send('/api/account/memory', { method: 'POST', body: JSON.stringify({ area: line.area, scope: line.scope, text: line.text }) })
            if (!back.ok) toast.error(typeof back.data.error === 'string' ? back.data.error : 'Could not undo')
            else if (back.data.line) onRestored(back.data.line as MemoryLine)
          })
        }
      } else if (res.data.line) onChanged(res.data.line as MemoryLine)
      setEditing(false)
    },
    [actions.remove, draft, line.area, line.id, line.scope, line.text, onChanged, onRemoved, onRestored],
  )

  if (editing) {
    const problem = memoryTextProblem(normalizeMemoryText(draft))
    return (
      <li className="flex items-center gap-2 py-1.5">
        <Input
          aria-label="Edit line"
          value={draft}
          maxLength={MEMORY_LINE_MAX_CHARS}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !problem) void run('save')
            if (e.key === 'Escape') setEditing(false)
          }}
          autoFocus
        />
        <Button size="sm" disabled={busy || !!problem} onClick={() => void run('save')}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </li>
    )
  }

  const note = sourceNote(line)
  return (
    <li data-testid="memory-line" className="group flex items-start gap-2 py-1.5 text-sm">
      <span className={cn('min-w-0 flex-1 break-words', line.status === 'proposed' && 'text-muted-foreground')}>
        {line.text}
        {note && <span className="ml-2 text-xs text-muted-foreground">· {note}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {actions.accept && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run('accept')}>
            <Check className="mr-1 h-3.5 w-3.5" /> Accept
          </Button>
        )}
        {actions.dismiss && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run('remove')}>
            <X className="mr-1 h-3.5 w-3.5" /> Dismiss
          </Button>
        )}
        {actions.waitingForAdmin && <span className="text-xs text-muted-foreground">Waiting for an admin</span>}
        {actions.withdraw && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run('remove')}>
            Withdraw
          </Button>
        )}
        {actions.edit && (
          <Button size="icon" variant="ghost" aria-label="Edit" className="h-7 w-7" onClick={() => { setDraft(line.text); setEditing(true) }}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        )}
        {actions.delete && (
          <Button size="icon" variant="ghost" aria-label="Delete" className="h-7 w-7" disabled={busy} onClick={() => void run('remove')}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
        {actions.remove && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run('remove')}>
            <X className="mr-1 h-3.5 w-3.5" /> Remove
          </Button>
        )}
      </span>
    </li>
  )
}

function AddLine({
  area,
  viewer,
  onAdded,
}: {
  area?: AreaKey
  viewer: MemoryViewer
  onAdded: (line: MemoryLine) => void
}) {
  const [pickedArea, setPickedArea] = useState<AreaKey>(area ?? 'mail')
  const [scope, setScope] = useState<MemoryScope>('personal')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const normalized = normalizeMemoryText(text)
  const problem = normalized ? memoryTextProblem(normalized) : null
  const proposes = scope === 'workspace' && !viewer.canManageWorkspace

  const add = async () => {
    if (!normalized || problem) return
    setBusy(true)
    const res = await send('/api/account/memory', { method: 'POST', body: JSON.stringify({ area: area ?? pickedArea, scope, text: normalized }) })
    setBusy(false)
    if (!res.ok) {
      toast.error(typeof res.data.error === 'string' ? res.data.error : 'Could not add the line')
      return
    }
    if (res.data.line && !res.data.already) onAdded(res.data.line as MemoryLine)
    setText('')
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      {!area && (
        <select
          aria-label="Area"
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          value={pickedArea}
          onChange={(e) => setPickedArea(e.target.value as AreaKey)}
        >
          {AREA_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.name}
            </option>
          ))}
        </select>
      )}
      <select
        aria-label="Whose"
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        value={scope}
        onChange={(e) => setScope(e.target.value as MemoryScope)}
      >
        <option value="personal">Just me</option>
        <option value="workspace">The workspace</option>
      </select>
      <Input
        aria-label="New line"
        className="min-w-[12rem] flex-1"
        placeholder="Something Native Intelligence should remember"
        value={text}
        maxLength={MEMORY_LINE_MAX_CHARS}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void add()
        }}
      />
      <Button size="sm" disabled={busy || !normalized || !!problem} onClick={() => void add()}>
        <Plus className="mr-1 h-3.5 w-3.5" /> {proposes ? 'Propose' : 'Add'}
      </Button>
      {problem && <p className="w-full text-xs text-destructive">{problem}</p>}
    </div>
  )
}

/**
 * "About you": the facts about the person (migration 328), the same in every
 * workspace. Each is theirs to edit or delete. What Native Intelligence noticed is live,
 * marked, with a one-tap Remove (and Undo); a proposal (a change Native Intelligence
 * couldn't check against their words) waits to be accepted or dismissed.
 * Shown on the Settings home only (not an area's page).
 */
export function AboutYou() {
  const [facts, setFacts] = useState<ProfileFact[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await send('/api/account/memory/profile', { method: 'GET' })
      if (cancelled) return
      if (!res.ok) {
        setFailed(true)
        return
      }
      setFacts(Array.isArray(res.data.facts) ? (res.data.facts as ProfileFact[]) : [])
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const replace = useCallback((fact: ProfileFact) => setFacts((prev) => (prev ?? []).map((f) => (f.id === fact.id ? fact : f))), [])
  const remove = useCallback((id: string) => setFacts((prev) => (prev ?? []).filter((f) => f.id !== id)), [])
  const append = useCallback(
    (fact: ProfileFact) => setFacts((prev) => ((prev ?? []).some((f) => f.id === fact.id) ? (prev ?? []).map((f) => (f.id === fact.id ? fact : f)) : [...(prev ?? []), fact])),
    [],
  )

  return (
    <section className="mb-5" data-testid="about-you">
      <h2 className="mb-1 text-sm font-semibold">About you</h2>
      <p className="mb-1 text-xs text-muted-foreground">How you work. Native Intelligence brings these into every workspace.</p>
      {failed && <p className="text-sm text-muted-foreground">Couldn’t load what Native Intelligence knows about you.</p>}
      {!failed && !facts && <p className="text-sm text-muted-foreground">Loading…</p>}
      {facts && (
        <ul className="divide-y divide-border/50">
          {facts.map((fact) => (
            <FactRow key={fact.id} fact={fact} onChanged={replace} onRemoved={remove} onRestored={append} />
          ))}
        </ul>
      )}
      {facts && <AddFact onAdded={append} />}
    </section>
  )
}

function FactRow({
  fact,
  onChanged,
  onRemoved,
  onRestored,
}: {
  fact: ProfileFact
  onChanged: (f: ProfileFact) => void
  onRemoved: (id: string) => void
  onRestored: (f: ProfileFact) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(fact.text)
  const [busy, setBusy] = useState(false)
  const proposed = fact.status === 'proposed'
  // Live and Native Intelligence's own: a one-tap Remove with Undo instead of Delete.
  const noticed = !proposed && fact.source === 'learned'

  const run = useCallback(
    async (what: 'save' | 'accept' | 'remove') => {
      setBusy(true)
      const url = `/api/account/memory/profile/${encodeURIComponent(fact.id)}`
      const res =
        what === 'remove'
          ? await send(url, { method: 'DELETE' })
          : await send(url, { method: 'PATCH', body: JSON.stringify(what === 'accept' ? { status: 'active' } : { text: draft }) })
      setBusy(false)
      if (!res.ok) {
        toast.error(typeof res.data.error === 'string' ? res.data.error : 'Could not save')
        return
      }
      if (what === 'remove') {
        onRemoved(fact.id)
        if (noticed) {
          removedWithUndo(async () => {
            const back = await send('/api/account/memory/profile', { method: 'POST', body: JSON.stringify({ text: fact.text }) })
            if (!back.ok) toast.error(typeof back.data.error === 'string' ? back.data.error : 'Could not undo')
            else if (back.data.fact) onRestored(back.data.fact as ProfileFact)
          })
        }
      } else if (res.data.fact) onChanged(res.data.fact as ProfileFact)
      setEditing(false)
    },
    [draft, fact.id, fact.text, noticed, onChanged, onRemoved, onRestored],
  )

  if (editing) {
    const problem = profileFactProblem(normalizeMemoryText(draft))
    return (
      <li className="flex items-center gap-2 py-1.5">
        <Input
          aria-label="Edit fact"
          value={draft}
          maxLength={MEMORY_LINE_MAX_CHARS}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !problem) void run('save')
            if (e.key === 'Escape') setEditing(false)
          }}
          autoFocus
        />
        <Button size="sm" disabled={busy || !!problem} onClick={() => void run('save')}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </li>
    )
  }

  return (
    <li data-testid="profile-fact" className="group flex items-start gap-2 py-1.5 text-sm">
      <span className={cn('min-w-0 flex-1 break-words', proposed && 'text-muted-foreground')}>
        {fact.text}
        {fact.source === 'learned' && <span className="ml-2 text-xs text-muted-foreground">· Native Intelligence noticed this</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {proposed && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run('accept')}>
            <Check className="mr-1 h-3.5 w-3.5" /> Accept
          </Button>
        )}
        {proposed && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run('remove')}>
            <X className="mr-1 h-3.5 w-3.5" /> Dismiss
          </Button>
        )}
        <Button size="icon" variant="ghost" aria-label="Edit" className="h-7 w-7" onClick={() => { setDraft(fact.text); setEditing(true) }}>
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        {!proposed && !noticed && (
          <Button size="icon" variant="ghost" aria-label="Delete" className="h-7 w-7" disabled={busy} onClick={() => void run('remove')}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
        {noticed && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run('remove')}>
            <X className="mr-1 h-3.5 w-3.5" /> Remove
          </Button>
        )}
      </span>
    </li>
  )
}

function AddFact({ onAdded }: { onAdded: (fact: ProfileFact) => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const normalized = normalizeMemoryText(text)
  const problem = normalized ? profileFactProblem(normalized) : null

  const add = async () => {
    if (!normalized || problem) return
    setBusy(true)
    const res = await send('/api/account/memory/profile', { method: 'POST', body: JSON.stringify({ text: normalized }) })
    setBusy(false)
    if (!res.ok) {
      toast.error(typeof res.data.error === 'string' ? res.data.error : 'Could not add the fact')
      return
    }
    if (res.data.fact && !res.data.already) onAdded(res.data.fact as ProfileFact)
    setText('')
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Input
        aria-label="New fact about you"
        className="min-w-[12rem] flex-1"
        placeholder="How you like to work, e.g. Keep answers short"
        value={text}
        maxLength={MEMORY_LINE_MAX_CHARS}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void add()
        }}
      />
      <Button size="sm" disabled={busy || !normalized || !!problem} onClick={() => void add()}>
        <Plus className="mr-1 h-3.5 w-3.5" /> Add
      </Button>
      {problem && <p className="w-full text-xs text-destructive">{problem}</p>}
    </div>
  )
}

/** One entry of a teammate's memory, as /api/account/agent-memory returns it. */
export interface AgentMemoryEntry {
  id: string
  teammateId: string
  teammateName: string | null
  text: string
  /** The tools that brought outside text into the run that learned it (empty: none). */
  outsideReads: string[]
  createdAt: string
}

/** When an entry was learned, quietly: "· 2d ago", "· Oct 3". */
function learnedWhen(iso: string | null | undefined): string | null {
  const when = relativeTime(iso ?? null)
  if (!when) return null
  return `· ${/^\d+[mhd]$/.test(when) ? `${when} ago` : when}`
}

function AgentEntryRow({
  entry,
  onRemoved,
  onRestored,
}: {
  entry: AgentMemoryEntry
  onRemoved: (id: string) => void
  onRestored: (entry: AgentMemoryEntry) => void
}) {
  const [busy, setBusy] = useState(false)
  const outside = entry.outsideReads.length > 0 ? outsideReadLabel(entry.outsideReads) : null

  const remove = async () => {
    setBusy(true)
    const res = await send('/api/account/agent-memory', { method: 'PATCH', body: JSON.stringify({ id: entry.id, action: 'remove' }) })
    setBusy(false)
    if (!res.ok) {
      toast.error(typeof res.data.error === 'string' ? res.data.error : 'Could not save')
      return
    }
    onRemoved(entry.id)
    removedWithUndo(async () => {
      const back = await send('/api/account/agent-memory', { method: 'PATCH', body: JSON.stringify({ id: entry.id, action: 'restore' }) })
      if (!back.ok) toast.error(typeof back.data.error === 'string' ? back.data.error : 'Could not undo')
      else onRestored(entry)
    })
  }

  return (
    <li data-testid="agent-memory-entry" className="group flex items-start gap-2 py-1.5 text-sm">
      <span className="min-w-0 flex-1 break-words">
        {entry.teammateName && <span className="text-muted-foreground">{entry.teammateName}: </span>}
        {entry.text}
        <span className="ml-2 text-xs text-muted-foreground">
          {learnedWhen(entry.createdAt)}
          {outside && <span data-testid="agent-memory-outside"> · learned from {outside}</span>}
        </span>
      </span>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove()} className="shrink-0">
        <X className="mr-1 h-3.5 w-3.5" /> Remove
      </Button>
    </li>
  )
}

/**
 * What the agents learned at work (trust layer P2; decision 16 as apply with
 * undo): a teammate's memory across its runs, for owners and admins (it is
 * read by every member's runs). Every entry is live, with who learned it and
 * when, and Remove with Undo; one learned after its run read outside text
 * (the web, a connected app, mail from someone you don't know) says so in a
 * quiet label, so it is easy to spot. Nothing waits to be accepted. Renders
 * nothing when there is nothing to show, or the viewer may not manage it.
 */
export function AgentsLearned() {
  const [entries, setEntries] = useState<AgentMemoryEntry[]>([])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await send('/api/account/agent-memory', { method: 'GET' })
      if (cancelled || !res.ok || res.data.canManage !== true) return
      setEntries(Array.isArray(res.data.entries) ? (res.data.entries as AgentMemoryEntry[]) : [])
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const removed = useCallback((id: string) => setEntries((prev) => prev.filter((e) => e.id !== id)), [])
  const restored = useCallback(
    (entry: AgentMemoryEntry) =>
      setEntries((prev) => (prev.some((e) => e.id === entry.id) ? prev : [entry, ...prev].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))),
    [],
  )

  if (entries.length === 0) return null
  return (
    <section className="mb-5" data-testid="agents-learned">
      <h2 className="mb-1 text-sm font-semibold">Your agents, at work</h2>
      <p className="mb-1 text-xs text-muted-foreground">What they learned on their runs, for the whole workspace. Remove anything that’s wrong.</p>
      <ul className="divide-y divide-border/50">
        {entries.map((entry) => (
          <AgentEntryRow key={entry.id} entry={entry} onRemoved={removed} onRestored={restored} />
        ))}
      </ul>
    </section>
  )
}

export function WhatNiLearned({ area, className }: { area?: AreaKey; className?: string }) {
  const [lines, setLines] = useState<MemoryLine[] | null>(null)
  const [viewer, setViewer] = useState<MemoryViewer | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await send(`/api/account/memory${area ? `?area=${area}` : ''}`, { method: 'GET' })
      if (cancelled) return
      if (!res.ok) {
        setFailed(true)
        return
      }
      setViewer({ userId: String(res.data.userId ?? ''), canManageWorkspace: res.data.canManageWorkspace === true })
      setLines(Array.isArray(res.data.lines) ? (res.data.lines as MemoryLine[]) : [])
    })()
    return () => {
      cancelled = true
    }
  }, [area])

  const sections = useMemo(() => (lines ? groupMemoryLines(lines, area) : []), [lines, area])
  const replace = useCallback((line: MemoryLine) => setLines((prev) => (prev ?? []).map((l) => (l.id === line.id ? line : l))), [])
  const remove = useCallback((id: string) => setLines((prev) => (prev ?? []).filter((l) => l.id !== id)), [])
  // An add that restated a proposal comes back as that line, now accepted: replace it, don't list it twice.
  const append = useCallback(
    (line: MemoryLine) => setLines((prev) => ((prev ?? []).some((l) => l.id === line.id) ? (prev ?? []).map((l) => (l.id === line.id ? line : l)) : [...(prev ?? []), line])),
    [],
  )

  if (failed) return <p className={cn('text-sm text-muted-foreground', className)}>Couldn’t load what Native Intelligence has learned.</p>
  if (!lines || !viewer) return <p className={cn('text-sm text-muted-foreground', className)}>Loading…</p>

  return (
    <div className={className} data-testid="what-ni-learned">
      {!area && <AboutYou />}
      {!area && <AgentsLearned />}
      {sections.length === 0 && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Lightbulb className="h-4 w-4" /> Nothing yet. Tell Native Intelligence a preference in chat, or add one here.
        </p>
      )}
      {sections.map((s) => (
        <section key={s.area} className="mb-5">
          {!area && <h2 className="mb-1 text-sm font-semibold">{s.name}</h2>}
          {(['personal', 'workspace'] as const).map((scope) => {
            const list = s[scope]
            if (list.length === 0) return null
            return (
              <div key={scope} className="mb-2">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {scope === 'personal' ? 'Yours' : 'The workspace’s'}
                </h3>
                <ul className="divide-y divide-border/50">
                  {list.map((line) => (
                    <LineRow key={line.id} line={line} viewer={viewer} onChanged={replace} onRemoved={remove} onRestored={append} />
                  ))}
                </ul>
              </div>
            )
          })}
        </section>
      ))}
      <AddLine area={area} viewer={viewer} onAdded={append} />
    </div>
  )
}
