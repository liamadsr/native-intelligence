'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  MessageSquare,
  Plus,
  Search,
  X,
  MessagesSquare,
  Pencil,
  Send,
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  StatusPill,
  TYPE_FILTERS,
  TYPE_META,
  TYPE_OPTIONS,
  TypeBadge,
  PrivateBadge,
  UpvoteButton,
  VisibilityToggle,
  type FeatureRequest,
  type FeatureRequestStatus,
  type FeedbackType,
  type FeedbackVisibility,
} from './feedback-shared'

interface Comment {
  id: string
  feature_request_id: string
  body: string
  created_at: string
  author: { user_id: string; name: string; is_self: boolean }
}

function getInitials(name: string | null) {
  if (!name) return '?'
  return name
    .split(/[\s._-]+/)
    .map((w) => w[0])
    .filter(Boolean)
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

function formatRelativeTime(dateStr: string) {
  const date = new Date(dateStr)
  const diffMs = Date.now() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m`
  if (diffHours < 24) return `${diffHours}h`
  if (diffDays < 7) return `${diffDays}d`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function FeedbackSettingsView() {
  const [items, setItems] = useState<FeatureRequest[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<FeatureRequestStatus | 'all'>('all')
  const [typeFilter, setTypeFilter] = useState<FeedbackType | 'all'>('all')
  const [sort, setSort] = useState<'votes' | 'newest'>('votes')

  const [selected, setSelected] = useState<FeatureRequest | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const fetchItems = useCallback(async () => {
    setIsLoading(true)
    try {
      const params = new URLSearchParams()
      if (statusFilter !== 'all') params.set('status', statusFilter)
      if (typeFilter !== 'all') params.set('type', typeFilter)
      params.set('sort', sort === 'newest' ? 'newest' : 'votes')
      const res = await fetch(`/api/account/feature-requests?${params}`)
      if (res.ok) {
        const data = await res.json()
        setItems(data.feature_requests ?? [])
      }
    } finally {
      setIsLoading(false)
    }
  }, [statusFilter, typeFilter, sort])

  useEffect(() => {
    fetchItems()
  }, [fetchItems])

  /** Optimistic vote toggle — flips local state (list + open dialog), reconciles on failure. */
  const toggleVote = useCallback(async (item: FeatureRequest) => {
    const next = !item.has_voted
    const patch = (r: FeatureRequest): FeatureRequest =>
      r.id === item.id
        ? { ...r, has_voted: next, vote_count: r.vote_count + (next ? 1 : -1) }
        : r
    setItems((prev) => prev.map(patch))
    setSelected((prev) => (prev && prev.id === item.id ? patch(prev) : prev))
    const res = await fetch(`/api/account/feature-requests/${item.id}/vote`, {
      method: next ? 'POST' : 'DELETE',
    })
    if (!res.ok) {
      const rollback = (r: FeatureRequest): FeatureRequest =>
        r.id === item.id ? { ...r, has_voted: item.has_voted, vote_count: item.vote_count } : r
      setItems((prev) => prev.map(rollback))
      setSelected((prev) => (prev && prev.id === item.id ? rollback(prev) : prev))
      toast.error('Could not save your vote')
    }
  }, [])

  const displayed = useMemo(() => {
    if (!search.trim()) return items
    const q = search.toLowerCase()
    return items.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        (r.description && r.description.toLowerCase().includes(q)),
    )
  }, [items, search])

  const hasActiveFilter = !!search || statusFilter !== 'all' || typeFilter !== 'all'

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 py-8">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold">Feedback</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Share feedback, request features, report bugs, and upvote what matters.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            New
          </Button>
        </div>

        {/* Toolbar */}
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <div className="relative w-56">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search requests…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="flex h-8 items-center rounded-md border border-border bg-muted/50 p-0.5">
            {(['votes', 'newest'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSort(s)}
                className={cn(
                  'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                  sort === s
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {s === 'votes' ? 'Top' : 'Newest'}
              </button>
            ))}
          </div>
        </div>

        {/* Type filter chips */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {TYPE_FILTERS.map((f) => {
            const active = typeFilter === f.value
            const Icon = f.value === 'all' ? null : TYPE_META[f.value].icon
            return (
              <button
                key={f.value}
                onClick={() => setTypeFilter(f.value)}
                className={cn(
                  'flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors',
                  active
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {Icon && <Icon className="h-3 w-3" />}
                {f.label}
              </button>
            )
          })}
        </div>

        {/* List */}
        <div className="mt-5">
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full rounded-md" />
              ))}
            </div>
          ) : displayed.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <MessagesSquare className="h-10 w-10 text-muted-foreground/40" />
              <div>
                <p className="text-sm font-medium">
                  {hasActiveFilter ? 'No matching feedback' : 'No feedback yet'}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {hasActiveFilter
                    ? 'Try a different search or filter.'
                    : 'Be the first to share something.'}
                </p>
              </div>
              {!hasActiveFilter && (
                <Button variant="outline" size="sm" onClick={() => setShowCreate(true)}>
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  New
                </Button>
              )}
            </div>
          ) : (
            <div className="-mx-2">
              {displayed.map((item) => (
                <RequestRow
                  key={item.id}
                  item={item}
                  onOpen={() => setSelected(item)}
                  onVote={() => toggleVote(item)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Detail dialog */}
      <DetailDialog
        item={selected}
        onClose={() => setSelected(null)}
        onVote={toggleVote}
        onUpdated={(patch) => {
          // Merge by id (not full-replace) so an optimistic visibility/edit
          // update — or its rollback — can't clobber a concurrent vote change.
          setItems((prev) => prev.map((r) => (r.id === patch.id ? { ...r, ...patch } : r)))
          setSelected((prev) => (prev && prev.id === patch.id ? { ...prev, ...patch } : prev))
        }}
        onCommentAdded={(id) =>
          setItems((prev) =>
            prev.map((r) => (r.id === id ? { ...r, comment_count: r.comment_count + 1 } : r)),
          )
        }
      />

      {/* Create dialog */}
      <CreateDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={(created) => {
          setItems((prev) => [created, ...prev])
          setShowCreate(false)
          setSelected(created)
        }}
      />
    </div>
  )
}

// ─── Row ─────────────────────────────────────────────────────────────────────

function RequestRow({
  item,
  onOpen,
  onVote,
}: {
  item: FeatureRequest
  onOpen: () => void
  onVote: () => void
}) {
  return (
    <div
      onClick={onOpen}
      className="group flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-xs transition-colors hover:bg-accent/50"
    >
      {/* Zone 1 — endorse */}
      <UpvoteButton voted={item.has_voted} count={item.vote_count} onVote={onVote} size="row" />

      {/* Zone 2 — title (primary) + status, then description */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-foreground">{item.title}</span>
          <StatusPill status={item.status} className="shrink-0" />
          {item.visibility === 'private' && <PrivateBadge className="shrink-0" />}
        </div>
        {item.description && (
          <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{item.description}</p>
        )}
      </div>

      {/* Zone 3 — quiet metadata rail, then the type chip as the terminal far-right element */}
      <div className="flex shrink-0 items-center gap-3">
        <div className="hidden items-center gap-3 text-[10px] text-muted-foreground sm:flex">
          <span className="max-w-[8rem] truncate">{item.author.is_self ? 'You' : item.author.name}</span>
          <span>·</span>
          <span>{formatRelativeTime(item.created_at)}</span>
          <span className="flex w-8 items-center justify-end gap-1 tabular-nums">
            <MessageSquare className="h-3 w-3" />
            {item.comment_count}
          </span>
        </div>
        <TypeBadge type={item.type} className="shrink-0" />
      </div>
    </div>
  )
}

// ─── Detail dialog (description, edit, comments) ─────────────────────────────

function DetailDialog({
  item,
  onClose,
  onVote,
  onUpdated,
  onCommentAdded,
}: {
  item: FeatureRequest | null
  onClose: () => void
  onVote: (item: FeatureRequest) => void
  /** Partial patch merged by id into list + selected; never a full replace. */
  onUpdated: (patch: Partial<FeatureRequest> & { id: string }) => void
  onCommentAdded: (id: string) => void
}) {
  const [comments, setComments] = useState<Comment[]>([])
  const [loadingComments, setLoadingComments] = useState(false)
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)

  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [saving, setSaving] = useState(false)

  const id = item?.id

  useEffect(() => {
    if (!id) return
    setEditing(false)
    setDraft('')
    setLoadingComments(true)
    fetch(`/api/account/feature-requests/${id}/comments`)
      .then((r) => (r.ok ? r.json() : { comments: [] }))
      .then((d) => setComments(d.comments ?? []))
      .finally(() => setLoadingComments(false))
  }, [id])

  async function postComment() {
    if (!item || !draft.trim()) return
    setPosting(true)
    try {
      const res = await fetch(`/api/account/feature-requests/${item.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: draft.trim() }),
      })
      if (res.ok) {
        const { comment } = await res.json()
        setComments((prev) => [...prev, comment])
        setDraft('')
        onCommentAdded(item.id)
      } else {
        const err = await res.json().catch(() => ({ error: 'Failed to comment' }))
        toast.error(err.error || 'Failed to comment')
      }
    } finally {
      setPosting(false)
    }
  }

  function startEdit() {
    if (!item) return
    setEditTitle(item.title)
    setEditDesc(item.description ?? '')
    setEditing(true)
  }

  async function setVisibility(next: FeedbackVisibility) {
    if (!item || next === item.visibility) return
    const prev = item.visibility
    // Optimistic — patch only `visibility` (merged by id), so a rollback can't
    // clobber a concurrent vote/comment change on the same item.
    onUpdated({ id: item.id, visibility: next })
    const res = await fetch('/api/account/feature-requests', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, visibility: next }),
    })
    if (res.ok) {
      const { feature_request } = await res.json()
      // Merge the authoritative row (id + the changed fields), still by id.
      onUpdated({ id: item.id, visibility: feature_request.visibility ?? next, updated_at: feature_request.updated_at })
      toast.success(next === 'private' ? 'Made private' : 'Made public')
    } else {
      onUpdated({ id: item.id, visibility: prev })
      toast.error('Could not change visibility')
    }
  }

  async function saveEdit() {
    if (!item) return
    const title = editTitle.trim()
    if (!title) return
    setSaving(true)
    try {
      const res = await fetch('/api/account/feature-requests', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, title, description: editDesc.trim() || null }),
      })
      if (res.ok) {
        const { feature_request } = await res.json()
        // Patch only the fields the edit can change (merged by id).
        onUpdated({
          id: item.id,
          title: feature_request.title,
          description: feature_request.description,
          updated_at: feature_request.updated_at,
        })
        setEditing(false)
        toast.success('Updated')
      } else {
        const err = await res.json().catch(() => ({ error: 'Failed to update' }))
        toast.error(err.error || 'Failed to update')
      }
    } finally {
      setSaving(false)
    }
  }

  const commentCount = loadingComments ? (item?.comment_count ?? 0) : comments.length

  return (
    <Dialog open={!!item} onOpenChange={(open) => { if (!open) onClose() }}>
      {item && (
        <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
          {/* ── Fixed header band ─────────────────────────────────────────── */}
          <DialogHeader className="shrink-0 space-y-0 border-b px-6 pb-4 pt-6 text-left">
            <div className="flex items-start gap-4">
              {/* Hero endorse — the one place a solid fill is correct */}
              <UpvoteButton voted={item.has_voted} count={item.vote_count} onVote={() => onVote(item)} size="hero" />

              <div className="min-w-0 flex-1">
                {editing ? (
                  <Input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className="text-base font-semibold"
                    autoFocus
                  />
                ) : (
                  <DialogTitle className="text-left text-base font-semibold leading-snug">
                    {item.title}
                  </DialogTitle>
                )}
                {/* Single muted metadata line — status lives HERE as data, it
                    never floats in the corner. */}
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-left text-xs text-muted-foreground">
                  <StatusPill status={item.status} />
                  <TypeBadge type={item.type} />
                  <span>
                    {item.author.is_self ? 'You' : item.author.name} · {formatRelativeTime(item.created_at)}
                  </span>
                </div>
              </div>

              {/* Top-right chrome — pr-6 reserves room for Radix's built-in
                  close X (absolute right-4 top-4). */}
              <div className="flex shrink-0 items-center gap-1 pr-6">
                {item.can_edit ? (
                  <VisibilityToggle visibility={item.visibility} onChange={setVisibility} />
                ) : item.visibility === 'private' ? (
                  <PrivateBadge />
                ) : null}
                {item.can_edit && !editing && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={startEdit}
                    aria-label="Edit"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>
          </DialogHeader>

          {/* ── Fixed description block (also hosts inline edit) ──────────── */}
          <div className="shrink-0 border-b px-6 py-4">
            {editing ? (
              <div className="space-y-3">
                <div>
                  <Label className="text-xs text-muted-foreground">Description</Label>
                  <Textarea
                    value={editDesc}
                    onChange={(e) => setEditDesc(e.target.value)}
                    rows={4}
                    className="mt-1.5"
                    placeholder="Add more detail…"
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={saveEdit} disabled={saving || !editTitle.trim()}>
                    {saving ? 'Saving…' : 'Save'}
                  </Button>
                </div>
              </div>
            ) : item.description ? (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                {item.description}
              </p>
            ) : (
              <p className="text-sm italic text-muted-foreground">No description provided.</p>
            )}
          </div>

          {/* ── Comments — the list is the only scroller ─────────────────── */}
          <div className="flex min-h-0 flex-1 flex-col">
            <h4 className="shrink-0 px-6 pb-2 pt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {commentCount} {commentCount === 1 ? 'comment' : 'comments'}
            </h4>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-4">
              {loadingComments ? (
                <Skeleton className="h-12 w-full rounded-lg" />
              ) : comments.length === 0 ? (
                <p className="text-sm text-muted-foreground">No comments yet — start the conversation.</p>
              ) : (
                comments.map((c) => (
                  <div key={c.id} className="flex gap-2.5">
                    <Avatar className="h-7 w-7 shrink-0">
                      <AvatarFallback className="text-[10px]">{getInitials(c.author.name)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium">
                          {c.author.is_self ? 'You' : c.author.name}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          {formatRelativeTime(c.created_at)}
                        </span>
                      </div>
                      <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground/90">{c.body}</p>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Sticky composer */}
            <div className="sticky bottom-0 flex shrink-0 items-end gap-2.5 border-t bg-background px-6 py-3">
              <Avatar className="h-7 w-7 shrink-0">
                <AvatarFallback className="text-[10px]">
                  {getInitials(item.author.is_self ? item.author.name : 'You')}
                </AvatarFallback>
              </Avatar>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Write a comment…"
                rows={1}
                className="min-h-[36px] flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault()
                    postComment()
                  }
                }}
              />
              <Button
                size="sm"
                onClick={postComment}
                disabled={posting || !draft.trim()}
                className="shrink-0"
              >
                <Send className="mr-1.5 h-3.5 w-3.5" />
                Comment
              </Button>
            </div>
          </div>
        </DialogContent>
      )}
    </Dialog>
  )
}

// ─── Create dialog ───────────────────────────────────────────────────────────

/** Per-type copy for the create form so each kind reads naturally. */
const CREATE_COPY: Record<
  FeedbackType,
  { titlePlaceholder: string; descPlaceholder: string }
> = {
  feedback: {
    titlePlaceholder: 'Short summary of your feedback',
    descPlaceholder: 'What did you like or want changed?',
  },
  feature_request: {
    titlePlaceholder: 'Short, descriptive summary',
    descPlaceholder: 'What problem would this solve? How would it work?',
  },
  bug: {
    titlePlaceholder: 'What went wrong?',
    descPlaceholder: 'Steps to reproduce, what you expected, what happened.',
  },
}

function CreateDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (item: FeatureRequest) => void
}) {
  const [type, setType] = useState<FeedbackType>('feedback')
  const [visibility, setVisibility] = useState<FeedbackVisibility>('public')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) {
      setType('feedback')
      setVisibility('public')
      setTitle('')
      setDescription('')
    }
  }, [open])

  async function submit() {
    const t = title.trim()
    // Enter in the title still works while a post is in flight: no second post.
    if (!t || saving) return
    setSaving(true)
    try {
      const res = await fetch('/api/account/feature-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, visibility, title: t, description: description.trim() || null }),
      })
      if (res.ok) {
        const { feature_request } = await res.json()
        toast.success('Submitted — thank you!')
        onCreated(feature_request)
      } else {
        const err = await res.json().catch(() => ({ error: 'Failed to submit' }))
        toast.error(err.error || 'Failed to submit')
      }
    } finally {
      setSaving(false)
    }
  }

  const copy = CREATE_COPY[type]

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center justify-between gap-4 pr-6">
            <DialogTitle>Share feedback</DialogTitle>
            {/* Public (on/green) by default; flip off to post privately. */}
            <VisibilityToggle visibility={visibility} onChange={setVisibility} />
          </div>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Type selector */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Type</Label>
            <div className="grid grid-cols-3 gap-2">
              {TYPE_OPTIONS.map((opt) => {
                const meta = TYPE_META[opt.value]
                const Icon = meta.icon
                const active = type === opt.value
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setType(opt.value)}
                    className={cn(
                      'flex flex-col items-center gap-1 rounded-md border px-2 py-2.5 text-center transition-colors',
                      active
                        ? cn(meta.border, meta.bg, meta.text)
                        : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground',
                    )}
                    aria-pressed={active}
                  >
                    <Icon className="h-4 w-4" />
                    <span className="text-xs font-medium">{opt.label}</span>
                  </button>
                )
              })}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {TYPE_OPTIONS.find((o) => o.value === type)?.description}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={copy.titlePlaceholder}
              maxLength={200}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && title.trim()) submit()
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={copy.descPlaceholder}
              rows={5}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || !title.trim()}>
            {saving ? 'Submitting…' : 'Submit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
